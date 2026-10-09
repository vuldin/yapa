terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }

  # State holds the admin password (random_password and the Secret Manager
  # version), so keep it in a locked-down GCS bucket, never on a laptop.
  # Supply the bucket at init time:
  #   terraform init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=yapa/cloudsql"
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
