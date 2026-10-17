"""scripts/backup-hosted.py (OD03): encrypt, upload, retain and fetch, against a fake bucket and age."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("backup_hosted", ROOT / "scripts/backup-hosted.py")
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)

BASE = "https://ref.supabase.co/storage/v1"
RECIPIENT = "age1" + "q" * 58
SQL = b"-- synthetic dump\n" + b"x" * 4096 + b"\n-- PostgreSQL database dump complete\n"
FAKE_AGE = """#!/usr/bin/env python3
import sys
args = sys.argv[1:]
out = args[args.index("--output") + 1]
data = open(args[-1], "rb").read()
if "--encrypt" in args:
    data = b"FAKEAGE:" + args[args.index("--recipient") + 1].encode() + b"\\n" + data
else:
    head, data = data.split(b"\\n", 1)
    assert head.startswith(b"FAKEAGE:")
open(out, "wb").write(data)
"""


class Bucket:
    def __init__(self):
        self.objects = {}
        self.order = []

    def __call__(self, method, url, headers, body=None, content_type="application/json"):
        path = url.removeprefix(f"{BASE}/object/")
        if method == "POST" and path.startswith("list/"):
            prefix = json.loads(body)["prefix"] if isinstance(body, bytes) else body["prefix"]
            names = {}
            for name in self.objects:
                if name.startswith(prefix):
                    rest = name[len(prefix):]
                    child = rest.split("/", 1)[0]
                    names[child] = None if "/" in rest else "id"
            return json.dumps([{"name": n, "id": i} for n, i in sorted(names.items())]).encode()
        if method == "POST":
            name = path.removeprefix("backups/")
            self.objects[name] = body
            self.order.append(name)
            return b"{}"
        if method == "DELETE":
            for name in body["prefixes"]:
                del self.objects[name]
            return b"[]"
        return self.objects[path.removeprefix("backups/")]


class HostedBackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        (bin_dir / "age").write_text(FAKE_AGE)
        (bin_dir / "age").chmod(0o755)
        self.bucket = Bucket()
        self.patches = [
            patch.dict(os.environ, {"PATH": f"{bin_dir}:/usr/bin:/bin", "SUPABASE_DB_URL": "set",
                                    "SUPABASE_ACCESS_TOKEN": "set", "BACKUP_AGE_RECIPIENT": RECIPIENT,
                                    "RUNNER_TEMP": str(self.root)}, clear=True),
            patch.object(hosted, "http", self.bucket),
            patch.object(hosted.storage, "credentials", lambda: (BASE, {"apikey": "k"})),
            patch.object(hosted, "take_sql", self.fake_sql),
            patch.object(hosted, "take_media", self.fake_media),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def fake_sql(self, work):
        (work / "sql").mkdir()
        dump = work / "sql" / "2026-10-17T083000Z-abcdef12.sql"
        dump.write_bytes(SQL)
        return dump, {"file": dump.name, "bytes": len(SQL), "sha256": hashlib.sha256(SQL).hexdigest(),
                      "postgres_major": 17, "taken_at": "2026-10-17T083000Z", "host": "pooler", "database": "postgres"}

    def fake_media(self, work):
        directory = work / "media" / "run"
        (directory / "objects").mkdir(parents=True)
        data = b"\x89PNG synthetic"
        digest = hashlib.sha256(data).hexdigest()
        (directory / "objects" / digest).write_bytes(data)
        (directory / "manifest.json").write_text(json.dumps({"format": "smc-storage-v1", "objects": [
            {"name": "u/a.png", "sha256": digest, "bytes": len(data)}]}))
        return directory, {"ok": True, "objects": 1, "bytes": len(data), "directory": str(directory)}

    def test_skips_until_every_setting_exists(self):
        with patch.dict(os.environ, {"SUPABASE_DB_URL": ""}):
            self.assertIsNone(hosted.backup(10 ** 9))
        self.assertEqual(self.bucket.objects, {})

    def test_refuses_a_recipient_that_is_not_an_age_public_key(self):
        with patch.dict(os.environ, {"BACKUP_AGE_RECIPIENT": "AGE-SECRET-KEY-1ABC"}):
            with self.assertRaises(hosted.HostedBackupError):
                hosted.backup(10 ** 9)

    def test_uploads_encrypted_objects_then_the_receipt_and_round_trips(self):
        receipt = hosted.backup(10 ** 9)
        stamp = receipt["stamp"]
        self.assertTrue(hosted.STAMP.fullmatch(stamp))
        self.assertEqual(self.bucket.order[-1], f"hosted/{stamp}/receipt.json")
        stored = self.bucket.objects[f"hosted/{stamp}/db.sql.gz.age"]
        self.assertTrue(stored.startswith(b"FAKEAGE:" + RECIPIENT.encode()))
        self.assertNotIn(b"synthetic dump", stored)
        self.assertNotIn("host", receipt["sql"])
        # Nothing plaintext is left behind on the runner.
        self.assertEqual([p.name for p in self.root.iterdir()], ["bin"])

        identity = self.root / "key.txt"
        identity.write_text("AGE-SECRET-KEY-1SYNTHETIC\n")
        dump, media = hosted.fetch(stamp, identity, self.root / "drill")
        self.assertEqual(dump.read_bytes(), SQL)
        restore_receipt = json.loads(dump.with_name(dump.name + ".json").read_text())
        self.assertEqual(restore_receipt["sha256"], hashlib.sha256(SQL).hexdigest())
        self.assertEqual(hosted.storage.verify(media), {"objects": 1, "bytes": 14})

    def test_fetch_refuses_a_tampered_object(self):
        stamp = hosted.backup(10 ** 9)["stamp"]
        self.bucket.objects[f"hosted/{stamp}/db.sql.gz.age"] += b"x"
        identity = self.root / "key.txt"
        identity.write_text("k")
        with self.assertRaises(hosted.HostedBackupError):
            hosted.fetch(stamp, identity, self.root / "drill")

    def test_an_object_over_the_upload_limit_uploads_nothing(self):
        with self.assertRaises(hosted.HostedBackupError):
            hosted.backup(10)
        self.assertEqual(self.bucket.objects, {})

    def test_keeps_the_newest_fourteen_and_leaves_other_names_alone(self):
        for day in range(1, 17):
            self.bucket.objects[f"hosted/2026-09-{day:02d}T083000Z-0000000{day % 10}/receipt.json"] = b"{}"
        self.bucket.objects["hosted/notes/readme.txt"] = b"keep"
        stamp = hosted.backup(10 ** 9)["stamp"]
        folders = sorted({name.split("/")[1] for name in self.bucket.objects})
        self.assertIn(stamp, folders)
        self.assertIn("notes", folders)
        self.assertEqual(len([f for f in folders if hosted.STAMP.fullmatch(f)]), 14)
        self.assertNotIn("2026-09-01T083000Z-00000001", folders)

    def test_failed_runs_do_not_count_and_older_ones_are_removed(self):
        for day in range(1, 14):
            self.bucket.objects[f"hosted/2026-09-{day:02d}T083000Z-0000000{day % 10}/receipt.json"] = b"{}"
        for day in range(20, 26):
            self.bucket.objects[f"hosted/2026-09-{day}T083000Z-1111111{day % 10}/db.sql.gz.age"] = b"half"
        stamp = hosted.backup(10 ** 9)["stamp"]
        folders = sorted({name.split("/")[1] for name in self.bucket.objects})
        # Thirteen complete + this one = fourteen; every half-written older folder is gone.
        self.assertEqual(len(folders), 14)
        self.assertIn("2026-09-01T083000Z-00000001", folders)
        self.assertIn(stamp, folders)

    def test_fetch_refuses_an_unsafe_receipt_name_and_a_used_directory(self):
        stamp = hosted.backup(10 ** 9)["stamp"]
        identity = self.root / "key.txt"
        identity.write_text("k")
        hosted.fetch(stamp, identity, self.root / "drill")
        with self.assertRaises(hosted.HostedBackupError):
            hosted.fetch(stamp, identity, self.root / "drill")
        name = f"hosted/{stamp}/receipt.json"
        receipt = json.loads(self.bucket.objects[name])
        receipt["sql"]["file"] = "../escape.sql"
        self.bucket.objects[name] = json.dumps(receipt).encode()
        with self.assertRaises(hosted.HostedBackupError):
            hosted.fetch(stamp, identity, self.root / "other")
        self.assertFalse((self.root / "escape.sql").exists())


@unittest.skipUnless(shutil.which("age") and shutil.which("age-keygen"), "age is not installed")
class RealAgeTest(unittest.TestCase):
    def test_encrypts_to_the_public_key_and_decrypts_only_with_the_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            key = root / "key.txt"
            subprocess.run(["age-keygen", "-o", str(key)], check=True, capture_output=True)
            recipient = subprocess.run(["age-keygen", "-y", str(key)], check=True, capture_output=True,
                                       text=True).stdout.strip()
            self.assertTrue(hosted.RECIPIENT.fullmatch(recipient))
            (root / "plain").write_bytes(SQL)
            hosted.encrypt(hosted.age_binary(), recipient, root / "plain", root / "sealed")
            self.assertFalse((root / "plain").exists())
            self.assertNotIn(b"synthetic", (root / "sealed").read_bytes())
            hosted.run([hosted.age_binary(), "--decrypt", "--identity", str(key), "--output",
                        str(root / "open"), str(root / "sealed")])
            self.assertEqual((root / "open").read_bytes(), SQL)


if __name__ == "__main__":
    unittest.main()
