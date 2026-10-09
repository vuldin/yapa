output "service_url" {
  description = "Cloud Run URL. Clients set YAPA_SYNC_SERVICE_URL / sync_service_url to this."
  value       = google_cloud_run_v2_service.yapa.uri
}

output "image_repository" {
  description = "Artifact Registry path images are pushed to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.yapa.repository_id}"
}

output "app_audiences" {
  description = "Audiences the app accepts (YAPA_AUDIENCES)."
  value       = local.app_audiences
}

output "custom_audiences" {
  description = "Cloud Run custom audiences (the run.app URL is accepted in addition)."
  value       = google_cloud_run_v2_service.yapa.custom_audiences
}

output "latest_revision" {
  description = "Latest ready revision."
  value       = google_cloud_run_v2_service.yapa.latest_ready_revision
}
