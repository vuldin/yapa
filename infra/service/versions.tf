terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
  }

  # Separate state from infra/cloudsql. Supply the bucket at init time:
  #   terraform init -backend-config="bucket=<STATE_BUCKET>"
  backend "gcs" {
    prefix = "yapa/service"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
