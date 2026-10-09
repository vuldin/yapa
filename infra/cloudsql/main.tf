locals {
  services = [
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
  ]

  # Postgres role name Cloud SQL creates for an IAM service account user.
  runtime_db_user = trimsuffix(google_service_account.runtime.email, ".gserviceaccount.com")
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Network: VPC + subnet (Cloud Run Direct VPC egress lands here) and Private
# Service Access so the instance gets a private IP only.
# ---------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  name                    = var.network_name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  name                     = "${var.network_name}-${var.region}"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

resource "google_compute_global_address" "psa" {
  name          = "${var.network_name}-psa"
  network       = google_compute_network.vpc.id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.psa_prefix_length
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

# ---------------------------------------------------------------------------
# Cloud SQL instance
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "main" {
  name                = var.instance_name
  region              = var.region
  database_version    = var.database_version
  deletion_protection = true # Terraform-level guard

  settings {
    tier                        = var.tier
    edition                     = "ENTERPRISE" # Enterprise Plus does not offer small tiers
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.disk_size_gb
    disk_autoresize             = true
    disk_autoresize_limit       = var.disk_autoresize_limit_gb
    deletion_protection_enabled = true # API-level guard (blocks console/gcloud deletes too)

    user_labels = {
      app = "yapa"
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      ssl_mode                                      = "ENCRYPTED_ONLY"
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = var.backup_start_time
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = var.pitr_log_retention_days

      backup_retention_settings {
        retained_backups = var.retained_backups
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = var.maintenance_day
      hour         = var.maintenance_hour
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = var.enable_query_insights
      query_string_length     = 1024
      record_application_tags = false
      record_client_address   = false
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }

    database_flags {
      name  = "pgaudit.log"
      value = "write,ddl"
    }
  }

  depends_on = [google_service_networking_connection.psa]
}

resource "google_sql_database" "yapa" {
  name     = "yapa"
  instance = google_sql_database_instance.main.name
}

# ---------------------------------------------------------------------------
# Runtime identity (Cloud Run, josh-311): IAM database auth, no password.
# ---------------------------------------------------------------------------

resource "google_service_account" "runtime" {
  account_id   = var.service_account_id
  display_name = "YAPA sync service runtime"
  description  = "Cloud Run runtime for yapa-service; DML-only database role via IAM auth."
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "runtime_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "runtime_sql_instance_user" {
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_sql_user" "runtime" {
  name     = local.runtime_db_user
  instance = google_sql_database_instance.main.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# ---------------------------------------------------------------------------
# Break-glass admin (built-in user). Runs sql/*.sql, the migration and
# restore checks. Password lives in Secret Manager only.
# ---------------------------------------------------------------------------

resource "random_password" "admin" {
  length  = 32
  special = false
}

locals {
  admin_password = coalesce(var.admin_password, random_password.admin.result)
}

resource "google_sql_user" "admin" {
  name     = var.admin_username
  instance = google_sql_database_instance.main.name
  type     = "BUILT_IN"
  password = local.admin_password
}

resource "google_secret_manager_secret" "admin_password" {
  secret_id = "${var.instance_name}-admin-password"

  replication {
    auto {}
  }

  labels = {
    app = "yapa"
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "admin_password" {
  secret      = google_secret_manager_secret.admin_password.id
  secret_data = local.admin_password
}

# pgaudit entries are delivered as Cloud SQL Data Access audit logs.
resource "google_project_iam_audit_config" "cloudsql" {
  count   = var.enable_data_access_audit_logs ? 1 : 0
  project = var.project_id
  service = "cloudsql.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}
