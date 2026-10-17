#!/usr/bin/env bash
# Stand up an ISOLATED local Supabase stack for meal-companion integration tests.
#
# Why this exists: this machine runs more than one project's local Supabase stack at once, and
# `supabase start` ports collide across projects unless each one is pinned to its own range. A
# script that trusts a hardcoded port without checking what is actually listening there can
# migrate, reset or seed the wrong project's database. Ports have moved before — confirm the
# real layout with `docker ps --format '{{.Names}}\t{{.Ports}}'` before trusting any port number
# in this comment, this one included. As of the last check:
#
#   meal-companion's own (non-test) local dev stack: API 54321, DB 54322, shadow DB 54320
#   posture-ai's local stack:                        API 55321, DB 55322
#
# So this isolated TEST stack — separate from meal-companion's own dev stack above — uses a
# third range nothing else on this machine is using:
#
#   API 56321   DB 56322   shadow DB 56320   project_id "mc-care-test"
#
# HARD SAFETY RULE: this script must never touch 54321/54322/54320 (meal-companion's own dev
# stack) or 55321/55322 (posture-ai). If you are editing this file to "fix" a port collision,
# move mc-care-test's own ports, not the other project's — and re-run `docker ps` first; don't
# assume the layout above is still current.
#
# Because port numbers alone have proven not to be enough — a stale assumption here is exactly
# how the wrong database gets touched — every run also checks the real `docker ps` container
# names (and, since not everything bound to a port is a Docker container, the OS-level socket
# too) before doing anything, and checks them again, plus the schema itself, before writing:
#
#   1. Port-conflict check (pre-start, gates `supabase start` itself): refuses to start if
#      56321/56322/56320 are already bound to a container belonging to a different project_id —
#      OR to anything else listening there that `docker ps` doesn't explain at all (`lsof`; a
#      plain process with no container wouldn't show up in `docker ps` output, so that alone is
#      not a complete check). See `assert_no_port_conflict`.
#   2. Scratch-config check (pre-start, gates `supabase start` itself): refuses to start unless
#      the scratch config.toml we are about to hand `supabase start` actually says
#      `project_id = "mc-care-test"`. Docker Compose keys containers off that project_id, so if
#      this patch step ever silently failed and left some OTHER project's id in place,
#      `supabase start` would attach to THAT project's already-running containers instead of
#      creating fresh ones — this is the one check that has to run before `supabase start`,
#      not after, because that failure mode is exactly "the write already happened under the
#      wrong name". See `assert_scratch_project_id`.
#   3. Container-identity check (post-start, gates the migration/reset call): refuses to migrate
#      unless the DB container running is exactly `supabase_db_mc-care-test` (see
#      `assert_db_container_identity`). This has to run after `supabase start`, since the
#      container doesn't exist to inspect before that; checks 1 and 2 are what protect the
#      `supabase start` call itself.
#   4. Schema-identity check (post-migration, gates the seed step): refuses to seed unless
#      `public.log_entries` — a real, meal-companion-specific table — exists on that database
#      (see `verify_table_identity`).
#   Every check prints the container name, project_id and host:port it resolved, in normal
#   output, right before anything gets written. Each one is a hard gate on the write that
#   follows it — `if ! check; then exit 1; fi` immediately before that write, not a check that
#   merely logs a result afterward.
#
# TEST_STACK_DOCKER_PS_OUTPUT / TEST_STACK_PORT_LISTENING_OVERRIDE: fixture overrides read ONLY
# under `--dry-run` (see tests/scripts/test-stack-dry-run.test.ts) — a real `start` or `stop`
# always calls real `docker ps` / `lsof`, so a leftover env var can never bypass these checks on
# an actual run.
#
# Usage:
#   scripts/test-stack.sh [start]     start (or reuse) the isolated stack, migrate it, write env
#   scripts/test-stack.sh stop        tear down only this stack (never posture-ai's or the dev one)
#   scripts/test-stack.sh --dry-run   run the port/container conflict checks only — no docker
#                                     container is started and no file is written. Exits non-zero
#                                     the moment a real conflict is found. This is what
#                                     tests/scripts/test-stack-dry-run.test.ts drives.
#
# What `start` does beyond the checks above:
#   1. Copies supabase/ into a scratch workdir (.supabase-test/, git-ignored) and patches the
#      copy's config.toml: project_id, the three ports above, and disables every service this
#      test stack has no use for (studio, mailpit/local_smtp, logflare/analytics, edge-runtime,
#      the supavisor pooler, realtime). imgproxy and postgres-meta have no `enabled` key in this
#      CLI's config.toml schema, so they are excluded instead via `supabase start --exclude`.
#   2. Starts the stack with `supabase start --workdir .supabase-test` (the project root: the CLI
#      reads .supabase-test/supabase/config.toml; a workdir of the supabase/ folder itself makes
#      it fall back to defaults, project "supabase" on 54322). On a brand-new
#      project_id with fresh Docker volumes, the CLI applies every migration under
#      supabase/migrations itself as part of bringing the database up; the explicit migration
#      step below is what makes re-running this script pick up migrations added since.
#   4. Explicitly (re)applies supabase/migrations/*, then applies
#      supabase/seed/test_helpers.sql if it exists (skips with a note if it does not).
#   5. Writes .supabase-test/.env (mode 600) with SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY /
#      SUPABASE_TEST_SERVICE_ROLE_KEY / SUPABASE_TEST_DB_URL — the same names
#      scripts/db-branch.sh prints for the remote preview-branch flow, so `source` it and the
#      existing suites (tests/helpers/supabase.ts, LOCAL-gated specs) just work:
#
#        source .supabase-test/.env && pnpm test:integration
#
# Requires: supabase CLI (logged-in not required — this is all local), docker, jq, psql, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT/.supabase-test"
WORKDIR_SUPABASE="$STACK_DIR/supabase"
ENV_FILE="$STACK_DIR/.env"
PROJECT_ID="mc-care-test"
API_PORT=56321
DB_PORT=56322
SHADOW_PORT=56320
IDENTITY_TABLE="log_entries"

# Known-occupied ranges on this machine as of the last `docker ps` check (see header comment).
# This is a belt-and-suspenders static list; assert_no_port_conflict()'s live docker-ps check is
# the real guard and catches anything this list is stale about.
FORBIDDEN_PORTS=(54320 54321 54322 55321 55322)

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 3; }; }

# Set by main() before any check runs. Fixture env vars (TEST_STACK_DOCKER_PS_OUTPUT,
# TEST_STACK_PORT_LISTENING_OVERRIDE) are honored ONLY while this is 1 — a real `start` or
# `stop` always calls real `docker ps` / `lsof`, so an env var left over from a test run (or
# inherited from a parent shell) can never silently bypass these checks on an actual run.
DRY_RUN=0

assert_safe_ports() {
  for p in "$API_PORT" "$DB_PORT" "$SHADOW_PORT"; do
    for bad in "${FORBIDDEN_PORTS[@]}"; do
      if [ "$p" = "$bad" ]; then
        echo "refusing to run: port $p collides with a known other project's port" >&2
        exit 3
      fi
    done
  done
}

# Real `docker ps` output, unless running under --dry-run AND a test has injected a fixture via
# TEST_STACK_DOCKER_PS_OUTPUT — this is the ONLY place that env var is read, it exists purely so
# tests/scripts/test-stack-dry-run.test.ts can prove the conflict/identity checks refuse a
# different project's container without needing a real one running, and it has no effect at all
# outside --dry-run (see DRY_RUN above).
docker_ps_text() {
  if [ "$DRY_RUN" = "1" ] && [ -n "${TEST_STACK_DOCKER_PS_OUTPUT:-}" ]; then
    printf '%s' "$TEST_STACK_DOCKER_PS_OUTPUT"
  else
    docker ps --format '{{.Names}}\t{{.Ports}}'
  fi
}

docker_ps_names() {
  if [ "$DRY_RUN" = "1" ] && [ -n "${TEST_STACK_DOCKER_PS_OUTPUT:-}" ]; then
    printf '%s' "$TEST_STACK_DOCKER_PS_OUTPUT" | cut -f1
  else
    docker ps --format '{{.Names}}'
  fi
}

# Given `docker ps --format '{{.Names}}\t{{.Ports}}'` text and a host port, echoes the name of
# the container bound to it (first match), or nothing if no container is.
container_owner_for_port() {
  local ps_text="$1" port="$2"
  printf '%s\n' "$ps_text" | awk -F'\t' -v p=":${port}->" '$2 ~ p { print $1; exit }'
}

# `supabase start` names containers `supabase_<service>_<project_id>` (confirmed against this
# machine's own `docker ps`, e.g. `supabase_db_posture-ai`, `supabase_pg_meta_meal-companion`).
# Project ids on this machine never contain an underscore, so the last underscore-delimited
# field is always the project id, however many underscores the service name itself has.
project_id_of_container() {
  local name="$1"
  if [[ "$name" =~ ^supabase_.*_([^_]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo ""
  fi
}

# Is anything at all listening on this host port, Docker or not? `docker ps` only explains ports
# Docker itself published; a plain process bound to the same port (another local tool, a stray
# `supabase start` from a differently-configured workdir, etc.) never shows up there, and relying
# on `docker ps` alone would wrongly call that port free. Overridable under --dry-run only, via
# a comma-separated TEST_STACK_PORT_LISTENING_OVERRIDE list of "listening" ports.
port_is_listening() {
  local port="$1"
  if [ "$DRY_RUN" = "1" ] && [ -n "${TEST_STACK_PORT_LISTENING_OVERRIDE:-}" ]; then
    case ",${TEST_STACK_PORT_LISTENING_OVERRIDE}," in
      *",${port},"*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

# Pre-start safety gate — this is what protects the `supabase start` call itself, before it ever
# runs: refuses to start anything if one of our three ports is already bound to a container
# belonging to a DIFFERENT project (via `docker ps`), OR to anything else listening there that
# isn't a container at all (via `lsof`, see `port_is_listening`). A container already bound
# under mc-care-test itself is fine — that is just this script reusing a stack it started before.
assert_no_port_conflict() {
  local ps_text owner owner_project
  ps_text="$(docker_ps_text)"
  for port in "$API_PORT" "$DB_PORT" "$SHADOW_PORT"; do
    owner="$(container_owner_for_port "$ps_text" "$port")"
    if [ -n "$owner" ]; then
      owner_project="$(project_id_of_container "$owner")"
      if [ "$owner_project" != "$PROJECT_ID" ]; then
        echo "refusing to start: port ${port} is already held by container '${owner}'" \
          "(project_id '${owner_project:-unknown}'), not ${PROJECT_ID}." >&2
        echo "not starting mc-care-test — stop that container or pick different ports." >&2
        return 1
      fi
      continue
    fi
    # docker ps saw nothing on this port — but something non-Docker still might be listening.
    if port_is_listening "$port"; then
      echo "refusing to start: something is listening on 127.0.0.1:${port} that docker ps" \
        "doesn't explain (not a container at all, or one docker ps didn't report)." >&2
      echo "not starting mc-care-test — free that port first." >&2
      return 1
    fi
  done
}

# Gates `supabase start` itself (step 2 of the header's safety list): Docker Compose keys
# containers off config.toml's project_id, so if the patch in write_scratch_config ever silently
# failed to take, `supabase start --workdir $STACK_DIR` would attach to whatever project
# that stale project_id names — possibly an already-running OTHER project's containers — instead
# of creating fresh mc-care-test ones. This has to run, and pass, before `supabase start`;
# checking the resulting container's name afterward (assert_db_container_identity) is too late to
# stop that call, only to stop what comes after it.
assert_scratch_project_id() {
  local expected="project_id = \"${PROJECT_ID}\""
  if ! grep -qxF "$expected" "$WORKDIR_SUPABASE/config.toml"; then
    echo "refusing to start: ${WORKDIR_SUPABASE}/config.toml does not set ${expected}" \
      "— the config patch step did not take, and starting anyway could attach to some other" \
      "project's already-running containers." >&2
    return 1
  fi
}

# Post-start identity gate — gates the migration/reset call: the DB container we are about to
# migrate must be exactly `supabase_db_mc-care-test`, not merely "something answering on port
# $DB_PORT". This can only run after `supabase start` creates the container (nothing to inspect
# before that); assert_no_port_conflict and assert_scratch_project_id are what protect the
# `supabase start` call itself.
assert_db_container_identity() {
  local expected="supabase_db_${PROJECT_ID}" names
  names="$(docker_ps_names)"
  if ! grep -qx "$expected" <<<"$names"; then
    echo "refusing to migrate: expected container '${expected}' to be running, but it is not" \
      "among: $(printf '%s' "$names" | tr '\n' ',')" >&2
    return 1
  fi
  echo "identity: container=${expected} project_id=${PROJECT_ID} host=127.0.0.1:${DB_PORT}"
}

db_url() { echo "postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres"; }

# Post-migration schema gate — gates the seed step: a missing core table here means wrong
# project, wrong port, or migrations never actually ran — any of which is reason enough to stop
# before seeding.
verify_table_identity() {
  local found
  found="$(PGPASSWORD=postgres psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -At \
    -c "select to_regclass('public.${IDENTITY_TABLE}') is not null;" 2>&1)" || {
    echo "DB identity check failed: could not query 127.0.0.1:${DB_PORT} — ${found}" >&2
    return 1
  }
  if [ "$found" != "t" ]; then
    echo "DB identity check failed: public.${IDENTITY_TABLE} not found on 127.0.0.1:${DB_PORT}." >&2
    echo "This does not look like the mc-care-test database — refusing to seed." >&2
    return 1
  fi
  echo "identity: public.${IDENTITY_TABLE} exists on 127.0.0.1:${DB_PORT} (${PROJECT_ID})."
}

# Builds the scratch config.toml from the repo's real supabase/config.toml: swap in this
# project's isolated identity/ports, and disable every service this test stack doesn't need,
# using the `enabled` keys this CLI version's config.toml schema actually has.
write_scratch_config() {
  python3 - "$ROOT/supabase/config.toml" "$WORKDIR_SUPABASE/config.toml" \
    "$PROJECT_ID" "$API_PORT" "$DB_PORT" "$SHADOW_PORT" <<'PYEOF'
import re
import sys

src, dst, project_id, api_port, db_port, shadow_port = sys.argv[1:7]
text = open(src, encoding="utf-8").read()

text = re.sub(r'(?m)^project_id = ".*"$', f'project_id = "{project_id}"', text, count=1)
text = re.sub(r"(?m)^port = 54321$", f"port = {api_port}", text, count=1)
text = re.sub(r"(?m)^port = 54322$", f"port = {db_port}", text, count=1)
text = re.sub(r"(?m)^shadow_port = 54320$", f"shadow_port = {shadow_port}", text, count=1)

# Sections this repo's config.toml is silent on fall back to the CLI's own built-in defaults,
# which for all four of these is `enabled = true` — so the test stack has to say so explicitly,
# not rely on an absent section meaning "off".
extra_disabled_sections = """
# --- test-stack.sh: services this isolated stack never needs (appended, not in the repo's own
# supabase/config.toml, since an absent section here would fall back to the CLI's enabled-by-
# default behavior) ---
[local_smtp]
enabled = false

[analytics]
enabled = false

[edge_runtime]
enabled = false

[db.pooler]
enabled = false
"""
text = text.rstrip("\n") + "\n" + extra_disabled_sections

open(dst, "w", encoding="utf-8").write(text)
PYEOF
}

prepare_scratch() {
  mkdir -p "$STACK_DIR"
  mkdir -p "$WORKDIR_SUPABASE"
  # Migrations and seed are reused as-is; only config.toml is rewritten per run so it always
  # reflects the repo's current service list (studio/realtime off, etc.) plus our overrides.
  rsync -a --delete "$ROOT/supabase/migrations" "$WORKDIR_SUPABASE/"
  rsync -a --delete "$ROOT/supabase/seed" "$WORKDIR_SUPABASE/"
  if [ -d "$ROOT/supabase/rollback" ]; then
    rsync -a --delete "$ROOT/supabase/rollback" "$WORKDIR_SUPABASE/"
  fi
  write_scratch_config
}

apply_migrations() {
  echo "applying supabase/migrations/* against ${PROJECT_ID}..."
  supabase db reset --db-url "$(db_url)" --workdir "$STACK_DIR" --yes
}

apply_seed() {
  local seed_file="$WORKDIR_SUPABASE/seed/test_helpers.sql"
  if [ -f "$seed_file" ]; then
    echo "applying supabase/seed/test_helpers.sql..."
    PGPASSWORD=postgres psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres \
      -v ON_ERROR_STOP=1 -f "$seed_file"
  else
    echo "supabase/seed/test_helpers.sql not found — skipping (nothing to apply)."
  fi
}

write_env_file() {
  local status_json api_url anon_key service_key
  status_json="$(supabase status --workdir "$STACK_DIR" -o json)"
  api_url="$(jq -r '.API_URL' <<<"$status_json")"
  anon_key="$(jq -r '.ANON_KEY' <<<"$status_json")"
  service_key="$(jq -r '.SERVICE_ROLE_KEY' <<<"$status_json")"

  umask 077
  cat >"$ENV_FILE" <<EOF
# Generated by scripts/test-stack.sh — points at the isolated ${PROJECT_ID} stack, never at
# posture-ai's or meal-companion's own dev stack. Re-run the script to regenerate; do not
# hand-edit.
export SUPABASE_TEST_URL="${api_url}"
export SUPABASE_TEST_ANON_KEY="${anon_key}"
export SUPABASE_TEST_SERVICE_ROLE_KEY="${service_key}"
export SUPABASE_TEST_DB_URL="$(db_url)"
EOF
  chmod 600 "$ENV_FILE"
  echo "wrote ${ENV_FILE} (mode 600)."
  echo "run: source ${ENV_FILE} && pnpm test:integration"
}

dry_run() {
  need docker; need lsof
  assert_safe_ports
  if ! assert_no_port_conflict; then exit 1; fi
  echo "dry run OK: no port conflict for ${API_PORT}/${DB_PORT}/${SHADOW_PORT} (${PROJECT_ID})."
}

start() {
  need supabase; need docker; need jq; need psql; need rsync; need python3; need lsof
  assert_safe_ports
  # Gate 1: refuses before `supabase start` is ever invoked.
  if ! assert_no_port_conflict; then exit 1; fi
  prepare_scratch
  # Gate 2: also refuses before `supabase start` is ever invoked — see the comment on
  # assert_scratch_project_id for why this specific check has to run this early.
  if ! assert_scratch_project_id; then exit 1; fi

  echo "starting ${PROJECT_ID} on API ${API_PORT} / DB ${DB_PORT} / shadow ${SHADOW_PORT}..."
  # imgproxy and postgres-meta have no `enabled` toggle in this CLI's config.toml schema, so they
  # are excluded here instead of in the scratch config.
  supabase start --workdir "$STACK_DIR" --exclude imgproxy,postgres-meta

  # Gate 3: refuses before the explicit migration/reset call below.
  if ! assert_db_container_identity; then
    echo "aborting before migrating — container-identity check failed." >&2
    exit 1
  fi
  apply_migrations
  # Gate 4: refuses before the seed step below.
  if ! verify_table_identity; then
    echo "aborting before seeding — schema-identity check failed." >&2
    exit 1
  fi
  apply_seed
  write_env_file
  echo "${PROJECT_ID} is up."
}

stop() {
  need supabase
  if [ ! -d "$WORKDIR_SUPABASE" ]; then
    echo "no scratch workdir at ${WORKDIR_SUPABASE} — nothing to stop."
    exit 0
  fi
  # --workdir scopes this to the mc-care-test project only; posture-ai's and meal-companion's
  # own dev stacks are untouched.
  supabase stop --workdir "$STACK_DIR" --project-id "$PROJECT_ID"
  echo "${PROJECT_ID} stopped."
}

main() {
  case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    --dry-run|dry-run) DRY_RUN=1; dry_run ;;
    *) echo "usage: scripts/test-stack.sh [start|stop|--dry-run]" >&2; exit 2 ;;
  esac
}

# Guarded so tests/scripts/test-stack-dry-run.test.ts can `source` this file (to call its
# functions, e.g. assert_no_port_conflict, directly with DRY_RUN left at 0) without it trying to
# start the real stack as a side effect.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
