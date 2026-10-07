"""Exercise CI's destination boundary without Docker, database writes, or real secrets."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "local_supabase", Path(__file__).resolve().parents[2] / "scripts/ci-local-supabase.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class LocalEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.status = {"API_URL": "http://127.0.0.1:54321",
                       "DB_URL": "postgresql://postgres:test%40password@127.0.0.1:54322/postgres",
                       "ANON_KEY": "synthetic-anon", "SERVICE_ROLE_KEY": "synthetic-service"}

    def test_same_local_stack_for_every_client_and_password_only_in_pg_environment(self):
        exported, pg = helper.local_environment(self.status)
        self.assertEqual(exported["SUPABASE_TEST_URL"], exported["SUPABASE_URL"])
        self.assertEqual(exported["SUPABASE_URL"], exported["NEXT_PUBLIC_SUPABASE_URL"])
        self.assertEqual(exported["SUPABASE_TEST_SERVICE_ROLE_KEY"], exported["SUPABASE_SERVICE_ROLE_KEY"])
        self.assertEqual(pg["PGPASSWORD"], "test@password")
        self.assertEqual(pg["PGHOST"], "127.0.0.1")

    def test_rejects_hosted_or_redirected_connections(self):
        for key, value in [("API_URL", "https://project.supabase.co"),
                           ("DB_URL", "postgresql://user:password@db.example.com:5432/postgres"),
                           ("DB_URL", self.status["DB_URL"] + "?host=db.example.com"),
                           ("API_URL", "http://localhost.evil.example:54321")]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                helper.local_environment({**self.status, key: value})

    def test_missing_keys_and_env_injection_fail_closed(self):
        for key in self.status:
            for value in (None, "", "value\nINJECTED=1"):
                with self.subTest(key=key), self.assertRaises(ValueError):
                    helper.local_environment({**self.status, key: value})


if __name__ == "__main__":
    unittest.main()
