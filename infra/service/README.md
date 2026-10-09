# infra/service: Cloud Run for yapa-service (josh-311)

Terraform for the v1 sync API (`docs/service-design.md` sections 2, 3, 9 and
decision 1). Separate root from `infra/cloudsql`; its state lives in the same
bucket under prefix `yapa/service` and it reads the Cloud SQL outputs through
`terraform_remote_state` (prefix `yapa/cloudsql`).

| File | What |
|------|------|
| `main.tf` | APIs, Artifact Registry repo `yapa`, Cloud Run v2 service `yapa-service`, invoker bindings |
| `monitoring.tf` | 5xx-rate alert, auth-failure log metric + alert |
| `variables.tf` / `terraform.tfvars.example` | inputs; copy the example to `terraform.tfvars` (gitignored) |
| `deploy.sh` | build -> push -> `terraform apply` pinned by digest |
| `cloudbuild.yaml` | Cloud Build config used by `deploy.sh` |

## What gets created

- `run.googleapis.com`, `artifactregistry.googleapis.com`,
  `cloudbuild.googleapis.com` (plus monitoring/logging) enabled, never disabled
  on destroy.
- Artifact Registry Docker repo `yapa` (keeps the 10 newest versions, deletes
  others after 30 days).
- Cloud Run v2 service `yapa-service`:
  - runs as the existing `yapa-service@<project>.iam.gserviceaccount.com`
    (created in `infra/cloudsql` with `cloudsql.client` + `instanceUser`);
  - ingress all, IAM invoker check ON (`invoker_iam_disabled = false`), no
    `allUsers` / `allAuthenticatedUsers` (a variable validation rejects them);
  - `roles/run.invoker` for each entry of `invoker_members`;
  - `custom_audiences` from the variable (the `*.run.app` URL is always
    accepted as well);
  - Direct VPC egress into `yapa-vpc` / `yapa-vpc-us-central1`, private
    ranges only (Google APIs and the Cloud SQL Admin API go out directly);
  - 0..3 instances, concurrency 40, 1 vCPU / 512 MiB, CPU only during
    requests, 60 s timeout, startup + liveness probes on `/healthz` port 8080;
  - env: `YAPA_INSTANCE_CONNECTION_NAME`, `YAPA_DB_USER` (IAM db user
    `yapa-service@<project>.iam`), `YAPA_DB_NAME=yapa`, `YAPA_AUDIENCES`
    (comma-separated), `YAPA_ALLOWED_HD`, plus `extra_env`.
- Alerts: 5xx share > 2% for 10 min; auth failures > 20 per 5 min. Add
  `notification_channels` to get paged; otherwise they only show in the
  console. No uptime check: the service is IAM-protected and scales to zero.

`YAPA_AUDIENCES` = `custom_audiences` + the service URL (for service-account
callers; computed from the project number so there is no cycle) + gcloud's
client id when `accept_gcloud_tokens = true`.

### Logging contract (app side)

The auth-failure metric counts Cloud Run log entries where
`jsonPayload.<auth_log_event_field> = "<auth_failure_event_value>"` and labels
them by `jsonPayload.<auth_log_reason_field>`. Defaults expect one JSON line
per rejected request on stdout:

```json
{"severity":"WARNING","event":"auth_failure","reason":"bad_audience","request_id":"..."}
```

Do not log the token or full email in that line. If the app uses other field
names, change the three `auth_log_*` / `auth_failure_*` variables.

## Prerequisites

- `infra/cloudsql` applied (VPC, subnet, Cloud SQL, runtime SA).
- Deployer roles: Cloud Run Admin, Artifact Registry Admin, Service Usage
  Admin, Monitoring Editor, Logging Config Writer, Service Account User on the
  runtime SA, Cloud Build Editor (for `BUILDER=cloudbuild`), and read access
  to the state bucket.
- Cloud Build's build service account (the Compute default SA on newer
  projects) needs `roles/artifactregistry.writer` and `roles/logging.logWriter`.
  If that is awkward, use `BUILDER=docker`.
- `packages/service/Dockerfile` builds from the repo root and the app listens
  on `$PORT` (8080) with an unauthenticated `/healthz`.

## Apply / deploy

```sh
cd infra/service
cp terraform.tfvars.example terraform.tfvars   # project_id, cloudsql_state_bucket, allowed_hd, invoker_members
STATE_BUCKET=<STATE_BUCKET> ./deploy.sh        # or BUILDER=docker ...
```

`deploy.sh` does: `terraform init` (backend bucket from `STATE_BUCKET`) ->
first run only, a targeted apply for the APIs + repo -> image build and push
(`<region>-docker.pkg.dev/<project>/yapa/yapa-service:<git sha>`) -> digest
lookup -> `terraform apply -var image=...@sha256:...` (prompts unless
`AUTO_APPROVE=1`) -> `/healthz` smoke test with your gcloud identity token.

Plan only, without deploying a new image:

```sh
terraform init -backend-config="bucket=<STATE_BUCKET>"
terraform plan -var "image=$(gcloud run services describe yapa-service --region us-central1 --format='value(spec.template.spec.containers[0].image)')"
```

## Cost (monthly, list prices)

| Item | Estimate |
|------|----------|
| Cloud Run, min 0, CPU only during requests, team-scale traffic | $0-5 (mostly free tier) |
| Cloud Run with `min_instances = 1` (idle min instance billed at the lower idle rate) | ~$10-20 |
| Artifact Registry (a few 200 MB images, cleanup policy) | < $1 |
| Cloud Build (120 free build-minutes/day) | ~$0 |
| Logging / Monitoring (alerting on 2 policies, small log volume) | < $5 |

The database dominates (see `infra/cloudsql`). Direct VPC egress has no
connector cost. Trade-off of `min_instances = 0`: a cold start (a few seconds)
on the first request after idle; the hook client's latency budget may want
`min_instances = 1` once the pilot has real users.

## Token spike: which ID token passes Cloud Run IAM and the app

Findings (2026-10-09, gcloud SDK 565):

1. **`gcloud auth print-identity-token` for a user account.** Decoded locally:
   `aud` = `azp` = `32555940559.apps.googleusercontent.com` (gcloud's public
   OAuth client), `iss` = `https://accounts.google.com`, `hd` and
   `email_verified` present. Cloud Run accepts these tokens at the platform
   level without any custom audience: the Cloud Run docs say "You can use
   tokens created by the gcloud CLI to invoke HTTP requests in any project",
   given `run.routes.invoke`, and warn that they "lack an audience claim,
   which makes them susceptible to replay attacks" and are meant for
   development ([Test your private service][dev]). So adding the gcloud client
   id to `custom_audiences` is unnecessary; it only has to be in the app's
   accepted list (`accept_gcloud_tokens`).
2. **Dedicated Desktop OAuth client.** The installed-app flow returns an ID
   token with `aud` = the client id; the audience cannot be set to anything
   else in a user (3-legged) flow. Custom audiences are free-form strings
   ([Set custom audiences][aud]: examples `myservice`,
   `https://myservice.example.com`, JSON list under 32,768 chars), and the docs
   require only that the token's `aud` match a configured audience. The docs
   do not show a user-flow token with a client-id audience; the documented
   verification uses an impersonated service account. This is the one point
   the spike must confirm against a live revision (steps below).
3. **`--audiences` for user accounts.** Does not work. Running it as a user
   fails with `Invalid account type for --audiences. Requires valid service
   account.` The reference only says one audience can be given
   ([print-identity-token][pit]); the docs' examples use
   `--impersonate-service-account`. Impersonating a shared SA would erase the
   per-user identity the app needs, so it is not an option for humans.

**Recommendation for v1.**

- Target path: the YAPA Desktop OAuth client (option 2).
  `custom_audiences = ["<DESKTOP_CLIENT_ID>.apps.googleusercontent.com"]`;
  app `YAPA_AUDIENCES` = that id + the service URL. Tokens minted for YAPA
  are only valid for YAPA, and the `run.invoker` binding + app checks (`hd`,
  group, `users.active`) still apply.
- Pilot fallback, and the plan B if Cloud Run rejects the desktop-client
  token: `accept_gcloud_tokens = true` with `custom_audiences = []`. Works
  today with zero console setup. Trade-off: the audience is shared by every
  gcloud user token, so a token a member hands to any other gcloud-protected
  service (a teammate's Cloud Run dev service, a debugging proxy, a log line)
  can be replayed against YAPA for up to an hour. Invoker membership and the
  app's group/`active` checks still limit who it can be. Turn it off once
  `yapa login` ships.
- Service accounts (CI, admin job): `aud` = service URL via the metadata
  server or `--impersonate-service-account --audiences=<service_url>`; both
  layers already accept it.

### Manual steps for the Desktop OAuth client (console only, no API)

1. Console -> Google Auth Platform (APIs & Services -> OAuth consent screen)
   in the team project. If not configured: **Get started**, app name `YAPA`,
   support email = you, audience **Internal** (Workspace users only, no
   verification), contact email, create.
2. **Data access**: add scopes `openid` and `.../auth/userinfo.email`
   (non-sensitive). Nothing else.
3. **Clients -> Create client**: type **Desktop app**, name `YAPA CLI`,
   create, **Download JSON**. Keep the JSON out of git. Google treats an
   installed app's client secret as non-confidential (it ships in the
   binary), and `yapa login` uses PKCE; the client id is public by design.
4. Put the client id into `custom_audiences` in `terraform.tfvars` and run
   `deploy.sh` (or `terraform apply` with the current image).

### Spike verification (after the first deploy)

```sh
URL=$(terraform output -raw service_url)
# Desktop-client token. This overwrites your ADC file; back it up first.
cp ~/.config/gcloud/application_default_credentials.json /tmp/adc.bak 2>/dev/null || true
gcloud auth application-default login --client-id-file=<downloaded-client.json> \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform
ADC=~/.config/gcloud/application_default_credentials.json
TOKEN=$(curl -fsS https://oauth2.googleapis.com/token \
  -d grant_type=refresh_token -d client_id="$(jq -r .client_id $ADC)" \
  -d client_secret="$(jq -r .client_secret $ADC)" -d refresh_token="$(jq -r .refresh_token $ADC)" \
  | jq -r .id_token)
cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null | jq '{aud,email,hd}'
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$URL/v1/whoami"
mv /tmp/adc.bak ~/.config/gcloud/application_default_credentials.json 2>/dev/null || true
```

(gcloud requires the cloud-platform scope for ADC logins. `/v1/whoami` stands for any authenticated route the app exposes.)
Expected: 200 with the client id in `custom_audiences`, 401 from the Google
front end (not the app) when it is removed. If it is 401 with the id
present, keep the gcloud fallback for v1 and record the result in the design
doc.

[dev]: https://docs.cloud.google.com/run/docs/authenticating/developers
[aud]: https://docs.cloud.google.com/run/docs/configuring/custom-audiences
[pit]: https://docs.cloud.google.com/sdk/gcloud/reference/auth/print-identity-token
