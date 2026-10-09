output "instance_connection_name" {
  description = "PROJECT:REGION:INSTANCE, for the Cloud SQL Node.js connector (ipType PRIVATE, authType IAM)."
  value       = google_sql_database_instance.main.connection_name
}

output "private_ip" {
  description = "Private IP of the instance (reachable only inside the VPC)."
  value       = google_sql_database_instance.main.private_ip_address
}

output "service_account_email" {
  description = "Runtime service account for Cloud Run (josh-311)."
  value       = google_service_account.runtime.email
}

output "runtime_db_user" {
  description = "Postgres role name of the IAM service account user (pass to sql/ as runtime_user)."
  value       = google_sql_user.runtime.name
}

output "admin_username" {
  description = "Built-in admin login."
  value       = google_sql_user.admin.name
}

output "admin_password_secret" {
  description = "Secret Manager secret holding the admin password (value is not output)."
  value       = google_secret_manager_secret.admin_password.secret_id
}

output "network" {
  description = "VPC and subnet for Cloud Run Direct VPC egress."
  value = {
    network    = google_compute_network.vpc.name
    subnetwork = google_compute_subnetwork.main.name
  }
}

output "bastion" {
  description = "Migration bastion name and zone (null when disabled)."
  value = var.enable_migration_bastion ? {
    name = google_compute_instance.bastion[0].name
    zone = google_compute_instance.bastion[0].zone
  } : null
}
