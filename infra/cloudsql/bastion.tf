# Optional migration / restore-drill bastion. The instance has no public IP,
# so a laptop reaches it by SSH port-forwarding through IAP to this VM.
# The VM has no external IP and only accepts SSH from Google's IAP range.

resource "google_compute_firewall" "iap_ssh" {
  count   = var.enable_migration_bastion ? 1 : 0
  name    = "${var.network_name}-allow-iap-ssh"
  network = google_compute_network.vpc.id

  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"] # documented IAP TCP forwarding range
  target_tags   = ["yapa-bastion"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_instance" "bastion" {
  count        = var.enable_migration_bastion ? 1 : 0
  name         = "${var.instance_name}-bastion"
  zone         = var.bastion_zone
  machine_type = "e2-micro"
  tags         = ["yapa-bastion"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    # no access_config: no external IP
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin = "TRUE"
  }
}
