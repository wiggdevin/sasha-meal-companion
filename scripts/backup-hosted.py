#!/usr/bin/env python3
"""Hosted encrypted backup (OD03): one pg_dump and the media bucket, age-encrypted, in a private bucket.

  python3 scripts/backup-hosted.py backup
  python3 scripts/backup-hosted.py fetch <stamp> --identity <age key file> --dest <private dir>

`backup` runs from .github/workflows/hosted-backup.yml. It takes the SQL dump with
scripts/lib/database_backup.py and the media copy with scripts/backup-storage.py (the same code the
Mac job runs), gzips each, encrypts each to BACKUP_AGE_RECIPIENT (a public key; the private key never
reaches GitHub) and uploads `hosted/<stamp>/{db.sql.gz.age,media.tar.gz.age,receipt.json}` to the
private `backups` bucket. The receipt is written last, so a folder without one is not a backup.
Fourteen complete backups are kept. Nothing is published as a workflow artifact (the repo is public),
and plaintext only ever sits in the runner's private temp directory.

`fetch` is the restore drill's first step: it downloads one backup, checks every hash, decrypts it and
writes `<dump>.sql` with the `.sql.json` receipt scripts/restore-to-branch.sh requires, plus the media
directory scripts/backup-storage.py --verify reads.

Env: SUPABASE_DB_URL (backup only; the session pooler URI, since runners have no IPv6),
SUPABASE_ACCESS_TOKEN (or SUPABASE_SERVICE_ROLE_KEY) for Storage, BACKUP_AGE_RECIPIENT (backup only),
PG_BIN. With any of them unset, `backup` is a logged no-op, like the other scheduled checks before
their secrets exist. Never prints a credential, a URL with a password or an object's contents.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "smc-hosted-backup-v1"
BUCKET = "backups"
PREFIX = "hosted"
KEEP = 14
SQL_OBJECT = "db.sql.gz.age"
MEDIA_OBJECT = "media.tar.gz.age"
RECEIPT_OBJECT = "receipt.json"
DUMP_FILE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}Z-[a-f0-9]{8}\.sql$")
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}Z-[a-f0-9]{8}$")
RECIPIENT = re.compile(r"^age1[02-9ac-hj-np-z]{58}$")
# Supabase's default per-object upload limit (free plan). A bigger object fails loudly here instead.
DEFAULT_MAX_OBJECT_BYTES = 50 * 1024 * 1024


class HostedBackupError(Exception):
    pass


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storage = _load("backup_storage", ROOT / "scripts/backup-storage.py")


def sha256(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def age_binary():
    found = shutil.which("age")
    if not found:
        raise HostedBackupError("age is not installed")
    return found


def run(args, env=None):
    result = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        # Tool stderr can repeat connection details; name the tool (or the script) only.
        name = Path(args[1] if args[0] == sys.executable else args[0]).name
        raise HostedBackupError(f"{name} failed (exit {result.returncode})")
    return result.stdout.decode()


def http(method, url, headers, body=None, content_type="application/json"):
    """One Storage request; returns the response bytes. Split out so tests can replace it."""
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={**headers, "Content-Type": content_type})
    with urllib.request.build_opener(storage.NoRedirect).open(request, timeout=300) as response:
        return response.read()



def object_url(base, name):
    return f"{base}/object/{BUCKET}/{urllib.parse.quote(name, safe='/')}"


def upload(base, headers, name, path):
    http("POST", object_url(base, name), {**headers, "x-upsert": "false"}, Path(path).read_bytes(),
         content_type="application/octet-stream")


def list_folder(base, headers, prefix):
    rows = json.loads(http("POST", f"{base}/object/list/{BUCKET}", headers,
                           {"prefix": prefix, "limit": 1000, "offset": 0,
                            "sortBy": {"column": "name", "order": "asc"}}))
    if not isinstance(rows, list):
        raise HostedBackupError("Invalid storage listing")
    return rows


def encrypt(age, recipient, source, target):
    run([age, "--encrypt", "--recipient", recipient, "--output", str(target), str(source)])
    Path(source).unlink()


def gzip_file(source, target):
    with Path(source).open("rb") as reader, gzip.open(target, "wb", compresslevel=9) as writer:
        shutil.copyfileobj(reader, writer, 1024 * 1024)
    Path(source).unlink()


def take_sql(work):
    destination = work / "sql"
    run([sys.executable, str(ROOT / "scripts/lib/database_backup.py"), "backup",
         "--destination", str(destination), "--keep", "1"])
    dumps = sorted(destination.glob("*.sql"))
    if len(dumps) != 1:
        raise HostedBackupError("Expected exactly one SQL dump")
    receipt = json.loads(dumps[0].with_name(dumps[0].name + ".json").read_text())
    if receipt.get("sha256") != sha256(dumps[0]) or receipt.get("bytes") != dumps[0].stat().st_size:
        raise HostedBackupError("SQL dump does not match its receipt")
    return dumps[0], receipt


def take_media(work):
    destination = work / "media"
    output = run([sys.executable, str(ROOT / "scripts/backup-storage.py"), "--dest", str(destination)])
    result = json.loads(output.strip().splitlines()[-1])
    if not result.get("ok"):
        raise HostedBackupError("Media backup failed")
    return Path(result["directory"]), result


def retention(base, headers, keep_stamp):
    """Keep the newest KEEP complete backups (with a receipt), counting this one. A folder without a
    receipt older than this one is a failed run and goes too. Names that are not stamps are never touched."""
    stamps = sorted((row["name"] for row in list_folder(base, headers, f"{PREFIX}/")
                     if not row.get("id") and STAMP.fullmatch(row.get("name", ""))), reverse=True)
    complete, doomed = 0, []
    for stamp in stamps:
        names = [row["name"] for row in list_folder(base, headers, f"{PREFIX}/{stamp}/") if row.get("id")]
        if stamp == keep_stamp:
            complete += 1
            continue
        if RECEIPT_OBJECT in names:
            complete += 1
            if complete > KEEP:
                doomed.append((stamp, names))
        elif stamp < keep_stamp:
            doomed.append((stamp, names))
    for stamp, names in doomed:
        if names:
            http("DELETE", f"{base}/object/{BUCKET}", headers,
                 {"prefixes": [f"{PREFIX}/{stamp}/{name}" for name in names]})
    return len(doomed)


def missing_backup_settings(env):
    missing = [key for key in ("SUPABASE_DB_URL", "BACKUP_AGE_RECIPIENT") if not env.get(key)]
    if not env.get("SUPABASE_ACCESS_TOKEN") and not env.get("SUPABASE_SERVICE_ROLE_KEY"):
        missing.append("SUPABASE_ACCESS_TOKEN")
    return missing


def backup(max_object_bytes):
    missing = missing_backup_settings(os.environ)
    if missing:
        print(f"hosted backup: skipped ({', '.join(missing)} not set)")
        return None
    recipient = os.environ["BACKUP_AGE_RECIPIENT"].strip()
    if not RECIPIENT.fullmatch(recipient):
        raise HostedBackupError("BACKUP_AGE_RECIPIENT is not an age public key (age1…)")
    age = age_binary()
    base, headers = storage.credentials()
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    work = Path(tempfile.mkdtemp(prefix="smc-hosted-", dir=os.environ.get("RUNNER_TEMP")))
    try:
        work.chmod(0o700)
        dump, sql_receipt = take_sql(work)
        media_dir, media = take_media(work)

        gzip_file(dump, work / "db.sql.gz")
        encrypt(age, recipient, work / "db.sql.gz", work / SQL_OBJECT)
        with tarfile.open(work / "media.tar.gz", "w:gz") as archive:
            archive.add(media_dir, arcname="media")
        shutil.rmtree(media_dir)
        encrypt(age, recipient, work / "media.tar.gz", work / MEDIA_OBJECT)

        encrypted = {}
        for name in (SQL_OBJECT, MEDIA_OBJECT):
            size = (work / name).stat().st_size
            if size > max_object_bytes:
                raise HostedBackupError(f"{name} is {size} bytes, over the {max_object_bytes}-byte upload limit")
            encrypted[name] = {"bytes": size, "sha256": sha256(work / name)}
        receipt = {
            "format": FORMAT, "stamp": stamp, "taken_at": sql_receipt["taken_at"],
            "sql": {key: sql_receipt[key] for key in ("file", "bytes", "sha256", "postgres_major")},
            "media": {"objects": media["objects"], "bytes": media["bytes"]},
            "encrypted": encrypted,
        }
        (work / RECEIPT_OBJECT).write_text(json.dumps(receipt, indent=2) + "\n")

        for name in (SQL_OBJECT, MEDIA_OBJECT, RECEIPT_OBJECT):
            upload(base, headers, f"{PREFIX}/{stamp}/{name}", work / name)
        removed = retention(base, headers, stamp)
        print(json.dumps({"ok": True, "stamp": stamp, "sql_bytes": receipt["sql"]["bytes"],
                          "media_objects": media["objects"], "encrypted": encrypted, "removed": removed}))
        return receipt
    finally:
        shutil.rmtree(work, ignore_errors=True)


def safe_extract(archive, destination):
    root = destination.resolve()
    for member in archive.getmembers():
        target = (destination / member.name).resolve()
        if not (member.isfile() or member.isdir()) or (target != root and root not in target.parents):
            raise HostedBackupError("Media archive holds an unexpected entry")
    if hasattr(tarfile, "data_filter"):
        archive.extractall(destination, filter="data")
    else:
        archive.extractall(destination)


def fetch(stamp, identity, destination):
    if not STAMP.fullmatch(stamp):
        raise HostedBackupError("Stamp must look like 2026-10-17T083000Z-1a2b3c4d")
    if not Path(identity).is_file():
        raise HostedBackupError("--identity must be the age private key file")
    age = age_binary()
    base, headers = storage.credentials()
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = json.loads(http("GET", object_url(base, f"{PREFIX}/{stamp}/{RECEIPT_OBJECT}"), headers))
    if receipt.get("format") != FORMAT or receipt.get("stamp") != stamp:
        raise HostedBackupError("Unsupported hosted backup receipt")
    if not DUMP_FILE.fullmatch(str(receipt.get("sql", {}).get("file", ""))):
        raise HostedBackupError("Receipt names an unexpected dump file")
    for existing in (destination / receipt["sql"]["file"], destination / f"{stamp}-media"):
        if existing.exists():
            raise HostedBackupError(f"{existing.name} already exists in --dest; use an empty directory")
    work = Path(tempfile.mkdtemp(prefix=".fetch-", dir=destination))
    try:
        for name in (SQL_OBJECT, MEDIA_OBJECT):
            (work / name).write_bytes(http("GET", object_url(base, f"{PREFIX}/{stamp}/{name}"), headers))
            expected = receipt["encrypted"][name]
            if (work / name).stat().st_size != expected["bytes"] or sha256(work / name) != expected["sha256"]:
                raise HostedBackupError(f"{name} does not match its receipt")
            plain = work / name.removesuffix(".age")
            run([age, "--decrypt", "--identity", str(identity), "--output", str(plain), str(work / name)])
        sql = receipt["sql"]
        dump = destination / sql["file"]
        with gzip.open(work / "db.sql.gz", "rb") as reader, dump.open("wb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
        if dump.stat().st_size != sql["bytes"] or sha256(dump) != sql["sha256"]:
            dump.unlink()
            raise HostedBackupError("Decrypted SQL dump does not match its receipt")
        # The receipt shape scripts/restore-to-branch.sh checks (file, bytes, sha256).
        dump.with_name(dump.name + ".json").write_text(json.dumps(
            {"format": "postgresql-plain-v1", **sql, "taken_at": receipt["taken_at"]}, indent=2) + "\n")
        media = destination / f"{stamp}-media"
        with tarfile.open(work / "media.tar.gz", "r:gz") as archive:
            safe_extract(archive, work / "unpacked")
        (work / "unpacked" / "media").rename(media)
        verified = storage.verify(media)
        print(json.dumps({"ok": True, "sql": str(dump), "media": str(media), **verified}))
        return dump, media
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    modes = parser.add_subparsers(dest="mode", required=True)
    save = modes.add_parser("backup")
    save.add_argument("--max-object-bytes", type=int, default=int(os.environ.get(
        "BACKUP_MAX_OBJECT_BYTES", DEFAULT_MAX_OBJECT_BYTES)))
    load = modes.add_parser("fetch")
    load.add_argument("stamp")
    load.add_argument("--identity", required=True, type=Path)
    load.add_argument("--dest", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.mode == "backup":
            backup(args.max_object_bytes)
        else:
            fetch(args.stamp, args.identity, args.dest)
    except HostedBackupError as error:
        print(f"hosted backup: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 — HTTP and OS errors can carry URLs or headers.
        print(f"hosted backup: failed ({type(error).__name__})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
