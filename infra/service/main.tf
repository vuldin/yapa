locals {
  services = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ]

  sql = data.terraform_remote_state.cloudsql.outputs

  # Deterministic Cloud Run URL (https://SERVICE-PROJECT_NUMBER.REGION.run.app).
  # Service accounts mint ID tokens with this audience; known before creation,
  # so the app's audience list can include it without a dependency cycle.
  service_url = "https://${var.service_name}-${data.google_project.this.number}.${var.region}.run.app"

  # Audiences the app accepts: the custom audiences (desktop OAuth client),
  # the service URL, and optionally gcloud's client id.
  app_audiences = distinct(concat(
    var.custom_audiences,
    [local.service_url],
    var.accept_gcloud_tokens ? [var.gcloud_client_id] : [],
  ))

  app_env = merge(var.extra_env, {
    YAPA_INSTANCE_CONNECTION_NAME = local.sql.instance_connection_name
    YAPA_DB_USER                  = local.sql.runtime_db_user
    YAPA_DB_NAME                  = var.db_name
    YAPA_AUDIENCES                = join(",", local.app_audiences)
    YAPA_ALLOWED_HD               = var.allowed_hd
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
# Artifact Registry
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "yapa" {
  repository_id = var.repository_id
  location      = var.region
  format        = "DOCKER"
  description   = "YAPA service images"

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.images_to_keep
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days; KEEP above wins for the newest versions
    }
  }

  labels = {
    app = "yapa"
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Cloud Run v2: IAM-protected (no allUsers), Direct VPC egress to Cloud SQL
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "yapa" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  # Equivalent of --no-allow-unauthenticated: the invoker IAM check stays on.
  invoker_iam_disabled = false
  custom_audiences     = var.custom_audiences

  labels = {
    app = "yapa"
  }

  template {
    service_account                  = local.sql.service_account_email
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
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.app_env
        content {
          name  = env.key
          value = env.value
        }
      }

      startup_probe {
        http_get {
          path = var.health_path
          port = var.container_port
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        timeout_seconds       = 2
        failure_threshold     = 20
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

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.invoker_members)
  project  = google_cloud_run_v2_service.yapa.project
  location = google_cloud_run_v2_service.yapa.location
  name     = google_cloud_run_v2_service.yapa.name
  role     = "roles/run.invoker"
  member   = each.value
}
