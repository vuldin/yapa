variable "project_id" {
  description = "Team GCP project (same one as infra/cloudsql)."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry. Must match the subnet region in infra/cloudsql."
  type        = string
  default     = "us-central1"
}

variable "cloudsql_state_bucket" {
  description = "GCS bucket holding the infra/cloudsql state (read via terraform_remote_state). Usually the same bucket as this stack's backend."
  type        = string
}

variable "cloudsql_state_prefix" {
  description = "State prefix of the infra/cloudsql stack."
  type        = string
  default     = "yapa/cloudsql"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "yapa-service"
}

variable "repository_id" {
  description = "Artifact Registry Docker repository id."
  type        = string
  default     = "yapa"
}

variable "image" {
  description = "Full image reference, pinned by digest: REGION-docker.pkg.dev/PROJECT/yapa/yapa-service@sha256:... (deploy.sh passes this)."
  type        = string

  validation {
    condition     = length(var.image) > 0
    error_message = "Set image (deploy.sh passes the pushed digest)."
  }
}

variable "invoker_members" {
  description = "Principals granted roles/run.invoker, e.g. [\"user:someone@example.com\"]. Replace with [\"group:yapa-users@example.com\"] once the group exists. Add CI / admin service accounts here too. Never allUsers / allAuthenticatedUsers."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for m in var.invoker_members : !contains(["allUsers", "allAuthenticatedUsers"], m)])
    error_message = "yapa-service is IAM-protected (design decision 1): allUsers and allAuthenticatedUsers are not allowed."
  }

  validation {
    condition     = alltrue([for m in var.invoker_members : can(regex("^(user|group|serviceAccount|domain|principal|principalSet):", m))])
    error_message = "Each member needs an IAM prefix such as user:, group: or serviceAccount:."
  }
}

variable "custom_audiences" {
  description = "Cloud Run custom audiences. Set to the YAPA desktop OAuth client id (\"<id>.apps.googleusercontent.com\") once it exists. The *.run.app URL is always accepted by Cloud Run in addition. See README, 'Token spike'."
  type        = list(string)
  default     = []
}

variable "accept_gcloud_tokens" {
  description = "Also accept user ID tokens minted by `gcloud auth print-identity-token` (aud = gcloud's public OAuth client id) in the app. Cloud Run already accepts these at the platform level; this only widens the app check. Broader: any gcloud-minted token for an allowed user qualifies (README, 'Token spike')."
  type        = bool
  default     = false
}

variable "gcloud_client_id" {
  description = "OAuth client id gcloud uses for user logins (the aud of its user ID tokens). Public value; only used when accept_gcloud_tokens = true."
  type        = string
  default     = "32555940559.apps.googleusercontent.com"
}

variable "allowed_hd" {
  description = "Google Workspace domain the app requires in the token's hd claim (YAPA_ALLOWED_HD)."
  type        = string
}

variable "db_name" {
  description = "Database name (YAPA_DB_NAME)."
  type        = string
  default     = "yapa"
}

variable "min_instances" {
  description = "Minimum instances. 0 = scale to zero (cold start on the first request after idle). The design's steady-state value is 1."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum instances. Also bounds the global rate limit (per-instance limit x max)."
  type        = number
  default     = 3
}

variable "concurrency" {
  description = "Max concurrent requests per instance."
  type        = number
  default     = 40
}

variable "cpu" {
  description = "vCPU limit per instance (>= 1 is required for concurrency > 1)."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per instance."
  type        = string
  default     = "512Mi"
}

variable "request_timeout" {
  description = "Request timeout (Cloud Run duration string)."
  type        = string
  default     = "60s"
}

variable "container_port" {
  description = "Port the app listens on (Cloud Run sets PORT to this)."
  type        = number
  default     = 8080
}

variable "health_path" {
  description = "Unauthenticated health endpoint used by the startup and liveness probes."
  type        = string
  default     = "/healthz"
}

variable "extra_env" {
  description = "Additional non-secret env vars for the app."
  type        = map(string)
  default     = {}
}

variable "deletion_protection" {
  description = "Terraform-level guard against destroying the Cloud Run service."
  type        = bool
  default     = true
}

variable "images_to_keep" {
  description = "Artifact Registry cleanup policy: number of most recent image versions kept."
  type        = number
  default     = 10
}

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

variable "notification_channels" {
  description = "Optional Cloud Monitoring notification channel ids (projects/PROJECT/notificationChannels/ID). Empty = alerts show in the console only."
  type        = list(string)
  default     = []
}

variable "error_rate_threshold" {
  description = "Alert when the 5xx share of requests exceeds this fraction (design section 9: 0.02)."
  type        = number
  default     = 0.02
}

variable "error_rate_duration" {
  description = "How long the 5xx share must stay above the threshold."
  type        = string
  default     = "600s"
}

variable "auth_failure_threshold" {
  description = "Alert when auth-failure log lines exceed this many per alignment window."
  type        = number
  default     = 20
}

variable "auth_failure_window" {
  description = "Alignment window for the auth-failure alert."
  type        = string
  default     = "300s"
}

variable "auth_log_event_field" {
  description = "jsonPayload field in the app's structured logs that names the event (app contract, see README 'Logging contract')."
  type        = string
  default     = "event"
}

variable "auth_failure_event_value" {
  description = "Value of auth_log_event_field on an auth-failure line."
  type        = string
  default     = "auth_failure"
}

variable "auth_log_reason_field" {
  description = "jsonPayload field carrying the failure reason (e.g. expired, bad_audience, not_member); extracted as a metric label."
  type        = string
  default     = "reason"
}
