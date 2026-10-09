#!/usr/bin/env bash
# yapa-user.sh: admin helper for the YAPA sync service `users` table.
#
#   scripts/yapa-user.sh [-y] list
#   scripts/yapa-user.sh [-y] disable <username>
#   scripts/yapa-user.sh [-y] enable  <username>
#   scripts/yapa-user.sh [-y] rename-conflict <email> <new-username>
#
# disable / enable flip users.active (the service checks it on every request,
# so the change is immediate). The person's rows stay attributed to their
# username; never reuse a username for someone else.
#
# rename-conflict: the service auto-creates a users row on first sign-in with
# username = email local part (lowercased, other characters -> '-'). When that
# name already belongs to another email, sign-in fails with "not mapped to a
# YAPA user". This inserts a row with an explicit username for that email.
#
# Every change is shown first and needs a "yes" (skip with -y).
#
# --- Connecting (the database has a private IP only) -----------------------
#
# 1. Bastion: set enable_migration_bastion = true in infra/cloudsql and apply
#    (turn it off again afterwards). From infra/cloudsql:
#
#      terraform output bastion            # name + zone
#      terraform output -raw private_ip
#      INSTANCE=$(terraform output -raw instance_connection_name | cut -d: -f3)
#      gcloud sql instances describe "$INSTANCE" \
#        --format='value(serverCaCert.cert)' > server-ca.pem
#
# 2. Terminal 1, tunnel localhost:5433 -> database through IAP:
#
#      gcloud compute ssh <BASTION_NAME> --zone <ZONE> --tunnel-through-iap -- \
#        -N -L 5433:<PRIVATE_IP>:5432
#
# 3. Terminal 2, break-glass admin password from Secret Manager (never echo it):
#
#      export PGPASSWORD=$(gcloud secrets versions access latest \
#        --secret "$(terraform output -raw admin_password_secret)")
#      export SERVER_CA=$PWD/server-ca.pem
#      scripts/yapa-user.sh list
#
# Connection settings: ADMIN_DATABASE_URL (a postgres:// URL; avoid putting
# the password in it, use PGPASSWORD), or the PG* variables. Defaults:
# PGHOST=localhost PGPORT=5433 PGDATABASE=yapa PGUSER=yapa_admin.
# TLS is always sslmode=verify-ca with sslrootcert=$SERVER_CA.
#
# Needs: bash, psql 15+. Role: the built-in admin (member of yapa_owner).

set -euo pipefail

usage() {
  sed -n '4,7p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

die() { echo "error: $*" >&2; exit 1; }

ASSUME_YES=0
while getopts ":yh" opt; do
  case "$opt" in
    y) ASSUME_YES=1 ;;
    h) usage 0 ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || usage
CMD=$1; shift

command -v psql >/dev/null 2>&1 || die "psql not found"
[ -n "${SERVER_CA:-}" ] || die "set SERVER_CA to the instance server CA (server-ca.pem)"
[ -r "$SERVER_CA" ] || die "SERVER_CA is not a readable file"

export PGSSLMODE=verify-ca
export PGSSLROOTCERT=$SERVER_CA
CONN=()
if [ -n "${ADMIN_DATABASE_URL:-}" ]; then
  CONN=("$ADMIN_DATABASE_URL")
else
  export PGHOST=${PGHOST:-localhost} PGPORT=${PGPORT:-5433}
  export PGDATABASE=${PGDATABASE:-yapa} PGUSER=${PGUSER:-yapa_admin}
fi

# psql with no ~/.psqlrc, stop on the first error. SQL comes on stdin so
# psql variables (:'name') are interpolated as quoted literals.
run_psql() { psql -X -q -v ON_ERROR_STOP=1 "$@" ${CONN[@]+"${CONN[@]}"}; }
query() { run_psql -At -F $'\t' "$@"; }

valid_username() { [[ $1 =~ ^[A-Za-z0-9_-]{1,64}$ ]]; }
valid_email() { [[ $1 =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }

# Mirror of the service's usernameFromEmail(), for display only.
derived_username() {
  local local_part
  local_part=$(printf '%s' "${1%%@*}" | tr '[:upper:]' '[:lower:]')
  printf '%s' "$local_part" | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//' | cut -c1-64
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local answer
  read -r -p "Proceed? Type 'yes': " answer
  [ "$answer" = "yes" ] || { echo "Aborted, nothing changed."; exit 1; }
}

show_user() {
  run_psql -P footer=off -v u="$1" <<'SQL'
SELECT username, email, active, created_at, disabled_at FROM users WHERE username = :'u';
SQL
}

user_exists() {
  [ "$(query -v u="$1" <<'SQL'
SELECT count(*) FROM users WHERE username = :'u';
SQL
)" = "1" ]
}

set_active() {
  local username=$1 active=$2
  valid_username "$username" || die "invalid username: must match ^[A-Za-z0-9_-]{1,64}\$"
  user_exists "$username" || die "no users row for '$username' (try: list)"
  echo "Current row:"
  show_user "$username"
  if [ "$active" = "false" ]; then
    echo "Will set active = false, disabled_at = now() for '$username'."
    echo "Their requests are refused immediately; their rows stay attributed to them."
  else
    echo "Will set active = true, disabled_at = NULL for '$username'."
  fi
  confirm
  run_psql -P footer=off -v u="$username" -v a="$active" <<'SQL'
BEGIN;
SET LOCAL ROLE yapa_owner;
UPDATE users
   SET active = :'a'::boolean,
       disabled_at = CASE WHEN :'a'::boolean THEN NULL ELSE now() END
 WHERE username = :'u'
RETURNING username, email, active, disabled_at;
COMMIT;
SQL
}

case "$CMD" in
  list)
    [ $# -eq 0 ] || usage
    run_psql <<'SQL'
SELECT username, email, active, created_at, disabled_at FROM users ORDER BY username;
SQL
    ;;

  disable|enable)
    [ $# -eq 1 ] || usage
    if [ "$CMD" = disable ]; then set_active "$1" false; else set_active "$1" true; fi
    ;;

  rename-conflict)
    [ $# -eq 2 ] || usage
    email=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    username=$2
    valid_email "$email" || die "invalid email"
    valid_username "$username" || die "invalid username: must match ^[A-Za-z0-9_-]{1,64}\$"

    existing=$(query -v e="$email" <<'SQL'
SELECT username FROM users WHERE lower(email) = :'e';
SQL
)
    [ -z "$existing" ] || die "$email already maps to '$existing'; nothing to do"
    if user_exists "$username"; then
      echo "Username '$username' is already taken:"
      show_user "$username"
      die "pick another username"
    fi

    derived=$(derived_username "$email")
    if [ -n "$derived" ] && user_exists "$derived"; then
      echo "Derived username '$derived' is held by:"
      show_user "$derived"
    fi
    echo "Will insert users row: username='$username' email='$email' active=true."
    echo "The person signs in again (no client change needed); task ids and"
    echo "attribution use '$username'."
    confirm
    run_psql -P footer=off -v u="$username" -v e="$email" <<'SQL'
BEGIN;
SET LOCAL ROLE yapa_owner;
INSERT INTO users (username, email) VALUES (:'u', :'e')
RETURNING username, email, active, created_at;
COMMIT;
SQL
    ;;

  *)
    usage
    ;;
esac
