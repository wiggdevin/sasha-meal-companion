#!/usr/bin/env python3
"""Private, atomic PostgreSQL dumps and guarded restores. No connection URL enters argv."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import parse_qsl, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

PRODUCTION_REF = "fivatgdpuenszxxnijpc"
REQUIRED_MAJOR = 17
DUMP_NAME = re.compile(r"^\d{4}-\d{2}-\d{2}(?:T\d{6}Z-[a-f0-9]{8})?\.sql$")
PG_KEYS = {"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSSLMODE", "PGSSLROOTCERT", "PGCONNECT_TIMEOUT"}


class BackupError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def connection_env(restore=False):
    # Do not pass unrelated provider credentials, libpq service files, hostaddr or PGOPTIONS to tools.
    env = {k: v for k, v in os.environ.items() if k in PG_KEYS or k in {"PATH", "HOME", "LANG", "TMPDIR"}}
    key = "SUPABASE_RESTORE_DB_URL" if restore else "SUPABASE_DB_URL"
    raw = os.environ.get(key)
    if raw:
        try:
            url = urlsplit(raw)
            if url.scheme not in {"postgres", "postgresql"} or not url.hostname or not url.path.strip("/"):
                raise ValueError()
            env.update(PGHOST=url.hostname, PGPORT=str(url.port or 5432),
                       PGDATABASE=unquote(url.path[1:]), PGUSER=unquote(url.username or "postgres"))
            if url.password is not None:
                env["PGPASSWORD"] = unquote(url.password)
            allowed = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "connect_timeout": "PGCONNECT_TIMEOUT"}
            for name, value in parse_qsl(url.query, keep_blank_values=True):
                if name not in allowed:
                    raise ValueError()
                env[allowed[name]] = value
        except (ValueError, TypeError):
            raise BackupError(f"{key} is not a supported PostgreSQL URL; use standard PG* environment settings") from None
    if not all(env.get(k) for k in ("PGHOST", "PGDATABASE", "PGUSER")):
        raise BackupError(f"Set {key}, or PGHOST/PGDATABASE/PGUSER with PGPASSWORD or PGPASSFILE")
    # PGDATABASE must be a name, not another libpq connection string overriding the guard.
    if not re.fullmatch(r"[A-Za-z0-9_-]+", env["PGDATABASE"]):
        raise BackupError("PGDATABASE must be a plain database name")
    if "," in env["PGHOST"] or not re.fullmatch(r"[A-Za-z0-9.:-]+", env["PGHOST"]):
        raise BackupError("A single explicit database host is required")
    if env.get("PGPASSFILE"):
        password_file = Path(env["PGPASSFILE"])
        if not password_file.is_file() or password_file.stat().st_mode & 0o077:
            raise BackupError("PGPASSFILE must be a private readable file (mode 0600)")
    env.setdefault("PGCONNECT_TIMEOUT", "15")
    if env["PGHOST"] not in {"127.0.0.1", "::1"}:
        env.setdefault("PGSSLMODE", "require")
        if env["PGSSLMODE"] not in {"require", "verify-ca", "verify-full"}:
            raise BackupError("Remote database connections must require TLS")
    return env


def tool(name):
    directory = os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@17/bin")
    path = Path(directory) / name
    if not path.is_file() or not os.access(path, os.X_OK):
        raise BackupError(f"PostgreSQL {REQUIRED_MAJOR} {name} is unavailable; set PG_BIN to its bin directory")
    return str(path)


def run(args, env, stdout=subprocess.PIPE):
    try:
        result = subprocess.run(args, env=env, stdout=stdout, stderr=subprocess.PIPE, check=False)
    except OSError:
        raise BackupError(f"Could not start {Path(args[0]).name}") from None
    if result.returncode:
        # libpq errors may repeat connection details. Keep scheduler logs free of credentials.
        raise BackupError(f"{Path(args[0]).name} failed (exit {result.returncode}); no successful backup/restore recorded")
    return result.stdout.decode().strip() if isinstance(result.stdout, bytes) else ""


def sql(query, env):
    return run([tool("psql"), "-X", "--no-password", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", query], env)


def check_versions(env):
    for name in ("pg_dump", "psql"):
        version = run([tool(name), "--version"], env)
        match = re.search(r"PostgreSQL\) (\d+)", version)
        if not match or int(match[1]) != REQUIRED_MAJOR:
            raise BackupError(f"{name} must be PostgreSQL {REQUIRED_MAJOR}")
    version = sql("SHOW server_version_num", env)
    if not version.isdigit() or int(version) // 10000 != REQUIRED_MAJOR:
        raise BackupError(f"Database and tools must both use PostgreSQL {REQUIRED_MAJOR}")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def backup(env, destination, keep):
    if keep < 1:
        raise BackupError("Retention must keep at least one dump")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.chmod(0o700)
    with (destination / ".backup.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("Another backup is running; existing dumps were left untouched") from None
        check_versions(env)
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
        name = f"{stamp}-{uuid.uuid4().hex[:8]}.sql"
        final = destination / name
        # One pg_dump owns one consistent snapshot; unique paths never replace today's earlier dump.
        with tempfile.TemporaryDirectory(prefix=".pending-", dir=destination) as pending:
            dump = Path(pending) / name
            with dump.open("wb") as stream:
                run([tool("pg_dump"), "--no-password", "--format=plain", "--clean", "--if-exists"], env, stream)
                stream.flush()
                os.fsync(stream.fileno())
            if dump.stat().st_size < 1024:
                raise BackupError("Dump is unexpectedly small; existing dumps were left untouched")
            with dump.open("rb") as stream:
                stream.seek(max(0, dump.stat().st_size - 4096))
                if b"PostgreSQL database dump complete" not in stream.read():
                    raise BackupError("Dump has no completion footer; existing dumps were left untouched")
            receipt = {"format": "postgresql-plain-v1", "file": name, "bytes": dump.stat().st_size,
                       "sha256": digest(dump), "postgres_major": REQUIRED_MAJOR,
                       "taken_at": stamp, "host": env["PGHOST"], "database": env["PGDATABASE"]}
            manifest = Path(pending) / f"{name}.json"
            with manifest.open("w") as stream:
                json.dump(receipt, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            # Publish metadata first. A crash before the dump rename leaves no apparent new backup.
            os.replace(manifest, destination / manifest.name)
            os.replace(dump, final)
        sync_directory(destination)
        # The just-published dump always survives, even when two names share one UTC second.
        others = sorted((p for p in destination.iterdir() if p != final and p.is_file() and DUMP_NAME.fullmatch(p.name)),
                        key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
        for old in others[keep - 1:]:
            old.unlink()
            old.with_name(old.name + ".json").unlink(missing_ok=True)
        sync_directory(destination)
        print(f"wrote {final} ({receipt['bytes']} bytes; sha256 {receipt['sha256']}); keeping {keep}")


def restore_identity(env):
    host, database, user = env["PGHOST"], env["PGDATABASE"], env["PGUSER"]
    if host in {"127.0.0.1", "::1"}:
        if not re.fullmatch(r"smc_restore_[a-z0-9_]+", database):
            raise BackupError("Local restore requires a disposable database named smc_restore_<name>")
        return database
    direct = re.fullmatch(r"db\.([a-z]{20})\.supabase\.co", host)
    pooler = re.fullmatch(r"aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com", host)
    ref = direct[1] if direct else user.removeprefix("postgres.") if pooler and user.startswith("postgres.") else None
    if not ref or not re.fullmatch(r"[a-z]{20}", ref) or ref == PRODUCTION_REF:
        raise BackupError("Remote restore requires a verified non-production Supabase branch")
    if env.get("PGPORT", "5432") != "5432":
        raise BackupError("Use the branch direct connection or session pooler on port 5432")
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        raise BackupError("SUPABASE_ACCESS_TOKEN is required to verify the branch before restore")
    request = Request(f"https://api.supabase.com/v1/projects/{PRODUCTION_REF}/branches", headers={"Authorization": f"Bearer {token}"})
    try:
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            branches = json.load(response)
    except Exception:
        raise BackupError("Could not verify the restore target against Supabase branch metadata") from None
    if not isinstance(branches, list) or not any(isinstance(branch, dict) and branch.get("project_ref") == ref
            and branch.get("parent_project_ref") == PRODUCTION_REF and branch.get("is_default") is False for branch in branches):
        raise BackupError("Restore target is not a non-default branch of Sasha's production project")
    return ref


def restore(env, dump, confirm):
    target = restore_identity(env)  # Validate identity before any connection or destructive SQL.
    if confirm != target:
        raise BackupError("--confirm must exactly name the verified branch ref or disposable local database")
    try:
        receipt = json.loads(dump.with_name(dump.name + ".json").read_text())
    except (OSError, ValueError):
        raise BackupError("Restore requires the matching JSON integrity receipt from backup.sh") from None
    if not isinstance(receipt, dict) or receipt.get("file") != dump.name or receipt.get("sha256") != digest(dump) or receipt.get("bytes") != dump.stat().st_size:
        raise BackupError("Backup integrity check failed; nothing restored")
    check_versions(env)
    run([tool("psql"), "-X", "--no-password", "--single-transaction", "--set", "ON_ERROR_STOP=1", "--file", str(dump)], env)
    print(f"restored verified dump into {target}")


def main():
    os.umask(0o077)
    if any("postgres://" in arg or "postgresql://" in arg for arg in sys.argv[1:]):
        print("Connection URLs belong in environment variables, never command arguments", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    save = modes.add_parser("backup")
    save.add_argument("--destination", type=Path, default=Path(os.environ.get("SMC_BACKUP_DIR", str(Path.home() / "Backups/supabase/meal-companion"))))
    save.add_argument("--keep", type=int, default=14)
    load = modes.add_parser("restore")
    load.add_argument("dump", type=Path)
    load.add_argument("--confirm", required=True)
    args = parser.parse_args()
    try:
        env = connection_env(args.mode == "restore")
        if args.mode == "backup":
            backup(env, args.destination, args.keep)
        else:
            restore(env, args.dump, args.confirm)
    except (BackupError, OSError) as error:
        # OSError includes paths only; never log subprocess stderr or a credential-bearing URL.
        print(f"backup: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
