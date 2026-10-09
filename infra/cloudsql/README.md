# YAPA shared database on Cloud SQL (josh-310)

Terraform for the team's shared YAPA database, following
`docs/service-design.md` sections 2, 6 and 9:

- VPC + subnet, Private Service Access; the instance has **no public IP**
  (`ipv4_enabled = false`) and only accepts TLS (`ssl_mode = ENCRYPTED_ONLY`).
- Postgres 17 (Enterprise edition), SSD with auto-increase, daily backups
  (14 kept) + PITR (7 days of logs), deletion protection at both the
  Terraform and API level, Sunday maintenance window, optional Query Insights.
- Flags: `cloudsql.iam_authentication=on`, `cloudsql.enable_pgaudit=on`,
  `pgaudit.log=write,ddl`.
- Database `yapa`; runtime service account `yapa-service` (for Cloud Run,
  josh-311) with `roles/cloudsql.client` + `roles/cloudsql.instanceUser` and an
  IAM database user; a built-in break-glass admin whose password is generated
  (or passed in) and stored in Secret Manager, never output.
- Optional IAP-only bastion VM for the migration and restore drills (the
  private IP is not reachable from a laptop otherwise).

Files:

| Path | What |
|------|------|
| `*.tf` | infrastructure |
| `sql/00_roles.sql` | extensions, `yapa_owner` NOLOGIN role, database/schema privileges |
| `sql/01_schema_v1.sql` | v1 tables as `schema.ts` creates them |
| `sql/02_schema_v2.sql` | schema v2 (design section 6) |
| `sql/03_grants.sql` | DML-only grants for the runtime IAM user |
| `sql/04_rls.sql` | row-level security; apply with the first josh-311 release |
| `sql/verify_counts.sql` | read-only fingerprint for migration and restore checks |
| `../../scripts/migrate-db.mjs` | copy + verify from the current database |
| `RESTORE.md` | PITR restore drill |

## Prerequisites

- `terraform >= 1.6`, `gcloud`, `psql` (15+), node 18+ with `npm install` run
  at the repo root (for `pg`).
- On the team project: Owner, or Cloud SQL Admin + Compute Network Admin +
  Service Networking Admin + Service Account Admin + Project IAM Admin +
  Secret Manager Admin + Service Usage Admin.
- For the tunnel: `roles/iap.tunnelResourceAccessor` and
  `roles/compute.osAdminLogin`; to read the admin password:
  `roles/secretmanager.secretAccessor` on the secret.
- A GCS bucket for state (state contains the admin password):

  ```sh
  gcloud storage buckets create gs://<STATE_BUCKET> --project <PROJECT_ID> \
    --location us-central1 --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update gs://<STATE_BUCKET> --versioning
  ```

## Apply

```sh
cd infra/cloudsql
cp terraform.tfvars.example terraform.tfvars   # set project_id; enable_migration_bastion = true for now
terraform init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=yapa/cloudsql"
terraform plan -out tfplan
terraform apply tfplan                          # instance creation takes ~10-15 min
terraform output
```

## Bootstrap the schema (once, as the admin)

```sh
INSTANCE=$(terraform output -raw instance_connection_name | cut -d: -f3)
gcloud sql instances describe "$INSTANCE" --format='value(serverCaCert.cert)' > server-ca.pem

# Terminal 1: tunnel localhost:5433 -> private IP through the IAP bastion
gcloud compute ssh <BASTION_NAME> --zone <ZONE> --tunnel-through-iap -- \
  -N -L 5433:$(terraform output -raw private_ip):5432

# Terminal 2
export PGPASSWORD=$(gcloud secrets versions access latest --secret "$(terraform output -raw admin_password_secret)")
ADMIN="host=localhost port=5433 dbname=yapa user=yapa_admin sslmode=verify-ca sslrootcert=server-ca.pem"
psql "$ADMIN" -v ON_ERROR_STOP=1 --single-transaction \
  -v runtime_user="$(terraform output -raw runtime_db_user)" \
  -f sql/00_roles.sql -f sql/01_schema_v1.sql -f sql/02_schema_v2.sql -f sql/03_grants.sql
```

`sslmode=verify-ca` checks the server certificate against the instance CA
but not the hostname (the cert names the instance, and we connect through
localhost). The output of `03_grants.sql` must show `trunc = f` everywhere.

## Migrate the data

See the header of `scripts/migrate-db.mjs`. Run from the repo root with the
tunnel open; the source is the current database (reachable from an
allowlisted IP).

```sh
export SOURCE_DATABASE_URL='postgres://yapa:<SOURCE_PASSWORD>@<SOURCE_HOST>:5432/yapa'
export SOURCE_CA_CERT=<path/to/source-server-ca.pem>
export TARGET_DATABASE_URL="postgres://yapa_admin:${PGPASSWORD}@localhost:5433/yapa"
export TARGET_CA_CERT=infra/cloudsql/server-ca.pem

node scripts/migrate-db.mjs --dry-run --seed-users users.json   # read only: counts, skips, users plan
node scripts/migrate-db.mjs --seed-users users.json             # copy + verify, exit 0 = VERIFY OK
psql "$ADMIN" -f infra/cloudsql/sql/verify_counts.sql           # optional: fingerprint for the record
```

`users.json` (`{"<username>": "<email>"}`) is not committed. Usernames
without an entry are seeded as inactive placeholders
(`<username>@unmapped.invalid`). Re-run the copy after the source is frozen
(design section 9, cutover step 5); it upserts, so a second run only picks up
changes. Rows deleted on the source after an earlier run show up as "extra on
target" and must be removed by hand.

Afterwards set `enable_migration_bastion = false` and apply again.

## How Cloud Run reaches it (josh-311)

Direct VPC egress, no Serverless VPC Access connector:

```sh
gcloud run deploy yapa-service ... \
  --service-account "$(terraform output -raw service_account_email)" \
  --network yapa-vpc --subnet yapa-vpc-us-central1 --vpc-egress private-ranges-only
```

In the service, use the Cloud SQL Node.js connector with
`instanceConnectionName` = output `instance_connection_name`,
`ipType: 'PRIVATE'`, `authType: 'IAM'`, and `user` = output
`runtime_db_user`. No password exists for the runtime; the connector handles
TLS. Set `statement_timeout=5s` in the connection options. Keep
pool size x max instances well below `max_connections` (about 100 on this
tier). Direct VPC egress uses up to two subnet IPs per instance; the default
/24 is plenty for `max-instances=5`.

## Cost (rough, monthly, us-central1 list prices; check the pricing calculator)

| Item | Estimate |
|------|----------|
| Cloud SQL `db-custom-1-3840` (1 vCPU / 3.75 GB, zonal) | ~$50 |
| 10 GB SSD + backups (14 daily) + PITR logs, small data set | ~$3-5 |
| Secret Manager, VPC, Private Service Access | < $1 |
| Bastion `e2-micro` (only while enabled) | ~$7 |
| **Total** | **~$55 (~$62 with the bastion on)** |

`tier = "db-g1-small"` (shared core, no SLA) brings the instance to about
$25-30 and is fine for the pilot. Query Insights is free on Enterprise
edition. pgaudit output goes to Cloud Logging as Data Access audit logs, which
`enable_data_access_audit_logs` (default on) turns on for Cloud SQL; at
`write,ddl` volume it stays in the free allotment. Set it to false if the
project's audit config is managed elsewhere (the resource is authoritative
for `cloudsql.googleapis.com`).

## Design notes

- Backups keep 14 daily copies (design section 9); PITR keeps 7 days of logs.
- `deletion_protection` is on in both places; destroying the instance needs
  a deliberate change to both.
- The runtime gets only what section 6 allows: DML on `documents`,
  append-only `audit_log` and `deletions`, read-only `users`, and
  `idempotency_keys` (select/insert/delete). The admin owns user mapping.
- The design also calls for separate migrator and admin service accounts.
  Until josh-311 adds them, the break-glass admin runs migrations via
  `SET ROLE yapa_owner`.
