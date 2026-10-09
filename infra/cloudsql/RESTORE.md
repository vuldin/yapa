# Restore drill: PITR clone (josh-310)

Quarterly (design section 9). Goal: prove a point-in-time clone restores
every row, and record the time it takes. Targets: RPO 5 minutes, RTO 2 hours.
Nothing here touches the production instance except read-only queries.

Placeholders: `<PROJECT_ID>`, `<INSTANCE>` (e.g. `yapa-pg`), `<CLONE>` (e.g.
`yapa-pg-drill-YYYYMMDD`), `<BASTION_NAME>`, `<ZONE>`.

## 0. Prepare

- Bastion on: `enable_migration_bastion = true`, `terraform apply`.
- Server CA, admin password and a tunnel to production, as in README.md
  ("Bootstrap the schema"). The clone uses the same admin login and password
  as its source, but gets its OWN server CA: fetch it with
  `gcloud sql instances describe <CLONE> --format='value(serverCaCert.cert)'`
  and use it for sslrootcert when connecting to the clone.
- Start a log: date, operator, and a stopwatch.

## 1. Baseline on production

```sh
psql "host=localhost port=5433 dbname=yapa user=yapa_admin sslmode=verify-ca sslrootcert=server-ca.pem" \
  -f sql/verify_counts.sql > baseline.txt
```

Note `taken_at` from the first result. That is the restore point `T`
(UTC, RFC 3339, e.g. `2026-01-15T10:00:00Z`; round down to the second).

## 2. Clone to time T

```sh
time gcloud sql instances clone <INSTANCE> <CLONE> \
  --project <PROJECT_ID> --point-in-time '<T>'
# (GA gcloud has no --allocated-ip-range-name; the clone reuses the source's
# private services range. PITR needs a backup older than T: if the instance
# is new, run `gcloud sql backups create --instance <INSTANCE>` first.)
```

The clone keeps the source's settings: private IP only in the same VPC,
TLS only, deletion protection on. It is not in Terraform state; do not
import it.

## 3. Verify

```sh
CLONE_IP=$(gcloud sql instances describe <CLONE> --project <PROJECT_ID> \
  --format='value(ipAddresses[0].ipAddress)')
gcloud compute ssh <BASTION_NAME> --zone <ZONE> --tunnel-through-iap -- -N -L 5434:${CLONE_IP}:5432
# other terminal
psql "host=localhost port=5434 dbname=yapa user=yapa_admin sslmode=verify-ca sslrootcert=server-ca.pem" \
  -f sql/verify_counts.sql > clone.txt
diff <(sed '/taken_at/,/^$/d' baseline.txt) <(sed '/taken_at/,/^$/d' clone.txt)   # drop the taken_at block
```

Expected: identical per-collection and per-`origin_user` counts, total,
`documents_checksum`, `schema_version`, and `users`/`deletions`/`audit_log`
counts. A difference limited to rows whose `synced_at` is within a second of
`T` is a commit that landed on the boundary; re-run step 1 at a quiet moment
if needed.

If production has had no writes since `T` (its `max_synced_at` is still
before `T`), `scripts/migrate-db.mjs --verify-only` with
`SOURCE_DATABASE_URL` = production and `TARGET_DATABASE_URL` = clone also
works and compares sampled embeddings row by row.

Optional (after josh-311): point a staging Cloud Run revision at the clone
and run a pull to confirm the service can read it.

## 4. Delete the clone

```sh
gcloud sql instances patch <CLONE> --project <PROJECT_ID> --no-deletion-protection
gcloud sql instances delete <CLONE> --project <PROJECT_ID>
```

Then turn the bastion off (`enable_migration_bastion = false`, apply) and
remove `baseline.txt`, `clone.txt` and `server-ca.pem` if not needed.

## 5. Record

In the drill log: `T`, clone start/finish, verify finish (time to restore =
clone finish - clone start; RTO includes verify), result of the diff, and
any surprises. File follow-ups as YAPA tasks.

## Real restore (not a drill)

Same clone step to a time just before the incident. Then either point the
service at the clone (update the connection name in the josh-311 service
config and grant the runtime service account an IAM user on the clone:
`gcloud sql users create <SA_EMAIL_WITHOUT_.gserviceaccount.com> --instance <CLONE> --type cloud_iam_service_account`,
then re-run `sql/03_grants.sql` on it), or copy the affected rows back with
`scripts/migrate-db.mjs` pointed from the clone to production. Bring the
clone under Terraform or rename it in the tfvars only after the incident is
closed.

## Drill log

- 2026-10-09: on-demand backup, baseline at 21:08:35Z, PITR clone `yapa-pg-drill` took ~10 min (db-g1-small), verify_counts diff identical (1671 documents, checksum match), clone deleted.
