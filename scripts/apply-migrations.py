"""Applies the migrations a database is missing, and records them in its ledger.

    python3 scripts/apply-migrations.py                # dry run: names what it would apply
    python3 scripts/apply-migrations.py --commit       # applies them

Env: SUPABASE_ACCESS_TOKEN (Management API token) and SUPABASE_PROJECT_REF, or SUPABASE_URL to
derive the ref from. Neither the token nor the ref is ever printed.

This is a HUMAN action against production, not an agent one (ruling R11a,
docs/decisions/2026-09-13-audit-rulings.md). `scripts/check-migration-drift.ts` is the read-only
half and is what CI runs; this is the half that writes.

Each migration runs inside one transaction together with its own
`supabase_migrations.schema_migrations` row, so a migration can never apply without being
recorded, and a failure leaves the database exactly as it was. Migrations are applied in version
order and the run stops at the first failure.

Back up before running this. The 2026-09-14 run used scripts/backup.sh conventions and wrote to
~/Backups/supabase/.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def project_ref() -> str:
    ref = os.environ.get("SUPABASE_PROJECT_REF")
    if ref:
        return ref
    url = os.environ.get("SUPABASE_URL", "")
    match = re.match(r"^https://([^.]+)\.supabase\.co", url)
    if not match:
        sys.exit("set SUPABASE_PROJECT_REF or SUPABASE_URL")
    return match.group(1)


def query(ref: str, token: str, sql: str):
    request = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode() or "[]")
    except urllib.error.HTTPError as exc:
        # The body can carry connection detail; print the status and the first line only.
        sys.exit(f"Management API returned {exc.code}: {exc.read().decode()[:200]}")


def main() -> None:
    commit = "--commit" in sys.argv
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        sys.exit("set SUPABASE_ACCESS_TOKEN")
    ref = project_ref()

    repo = sorted(
        (m.group(1), path) for path in MIGRATIONS.glob("*.sql")
        if (m := re.match(r"^(\d{14})_.+\.sql$", path.name)))
    applied = {row["version"] for row in
               query(ref, token, "select version from supabase_migrations.schema_migrations;")}
    missing = [(version, path) for version, path in repo if version not in applied]

    if not missing:
        print(f"nothing to apply: {len(repo)} migrations, all recorded")
        return
    for version, path in missing:
        print(f"  would apply {path.name}" if not commit else f"  applying {path.name}")
    if not commit:
        print("\nDRY RUN — nothing applied. Re-run with --commit.")
        return

    for version, path in missing:
        name = path.name[len(version) + 1:-4]
        sql = path.read_text()
        payload = (
            "begin;\n" + sql +
            "\n;insert into supabase_migrations.schema_migrations(version, name, statements) "
            f"values ($v${version}$v$, $n${name}$n$, array[$s${sql}$s$]);\ncommit;")
        query(ref, token, payload)
        confirmed = query(
            ref, token,
            f"select 1 from supabase_migrations.schema_migrations where version = $v${version}$v$;")
        if not confirmed:
            sys.exit(f"{path.name} did not record — stopping")
        print(f"  applied and recorded {path.name}")


if __name__ == "__main__":
    main()
