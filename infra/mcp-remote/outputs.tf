output "service_url" {
  description = "Cloud Run URL. Register <service_url>/mcp in ADP (Remote (Proxied), Streamable HTTP)."
  value       = google_cloud_run_v2_service.mcp.uri
}

output "mcp_endpoint" {
  description = "MCP endpoint advertised in the protected-resource metadata."
  value       = "${local.public_url}/mcp"
}

output "static_keys_secret" {
  description = "Secret Manager secret holding YAPA_MCP_STATIC_KEYS (add versions out of band)."
  value       = google_secret_manager_secret.static_keys.secret_id
}

output "latest_revision" {
  description = "Latest ready revision."
  value       = google_cloud_run_v2_service.mcp.latest_ready_revision
}
