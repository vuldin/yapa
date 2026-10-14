variable "project_id" {
  description = "Team GCP project (same one as infra/cloudsql and infra/service)."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run. Must match the subnet region in infra/cloudsql."
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
  default     = "yapa-mcp"
}

variable "repository_id" {
  description = "Artifact Registry Docker repository id (created by infra/service; images are pushed there)."
  type        = string
  default     = "yapa"
}

variable "image" {
  description = "Full image reference, pinned by digest: REGION-docker.pkg.dev/PROJECT/yapa/yapa-mcp@sha256:... (deploy.sh passes this)."
  type        = string

  validation {
    condition     = length(var.image) > 0
    error_message = "Set image (deploy.sh passes the pushed digest)."
  }
}

variable "allowed_hd" {
  description = "Google Workspace domain people must belong to (YAPA_ALLOWED_HD, the userinfo/ID token hd)."
  type        = string
}

variable "oauth_client_ids" {
  description = "OAuth client ids whose user tokens are accepted (YAPA_MCP_OAUTH_CLIENT_IDS): the \"YAPA ADP\" web client that ADP's User OAuth provider uses. Empty = static keys only."
  type        = list(string)
  default     = []
}

variable "auto_provision_users" {
  description = "Create a users row on first sign-in for any verified account in allowed_hd (YAPA_AUTO_PROVISION), as yapa-service does."
  type        = bool
  default     = false
}

variable "key_header" {
  description = "Header carrying a static key in addition to Authorization: Bearer (YAPA_MCP_KEY_HEADER). Match the header configured in ADP's Static Key auth."
  type        = string
  default     = "x-yapa-key"
}

variable "tools" {
  description = "Read tools exposed to MCP clients (YAPA_MCP_TOOLS). Default memory_recall only, so ADP users see one obvious tool; [\"all\"] also exposes memory_list, task_list, task_search, collection_list and collection_changes."
  type        = list(string)
  default     = ["memory_recall"]
}

variable "public_url" {
  description = "Public base URL advertised in the protected-resource metadata (YAPA_MCP_PUBLIC_URL). Empty = the deterministic *.run.app URL."
  type        = string
  default     = ""
}

variable "static_keys_secret_id" {
  description = "Secret Manager secret holding the YAPA_MCP_STATIC_KEYS JSON (hashes only). The value is added out of band (README)."
  type        = string
  default     = "yapa-mcp-static-keys"
}

variable "static_keys_version" {
  description = "Secret version the revision reads. \"latest\" is only resolved when a revision starts; set the version number after adding one so the change rolls out a new revision (docs/adp-onboarding.md, rotation)."
  type        = string
  default     = "latest"
}

variable "db_name" {
  description = "Database name (YAPA_DB_NAME)."
  type        = string
  default     = "yapa"
}

variable "min_instances" {
  description = "Minimum instances. 0 = scale to zero (cold start includes loading the embedding model)."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum instances. Also bounds the global rate limit (per-instance limit x max) and DB connections (pool x max)."
  type        = number
  default     = 3
}

variable "concurrency" {
  description = "Max concurrent requests per instance."
  type        = number
  default     = 20
}

variable "cpu" {
  description = "vCPU limit per instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory limit per instance (the ONNX embedding model needs headroom)."
  type        = string
  default     = "1Gi"
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
  description = "Unauthenticated readiness endpoint for the probes; answers 503 until the embedding model is loaded."
  type        = string
  default     = "/health"
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

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

variable "notification_channels" {
  description = "Optional Cloud Monitoring notification channel ids (projects/PROJECT/notificationChannels/ID). Empty = alerts show in the console only."
  type        = list(string)
  default     = []
}

variable "error_rate_threshold" {
  description = "Alert when the 5xx share of requests exceeds this fraction."
  type        = number
  default     = 0.02
}

variable "error_rate_duration" {
  description = "How long the 5xx share must stay above the threshold."
  type        = string
  default     = "600s"
}

variable "auth_failure_threshold" {
  description = "Alert when auth-failure log lines exceed this many per alignment window. The service is open at the platform level, so expect some background noise."
  type        = number
  default     = 50
}

variable "auth_failure_window" {
  description = "Alignment window for the auth-failure alert."
  type        = string
  default     = "300s"
}
