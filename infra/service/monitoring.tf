# Alerts from design section 9. Uptime checks are not configured: the service
# is IAM-protected and scales to zero, so a checker would need an invoker
# binding and would keep an instance warm.

locals {
  run_filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.service_name}\""
}

resource "google_monitoring_alert_policy" "error_rate" {
  display_name = "${var.service_name}: 5xx rate > ${var.error_rate_threshold * 100}%"
  combiner     = "OR"

  conditions {
    display_name = "5xx share of requests"
    condition_threshold {
      filter     = "${local.run_filter} AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      comparison = "COMPARISON_GT"
      duration   = var.error_rate_duration

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      denominator_filter = "${local.run_filter} AND metric.type = \"run.googleapis.com/request_count\""

      denominator_aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      threshold_value = var.error_rate_threshold

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "More than ${var.error_rate_threshold * 100}% of ${var.service_name} requests returned 5xx for ${var.error_rate_duration}. Check Cloud Run logs and Cloud SQL health."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.apis]
}

# Counts the app's structured auth-failure lines, e.g.
#   {"severity":"WARNING","event":"auth_failure","reason":"bad_audience",...}
resource "google_logging_metric" "auth_failures" {
  name        = "${var.service_name}/auth_failures"
  description = "Auth failures logged by ${var.service_name} (field names are variables; see README 'Logging contract')."
  filter      = "${local.run_filter} AND jsonPayload.${var.auth_log_event_field} = \"${var.auth_failure_event_value}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "Failure reason reported by the app."
    }
  }

  label_extractors = {
    reason = "EXTRACT(jsonPayload.${var.auth_log_reason_field})"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "auth_failures" {
  display_name = "${var.service_name}: auth failure spike"
  combiner     = "OR"

  conditions {
    display_name = "Auth failures > ${var.auth_failure_threshold} per ${var.auth_failure_window}"
    condition_threshold {
      filter     = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.auth_failures.name}\""
      comparison = "COMPARISON_GT"
      duration   = "0s"

      aggregations {
        alignment_period     = var.auth_failure_window
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      threshold_value = var.auth_failure_threshold

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "Spike in rejected tokens on ${var.service_name}. Group the metric by the reason label; a burst of bad_audience or not_member from one email can mean a misconfigured client or probing."
    mime_type = "text/markdown"
  }
}
