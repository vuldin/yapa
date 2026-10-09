#!/usr/bin/env bash
# Build the yapa-service image, push it to Artifact Registry and roll it out
# with Terraform, pinned by digest.
#
# Usage (from anywhere):
#   STATE_BUCKET=<bucket> infra/service/deploy.sh            # Cloud Build
#   STATE_BUCKET=<bucket> BUILDER=docker infra/service/deploy.sh
#
# Env:
#   STATE_BUCKET  GCS bucket for Terraform state (required)
#   PROJECT_ID    defaults to project_id in terraform.tfvars
#   REGION        defaults to us-central1
#   BUILDER       cloudbuild (default) | docker (local docker build + push)
#   TAG           image tag, defaults to the short git commit (+ -dirty)
#   AUTO_APPROVE  set to 1 to skip the terraform confirmation prompt
#
# Requires: gcloud (authenticated), terraform >= 1.6, git; docker for BUILDER=docker.
# Terraform reads terraform.tfvars in this directory for everything else.
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
IMAGE="${REPO}/yapa-service"
TF_APPROVE=()
[[ "${AUTO_APPROVE:-0}" == "1" ]] && TF_APPROVE=(-auto-approve)

echo "==> terraform init"
terraform init -input=false -backend-config="bucket=${STATE_BUCKET}" >/dev/null

# First run only: the API and repository must exist before anything can be
# pushed. The image var is required by the config, so pass a placeholder; the
# targeted apply does not touch the Cloud Run service.
if ! gcloud artifacts repositories describe yapa --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> bootstrap: enabling APIs and creating the Artifact Registry repo"
  terraform apply -input=false ${TF_APPROVE[@]+"${TF_APPROVE[@]}"} -var "image=bootstrap" \
    -target=google_project_service.apis -target=google_artifact_registry_repository.yapa
fi

echo "==> build ${IMAGE}:${TAG} with ${BUILDER}"
case "$BUILDER" in
  cloudbuild)
    gcloud builds submit "$REPO_ROOT" --project "$PROJECT_ID" --region "$REGION" \
      --config "$HERE/cloudbuild.yaml" --substitutions "_IMAGE=${IMAGE}:${TAG}"
    ;;
  docker)
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
    docker build --platform linux/amd64 -f "$REPO_ROOT/packages/service/Dockerfile" \
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
echo "==> smoke test ${URL}/healthz (as the gcloud user; needs run.invoker)"
curl -fsS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${URL}/healthz" && echo
