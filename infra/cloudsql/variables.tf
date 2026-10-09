variable "project_id" {
  description = "Team GCP project that hosts the shared YAPA database."
  type        = string
}

variable "region" {
  description = "Region for the instance, subnet and (later) Cloud Run."
  type        = string
  default     = "us-central1"
}

variable "instance_name" {
  description = "Cloud SQL instance name."
  type        = string
  default     = "yapa-pg"
}

variable "database_version" {
  description = "Postgres major version. The design (section 2) targets 17; anything 15+ works with the SQL in sql/."
  type        = string
  default     = "POSTGRES_17"

  validation {
    condition     = contains(["POSTGRES_15", "POSTGRES_16", "POSTGRES_17"], var.database_version)
    error_message = "Use POSTGRES_15, POSTGRES_16 or POSTGRES_17."
  }
}

variable "tier" {
  description = "Machine tier. db-custom-1-3840 = 1 dedicated vCPU / 3.75 GB (has an SLA). db-g1-small is the cheaper shared-core pilot option (no SLA)."
  type        = string
  default     = "db-custom-1-3840"
}

variable "disk_size_gb" {
  description = "Initial SSD size; auto-increase grows it."
  type        = number
  default     = 10
}

variable "disk_autoresize_limit_gb" {
  description = "Upper bound for storage auto-increase (0 = no limit)."
  type        = number
  default     = 100
}

variable "network_name" {
  description = "VPC created for the database and Cloud Run Direct VPC egress."
  type        = string
  default     = "yapa-vpc"
}

variable "subnet_cidr" {
  description = "Subnet for Cloud Run Direct VPC egress and the optional migration bastion. Direct VPC egress needs at least a /26."
  type        = string
  default     = "10.20.0.0/24"
}

variable "psa_prefix_length" {
  description = "Prefix length of the range reserved for Private Service Access (Cloud SQL private IPs)."
  type        = number
  default     = 20
}

variable "backup_start_time" {
  description = "Daily backup start time (UTC, HH:MM)."
  type        = string
  default     = "07:00"
}

variable "retained_backups" {
  description = "Number of daily backups kept (design section 9: 14)."
  type        = number
  default     = 14
}

variable "pitr_log_retention_days" {
  description = "Days of transaction logs kept for point-in-time recovery (design section 9: 7)."
  type        = number
  default     = 7
}

variable "maintenance_day" {
  description = "Maintenance window day, 1 = Monday ... 7 = Sunday."
  type        = number
  default     = 7
}

variable "maintenance_hour" {
  description = "Maintenance window start hour (UTC, 0-23)."
  type        = number
  default     = 8
}

variable "enable_query_insights" {
  description = "Turn on Query Insights (no extra charge on Enterprise edition; query text is not recorded)."
  type        = bool
  default     = false
}

variable "admin_username" {
  description = "Built-in break-glass/admin login. Used only to run sql/*.sql, the migration and restores."
  type        = string
  default     = "yapa_admin"
}

variable "admin_password" {
  description = "Optional admin password. Leave null to generate one; either way it is stored in Secret Manager and never output."
  type        = string
  default     = null
  sensitive   = true
}

variable "service_account_id" {
  description = "Account id of the runtime service account used by Cloud Run (josh-311)."
  type        = string
  default     = "yapa-service"
}

variable "enable_migration_bastion" {
  description = "Create a small VM without a public IP, reachable only through IAP, to tunnel to the private IP during migration and restore drills. Turn off afterwards."
  type        = bool
  default     = false
}

variable "bastion_zone" {
  description = "Zone for the migration bastion."
  type        = string
  default     = "us-central1-a"
}

variable "enable_data_access_audit_logs" {
  description = "Enable Data Access audit logs for Cloud SQL so pgaudit entries reach Cloud Logging. Authoritative for cloudsql.googleapis.com; turn off if the project's audit config is managed elsewhere."
  type        = bool
  default     = true
}
