terraform {
  required_version = ">= 1.6.0"

  required_providers {
    # Same pin as infra/service; invoker_iam_disabled on
    # google_cloud_run_v2_service is supported by this major.
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
  }

  # Separate state from infra/cloudsql and infra/service. Supply the bucket at init time:
  #   terraform init -backend-config="bucket=<STATE_BUCKET>"
  backend "gcs" {
    prefix = "yapa/mcp-remote"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
