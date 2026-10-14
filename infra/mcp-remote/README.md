# infra/mcp-remote: Cloud Run for yapa-mcp (josh-313)

Terraform for the remote MCP service (`packages/mcp-remote`, onboarding in
`docs/adp-onboarding.md`). Separate root; state in the same bucket under
prefix `yapa/mcp-remote`; reads the Cloud SQL outputs through
`terraform_remote_state` (prefix `yapa/cloudsql`), like `infra/service`.

| File | What |
|------|------|
| `main.tf` | APIs, static-keys secret + accessor binding, Cloud Run v2 service `yapa-mcp` |
| `monitoring.tf` | 5xx-rate alert, auth-failure log metric + alert (copied from `infra/service`) |
| `variables.tf` / `terraform.tfvars.example` | inputs; copy the example to `terraform.tfvars` (gitignored) |
| `deploy.sh` | build -> push -> `terraform apply` pinned by digest -> unauthenticated smoke test |
| `cloudbuild.yaml` | Cloud Build config used by `deploy.sh` |

## What gets created

- Cloud Run v2 service `yapa-mcp`:
  - **invoker IAM check disabled** (`invoker_iam_disabled = true`), ingress
    all. ADP's proxy cannot present a Cloud Run ID token, so the app's own
    auth (static keys or Google user tokens, `packages/mcp-remote/src/auth.ts`)
    is the only gate; every path except `/health` and the protected-resource
    metadata needs credentials. No `roles/run.invoker` bindings exist.
  - runs as `yapa-mcp@<project>.iam.gserviceaccount.com`, created in
    `infra/cloudsql` with `cloudsql.client` + `instanceUser` and its own IAM
    database user (read-only role, `sql/05_mcp_runtime.sql`);
  - Direct VPC egress into the `infra/cloudsql` subnet, private ranges only
    (Google's tokeninfo/userinfo and the Cloud SQL Admin API go out directly);
  - 0..3 instances, concurrency 20, 1 vCPU / 1 GiB, CPU only during requests,
    startup CPU boost, 60 s timeout; startup + liveness probes on `/health`,
    which answers 503 until the embedding model (baked into the image) is loaded;
  - env: `YAPA_INSTANCE_CONNECTION_NAME`, `YAPA_DB_USER` (`yapa-mcp@<project>.iam`),
    `YAPA_DB_NAME`, `YAPA_ALLOWED_HD`, `YAPA_AUTO_PROVISION`,
    `YAPA_MCP_OAUTH_CLIENT_IDS`, `YAPA_MCP_KEY_HEADER`, `YAPA_MCP_PUBLIC_URL`
    (the `*.run.app` URL unless `public_url` is set), plus `extra_env`;
    `YAPA_MCP_STATIC_KEYS` from Secret Manager (`static_keys_version`, default `latest`).
- Secret `yapa-mcp-static-keys` with `secretAccessor` for the runtime SA.
  Terraform never holds a version: values (hashes only) are added with
  `gcloud secrets versions add` (see `docs/adp-onboarding.md`). The first
  `deploy.sh` run adds `{}` so the revision can start.
- Alerts: 5xx share > 2% for 10 min; auth failures > 50 per 5 min (higher than
  yapa-service's 20: an open endpoint sees scanner noise).

Images go to the existing Artifact Registry repo `yapa` (owned by
`infra/service`) as `yapa-mcp`.

## Prerequisites

- `infra/cloudsql` applied with the `yapa-mcp` service account and IAM user
  (this change), then `sql/05_mcp_runtime.sql` run as the admin
  (`infra/cloudsql/README.md`, "Remote MCP runtime").
- `infra/service` deployed once (Artifact Registry repo).
- Deployer roles as for `infra/service`, plus Secret Manager Admin.

## Apply / deploy

```sh
cd infra/mcp-remote
cp terraform.tfvars.example terraform.tfvars   # project_id, cloudsql_state_bucket, allowed_hd, oauth_client_ids
STATE_BUCKET=<STATE_BUCKET> ./deploy.sh        # or BUILDER=docker ...
```

`deploy.sh`: `terraform init` -> first run only, targeted apply for the APIs
and secret, plus an empty `{}` secret version -> image build and push
(`<region>-docker.pkg.dev/<project>/yapa/yapa-mcp:<git sha>`) -> digest lookup
-> `terraform apply -var image=...@sha256:...` -> smoke test without
credentials (`/health` 200, metadata 200, `POST /mcp` 401).

Secret changes (new static key, rotation) are read when a revision starts.
Add the version, then set `static_keys_version = "<number>"` in
`terraform.tfvars` and apply with the current image; the changed version
rolls out a new revision (steps in `docs/adp-onboarding.md`).

## Cost

Like `infra/service`: $0-5/month at team scale with `min_instances = 0`
(1 GiB instead of 512 MiB doubles the small memory share); about $15-25 with
`min_instances = 1`, which also removes the model load from cold starts.
