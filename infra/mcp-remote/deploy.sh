#!/usr/bin/env bash
# Build the yapa-mcp image, push it to Artifact Registry and roll it out
# with Terraform, pinned by digest. Modeled on infra/service/deploy.sh.
#
# Usage (from anywhere):
#   STATE_BUCKET=<bucket> infra/mcp-remote/deploy.sh            # Cloud Build
#   STATE_BUCKET=<bucket> BUILDER=docker infra/mcp-remote/deploy.sh
#
# Env:
#   STATE_BUCKET  GCS bucket for Terraform state (required)
#   PROJECT_ID    defaults to project_id in terraform.tfvars
#   REGION        defaults to us-central1
#   BUILDER       cloudbuild (default) | docker (local docker build + push)
#   TAG           image tag, defaults to the short git commit (+ -dirty)
#   AUTO_APPROVE  set to 1 to skip the terraform confirmation prompts
#
# Requires: gcloud (authenticated), terraform >= 1.6, git; docker for BUILDER=docker.
# Prerequisites: infra/cloudsql applied (incl. sql/05_mcp_runtime.sql) and
# infra/service deployed once (it creates the Artifact Registry repo `yapa`).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$HERE"

: "${STATE_BUCKET:?set STATE_BUCKET to the Terraform state bucket}"
REGION="${REGION:-us-central1}"
BUILDER="${BUILDER:-cloudbuild}"

if [[ -z "${PROJECT_ID:-}" ]]; then
  PROJECT_ID="$(sed -n 's/^[[:space:]]*project_id[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' terraform.tfvars 2>/dev/null | head -n1)"
fi
: "${PROJECT_ID:?set PROJECT_ID or project_id in terraform.tfvars}"

if [[ -z "${TAG:-}" ]]; then
  TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  git -C "$REPO_ROOT" diff --quiet HEAD -- || TAG="${TAG}-dirty"
fi

REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/yapa"
IMAGE="${REPO}/yapa-mcp"
TF_APPROVE=()
[[ "${AUTO_APPROVE:-0}" == "1" ]] && TF_APPROVE=(-auto-approve)

if ! gcloud artifacts repositories describe yapa --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Artifact Registry repo 'yapa' not found: deploy infra/service first (it owns the repo)." >&2
  exit 1
fi

echo "==> terraform init"
terraform init -input=false -backend-config="bucket=${STATE_BUCKET}" >/dev/null

# The secret must exist and have a version before a revision can reference
# `latest`. First run only: create it, then add an empty key set ({} =
# no static keys; OAuth only) that `docs/adp-onboarding.md` replaces later.
SECRET="$(sed -n 's/^[[:space:]]*static_keys_secret_id[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' terraform.tfvars 2>/dev/null | head -n1)"
SECRET="${SECRET:-yapa-mcp-static-keys}"
if ! gcloud secrets versions describe latest --secret "$SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> bootstrap: APIs, static-keys secret and its accessor binding"
  terraform apply -input=false ${TF_APPROVE[@]+"${TF_APPROVE[@]}"} -var "image=bootstrap" \
    -target=google_project_service.apis -target=google_secret_manager_secret_iam_member.static_keys_accessor
  printf '{}' | gcloud secrets versions add "$SECRET" --project "$PROJECT_ID" --data-file=-
fi

echo "==> build ${IMAGE}:${TAG} with ${BUILDER}"
case "$BUILDER" in
  cloudbuild)
    gcloud builds submit "$REPO_ROOT" --project "$PROJECT_ID" --region "$REGION" \
      --config "$HERE/cloudbuild.yaml" --substitutions "_IMAGE=${IMAGE}:${TAG}"
    ;;
  docker)
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
    docker build --platform linux/amd64 -f "$REPO_ROOT/packages/mcp-remote/Dockerfile" \
      -t "${IMAGE}:${TAG}" "$REPO_ROOT"
    docker push "${IMAGE}:${TAG}"
    ;;
  *)
    echo "BUILDER must be cloudbuild or docker" >&2
    exit 1
    ;;
esac

DIGEST="$(gcloud artifacts docker images describe "${IMAGE}:${TAG}" --project "$PROJECT_ID" \
  --format='value(image_summary.digest)')"
[[ "$DIGEST" == sha256:* ]] || { echo "could not resolve digest for ${IMAGE}:${TAG}" >&2; exit 1; }

echo "==> terraform apply image=${IMAGE}@${DIGEST}"
terraform apply -input=false ${TF_APPROVE[@]+"${TF_APPROVE[@]}"} -var "image=${IMAGE}@${DIGEST}"

URL="$(terraform output -raw service_url)"
echo "==> smoke test ${URL} (no credentials: /health 200, /mcp 401 with WWW-Authenticate)"
curl -fsS "${URL}/health" && echo
curl -fsS "${URL}/.well-known/oauth-protected-resource" && echo
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${URL}/mcp")"
[[ "$code" == "401" ]] || { echo "expected 401 from unauthenticated POST /mcp, got ${code}" >&2; exit 1; }
echo "ok"
