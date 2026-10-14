locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ]

  sql = data.terraform_remote_state.cloudsql.outputs

  # Deterministic Cloud Run URL (https://SERVICE-PROJECT_NUMBER.REGION.run.app),
  # known before creation, so the app can advertise it in its metadata.
  service_url = "https://${var.service_name}-${data.google_project.this.number}.${var.region}.run.app"
  public_url  = var.public_url != "" ? trimsuffix(var.public_url, "/") : local.service_url

  app_env = merge(var.extra_env, {
    YAPA_INSTANCE_CONNECTION_NAME = local.sql.instance_connection_name
    YAPA_DB_USER                  = local.sql.mcp_runtime_db_user
    YAPA_DB_NAME                  = var.db_name
    YAPA_ALLOWED_HD               = var.allowed_hd
    YAPA_AUTO_PROVISION           = tostring(var.auto_provision_users)
    YAPA_MCP_OAUTH_CLIENT_IDS     = join(",", var.oauth_client_ids)
    YAPA_MCP_KEY_HEADER           = var.key_header
    YAPA_MCP_TOOLS                = join(",", var.tools)
    YAPA_MCP_PUBLIC_URL           = local.public_url
  })
}

data "google_project" "this" {
  project_id = var.project_id
}

data "terraform_remote_state" "cloudsql" {
  backend = "gcs"
  config = {
    bucket = var.cloudsql_state_bucket
    prefix = var.cloudsql_state_prefix
  }
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Static keys (YAPA_MCP_STATIC_KEYS): JSON of kid -> {principal, sha256}. Only
# the secret and its accessor binding live here; versions are added out of
# band (README), so no key material or hash ever enters Terraform state.
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "static_keys" {
  secret_id = var.static_keys_secret_id

  replication {
    auto {}
  }

  labels = {
    app = "yapa"
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "static_keys_accessor" {
  secret_id = google_secret_manager_secret.static_keys.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.sql.mcp_service_account_email}"
}

# ---------------------------------------------------------------------------
# Cloud Run v2: open at the platform level (ADP cannot present a Cloud Run
# ID token); the app authenticates every request itself (static keys or
# Google user tokens). Direct VPC egress to Cloud SQL's private IP.
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "mcp" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  # Equivalent of --no-invoker-iam-check: no roles/run.invoker binding needed,
  # and none is created. App auth is the only gate (docs/service-design.md, decision 1).
  invoker_iam_disabled = true

  labels = {
    app = "yapa"
  }

  template {
    service_account                  = local.sql.mcp_service_account_email
    timeout                          = var.request_timeout
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = local.sql.network.network
        subnetwork = local.sql.network.subnetwork
      }
    }

    containers {
      image = var.image

      ports {
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true # CPU billed only while serving requests
        startup_cpu_boost = true # model load on cold start
      }

      dynamic "env" {
        for_each = local.app_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "YAPA_MCP_STATIC_KEYS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.static_keys.secret_id
            version = var.static_keys_version
          }
        }
      }

      # /health answers 503 until the embedding model is loaded.
      startup_probe {
        http_get {
          path = var.health_path
          port = var.container_port
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        timeout_seconds       = 2
        failure_threshold     = 40
      }

      liveness_probe {
        http_get {
          path = var.health_path
          port = var.container_port
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_project_service.apis, google_secret_manager_secret_iam_member.static_keys_accessor]
}
