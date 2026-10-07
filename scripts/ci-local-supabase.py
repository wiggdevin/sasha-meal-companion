#!/usr/bin/env python3
"""Start an ephemeral CI database; never connect this helper to a hosted project."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
EXCLUDE = "studio,imgproxy,mailpit,realtime,postgres-meta,edge-runtime,logflare,vector,supavisor"


def local_environment(status):
    """Validate everything before returning secrets or allowing a database write."""
    if not isinstance(status, dict):
        raise ValueError("Local Supabase status must be an object")
    values = {}
    for key in ("API_URL", "DB_URL", "ANON_KEY", "SERVICE_ROLE_KEY"):
        value = status.get(key)
        if not isinstance(value, str) or not value or any(c in value for c in "\r\n\0"):
            raise ValueError("Missing or malformed local Supabase status")
        values[key] = value
    api, db = urlsplit(values["API_URL"]), urlsplit(values["DB_URL"])
    if (api.scheme != "http" or api.hostname not in ("127.0.0.1", "localhost", "::1")
            or api.username or api.password or api.query or api.fragment):
        raise ValueError("API endpoint must be local HTTP")
    if (db.scheme not in ("postgres", "postgresql")
            or db.hostname not in ("127.0.0.1", "localhost", "::1")
            or db.query or db.fragment or not db.username or not db.password
            or db.path != "/postgres" or not db.port):
        raise ValueError("Database endpoint must be local Postgres")
    pg = {"PGHOST": db.hostname, "PGPORT": str(db.port), "PGDATABASE": "postgres",
          "PGUSER": unquote(db.username), "PGPASSWORD": unquote(db.password),
          "PGCONNECT_TIMEOUT": "10", "PGSSLMODE": "disable"}
    exported = {
        "SUPABASE_TEST_URL": values["API_URL"],
        "SUPABASE_TEST_ANON_KEY": values["ANON_KEY"],
        "SUPABASE_TEST_SERVICE_ROLE_KEY": values["SERVICE_ROLE_KEY"],
        "SUPABASE_TEST_DB_URL": values["DB_URL"],
        "SUPABASE_URL": values["API_URL"],
        "SUPABASE_SERVICE_ROLE_KEY": values["SERVICE_ROLE_KEY"],
        "NEXT_PUBLIC_SUPABASE_URL": values["API_URL"],
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": values["ANON_KEY"],
    }
    return exported, pg


def mask(value):
    escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::add-mask::{escaped}", flush=True)


def start():
    if os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("GITHUB_ENV"):
        raise ValueError("This startup helper requires an ephemeral GitHub Actions runner")
    # Both streams can contain local keys. Never echo or upload these raw files.
    with tempfile.TemporaryFile(mode="w+") as log:
        result = subprocess.run(["pnpm", "exec", "supabase", "start", "-x", EXCLUDE],
                                cwd=ROOT, stdout=log, stderr=log, timeout=600, check=False)
        if result.returncode:
            raise RuntimeError(f"Local Supabase startup failed (exit {result.returncode}); CLI output withheld")
    result = subprocess.run(["pnpm", "exec", "supabase", "status", "-o", "json"],
                            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError("Could not read local Supabase status")
    try:
        status = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise ValueError("Local Supabase status was not valid JSON") from None
    exported, pg = local_environment(status)
    # Register masks before any subsequent command or GITHUB_ENV write.
    for value in set(exported.values()) | {pg["PGPASSWORD"]}:
        mask(value)
    result = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-f",
                             str(ROOT / "supabase/seed/test_helpers.sql")],
                            cwd=ROOT, env={**os.environ, **pg}, capture_output=True,
                            timeout=60, check=False)
    if result.returncode:
        raise RuntimeError("Local test-helper seed failed; database output withheld")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf8") as output:
        for name, value in exported.items():
            output.write(f"{name}={value}\n")
    print("Local Supabase migrations and test helpers are ready; integration cannot silently skip.")


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["start"]:
            raise ValueError("Usage: ci-local-supabase.py start")
        start()
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        # Do not include command output, status JSON, environment, or credential-bearing URLs.
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"Local integration setup failed: {detail}", file=sys.stderr)
        sys.exit(1)
