"""Deterministic CLI tests: all databases/tools are synthetic; no network or real backups."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import fcntl

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("database_backup", ROOT / "scripts/lib/database_backup.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class ScriptsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.dest = self.root / "backups"
        self.trace = self.root / "trace.jsonl"
        self.env_patch = patch.dict(os.environ, {
            "PATH": "/usr/bin:/bin", "HOME": str(self.root), "PG_BIN": str(self.bin),
            "SUPABASE_DB_URL": "postgresql://postgres:secret-synthetic@127.0.0.1:55432/postgres",
        }, clear=True)
        self.env_patch.start()
        self.previous_umask = os.umask(0o077)
        self.tools()

    def tearDown(self):
        os.umask(self.previous_umask)
        self.env_patch.stop()
        self.temp.cleanup()

    def tools(self, tool_major=17, server_major=17, fail=False, footer=True):
        for name in ("psql", "pg_dump"):
            program = f'''#!/usr/bin/python3
import sys, json, os
from pathlib import Path
args=sys.argv[1:]
with Path({str(self.trace)!r}).open('a') as f:
 f.write(json.dumps({{'tool':{name!r}, 'args':args, 'env':dict(os.environ)}})+'\\n')
if '--version' in args: print({name!r}+' (PostgreSQL) {tool_major}.1')
elif '--command' in args: print('{server_major}0001')
elif {name!r} == 'pg_dump':
 print('-- synthetic database\\n'+'-- x'*1000)
 if {footer!r}: print('-- PostgreSQL database dump complete')
 if {fail!r}: sys.exit(2)
'''
            tool = self.bin / name
            tool.write_text(program)
            tool.chmod(0o700)

    def run_backup(self, keep=14):
        with contextlib.redirect_stdout(io.StringIO()):
            backup.backup(backup.connection_env(), self.dest, keep)
        return sorted(self.dest.glob("*.sql"))

    def test_credentials_are_environment_only(self):
        self.run_backup()
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        dump_call = next(row for row in calls if row["tool"] == "pg_dump" and "--format=plain" in row["args"])
        self.assertNotIn("--no-privileges", dump_call["args"])
        self.assertNotIn("--no-acl", dump_call["args"])
        self.assertNotIn("--no-owner", dump_call["args"])
        for row in calls:
            self.assertNotIn("secret-synthetic", " ".join(row["args"]))
            self.assertNotIn("SUPABASE_DB_URL", row["env"])
            self.assertEqual(row["env"]["PGPASSWORD"], "secret-synthetic")

    def test_unique_atomic_private_dumps_with_integrity_receipts(self):
        self.run_backup()
        dumps = self.run_backup()
        self.assertEqual(len(dumps), 2)
        for dump in dumps:
            receipt_path = dump.with_name(dump.name + ".json")
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt["sha256"], backup.digest(dump))
            self.assertEqual(receipt["bytes"], dump.stat().st_size)
            self.assertEqual(stat.S_IMODE(dump.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(receipt_path.stat().st_mode), 0o600)
        self.assertEqual(list(self.dest.glob(".pending-*")), [])

    def test_failure_keeps_previous_backup_and_does_not_rotate(self):
        first = self.run_backup()[0]
        original = first.read_bytes()
        self.tools(fail=True)
        with self.assertRaises(backup.BackupError):
            self.run_backup(keep=1)
        self.assertEqual(list(self.dest.glob("*.sql")), [first])
        self.assertEqual(first.read_bytes(), original)
        self.assertEqual(list(self.dest.glob(".pending-*")), [])

    def test_missing_completion_footer_is_not_published(self):
        self.tools(footer=False)
        with self.assertRaisesRegex(backup.BackupError, "completion footer"):
            self.run_backup()
        self.assertEqual(list(self.dest.glob("*.sql")), [])

    def test_lock_prevents_concurrent_runs(self):
        self.dest.mkdir()
        with (self.dest / ".backup.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(backup.BackupError, "Another backup"):
                self.run_backup()
        self.assertFalse(self.trace.exists())

    def test_retention_only_removes_recognized_dumps_after_success(self):
        self.dest.mkdir()
        for name in ("2020-01-01.sql", "2020-01-02.sql", "notes.sql"):
            (self.dest / name).write_text("old")
        self.run_backup(keep=2)
        self.assertFalse((self.dest / "2020-01-01.sql").exists())
        self.assertTrue((self.dest / "2020-01-02.sql").exists())
        self.assertTrue((self.dest / "notes.sql").exists())

    def test_keep_one_always_retains_new_dump_when_names_share_a_second(self):
        stamp = backup.dt.datetime.now(backup.dt.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
        self.dest.mkdir()
        old = self.dest / (stamp + "-ffffffff.sql")
        old.write_text("old")
        # Even a future mtime and lexically later random suffix cannot displace the new dump.
        os.utime(old, (9999999999, 9999999999))
        fake_id = type("ID", (), {"hex": "00000000" + "a" * 24})()
        with patch.object(backup.uuid, "uuid4", return_value=fake_id):
            dumps = self.run_backup(keep=1)
        self.assertEqual(len(dumps), 1)
        self.assertTrue(dumps[0].name.endswith("-00000000.sql"))
        self.assertFalse(old.exists())

    def test_runtime_or_server_major_mismatch_fails_before_dump(self):
        for tool_major, server_major in ((16, 17), (17, 16)):
            self.tools(tool_major=tool_major, server_major=server_major)
            with self.assertRaisesRegex(backup.BackupError, "17"):
                self.run_backup()
            self.assertEqual(list(self.dest.glob("*.sql")), [])

    def test_connection_settings_cannot_redirect_guard(self):
        os.environ["PGHOSTADDR"] = "unrelated"
        os.environ["PGSERVICE"] = "production"
        os.environ["PGOPTIONS"] = "-c dangerous"
        env = backup.connection_env()
        for key in ("PGHOSTADDR", "PGSERVICE", "PGOPTIONS"):
            self.assertNotIn(key, env)
        os.environ["SUPABASE_DB_URL"] += "?host=production"
        with self.assertRaises(backup.BackupError):
            backup.connection_env()

    def test_restore_rejects_local_production_and_unverified_remote(self):
        for env in ({"PGHOST": "127.0.0.1", "PGDATABASE": "postgres", "PGUSER": "postgres"},
                    {"PGHOST": f"db.{backup.PRODUCTION_REF}.supabase.co", "PGDATABASE": "postgres", "PGUSER": "postgres"},
                    {"PGHOST": "other-production.test", "PGDATABASE": "postgres", "PGUSER": "postgres"}):
            with self.assertRaises(backup.BackupError):
                backup.restore_identity(env)
        self.assertFalse(self.trace.exists())

    def test_branch_identity_requires_non_default_child_from_management_api(self):
        branch_ref = "b" * 20
        env = {"PGHOST": "aws-0-us-west-1.pooler.supabase.com", "PGDATABASE": "postgres", "PGUSER": "postgres." + branch_ref}
        os.environ["SUPABASE_ACCESS_TOKEN"] = "synthetic-management-token"
        row = {"project_ref": branch_ref, "parent_project_ref": backup.PRODUCTION_REF, "is_default": False}
        for is_default in (False, True):
            row["is_default"] = is_default
            result = io.BytesIO(json.dumps([row]).encode())
            opener = type("FakeOpener", (), {"open": lambda self, request, timeout: result})()
            with patch.object(backup, "build_opener", return_value=opener):
                if is_default:
                    with self.assertRaises(backup.BackupError): backup.restore_identity(env)
                else: self.assertEqual(backup.restore_identity(env), branch_ref)

    def test_restore_checks_integrity_and_uses_transaction(self):
        dump = self.run_backup()[0]
        os.environ["SUPABASE_RESTORE_DB_URL"] = "postgresql://postgres:restore-secret@127.0.0.1:55432/smc_restore_test"
        env = backup.connection_env(True)
        with self.assertRaisesRegex(backup.BackupError, "confirm"):
            backup.restore(env, dump, "wrong")
        with contextlib.redirect_stdout(io.StringIO()):
            backup.restore(env, dump, "smc_restore_test")
        last = json.loads(self.trace.read_text().splitlines()[-1])
        self.assertIn("--single-transaction", last["args"])
        self.assertIn("ON_ERROR_STOP=1", last["args"])
        self.assertNotIn("restore-secret", " ".join(last["args"]))
        dump.write_text("corrupt")
        with self.assertRaisesRegex(backup.BackupError, "integrity"):
            backup.restore(env, dump, "smc_restore_test")


if __name__ == "__main__":
    unittest.main()
