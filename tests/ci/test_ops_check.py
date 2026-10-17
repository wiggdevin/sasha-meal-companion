"""scripts/ops-check.py (OD02): alert rules and the one-issue-per-outage sync, with no network."""
import datetime as dt
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "ops_check", Path(__file__).resolve().parents[2] / "scripts/ops-check.py")
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

NOW = dt.datetime(2026, 10, 17, 12, 0, tzinfo=dt.timezone.utc)


def iso(delta_hours):
    return (NOW - dt.timedelta(hours=delta_hours)).isoformat()


class RulesTest(unittest.TestCase):
    def test_health_is_down_only_when_every_attempt_fails(self):
        self.assertEqual(ops.health_findings([(503, {"ok": False}), (200, {"ok": True})]), {"health": None})
        body = ops.health_findings([(503, {"ok": False, "db": "down"}), (None, None), (200, {"ok": False})])["health"]
        self.assertIn("attempt 1: HTTP 503, db down", body)
        self.assertIn("attempt 2: no response, db unknown", body)
        self.assertIn("attempt 3: HTTP 200, db unknown", body)

    def test_health_body_never_echoes_response_text(self):
        body = ops.health_findings([(500, {"ok": False, "db": "secret@example.com"})])["health"]
        self.assertNotIn("secret", body)

    def test_backup_and_job_rules(self):
        clear = ops.state_findings({"now": NOW.isoformat(), "backup_ok_at": iso(10), "hosted_at": iso(30),
                                    "unfinished": []})
        self.assertEqual(clear, {"backup-json": None, "backup-hosted": None, "job-pass": None,
                                 "ai-spend": None, "grounding": None})
        found = ops.state_findings({"now": NOW.isoformat(), "backup_ok_at": iso(40), "hosted_at": iso(50),
                                    "unfinished": [{"job": "estimate", "period": "2026-10-16", "started": iso(27)}]})
        self.assertIn("40 h ago", found["backup-json"])
        self.assertIn("50 h old", found["backup-hosted"])
        self.assertIn("`estimate` period `2026-10-16`, started 27 h ago", found["job-pass"])

    def test_no_json_backup_alerts_and_no_hosted_backup_stays_quiet(self):
        found = ops.state_findings({"now": NOW.isoformat(), "backup_ok_at": None, "hosted_at": None,
                                    "unfinished": None})
        self.assertIn("No `backup_runs` row", found["backup-json"])
        self.assertIsNone(found["backup-hosted"])
        self.assertIsNone(found["job-pass"])

    def test_spend_alerts_over_sixty_percent_of_each_cap(self):
        caps = {"global": 50.0, "background": 10.0, "account": 2.0}
        quiet = ops.spend_findings({"spend_global": 30, "spend_background": 6, "spend_accounts": [1.2, 0.1],
                                    "lookup_month_cost": 0}, caps)
        self.assertEqual(quiet, {"ai-spend": None, "grounding": None})
        for state, text in (({"spend_global": 30.01}, "All accounts: $30.01 of the $50.00 cap (60 %)"),
                            ({"spend_background": 6.5}, "Background work: $6.50 of the $10.00 cap (65 %)"),
                            ({"spend_accounts": [1.9, 1.3, 0.5]},
                             "2 accounts over 60 % of the $2.00 account cap (highest $1.90)")):
            self.assertIn(text, ops.spend_findings(state, caps)["ai-spend"])

    def test_a_full_account_list_reads_as_a_lower_bound(self):
        body = ops.spend_findings({"spend_accounts": [1.5] * ops.ACCOUNT_ROWS}, ops.spend_caps({}))["ai-spend"]
        self.assertIn(f"{ops.ACCOUNT_ROWS}+ accounts", body)

    def test_a_zero_cap_is_the_kill_switch_not_an_alert(self):
        found = ops.spend_findings({"spend_global": 1, "spend_accounts": [1]},
                                   {"global": 0.0, "background": 0.0, "account": 0.0})
        self.assertIsNone(found["ai-spend"])

    def test_spend_caps_follow_the_app_variable_names(self):
        self.assertEqual(ops.spend_caps({}), {"global": 50.0, "background": 10.0, "account": 2.0})
        caps = ops.spend_caps({"AI_GLOBAL_DAILY_SPEND_CAP_USD": "20", "AI_DAILY_SPEND_CAP_USD": "junk",
                               "AI_BACKGROUND_DAILY_SPEND_CAP_USD": ""})
        self.assertEqual(caps, {"global": 20.0, "background": 10.0, "account": 2.0})

    def test_grounding_alerts_past_five_thousand_queries_a_month(self):
        self.assertIsNone(ops.spend_findings({"lookup_month_cost": 70}, ops.spend_caps({}))["grounding"])
        body = ops.spend_findings({"lookup_month_cost": 70.1}, ops.spend_caps({}))["grounding"]
        self.assertIn("up to 5,007 search queries", body)

    def test_state_findings_carry_the_spend_rules(self):
        found = ops.state_findings({"now": NOW.isoformat(), "backup_ok_at": iso(1), "unfinished": [],
                                    "spend_global": 45, "lookup_month_cost": 1})
        self.assertIn("All accounts", found["ai-spend"])
        self.assertIsNone(found["grounding"])

    def test_spend_body_names_no_account(self):
        body = ops.spend_findings({"spend_accounts": [1.5]}, ops.spend_caps({}))["ai-spend"]
        self.assertNotRegex(body, r"[0-9a-f]{8}-[0-9a-f]{4}")

    def test_every_rule_has_a_failing_test_sample(self):
        samples = ops.test_samples(NOW)
        self.assertEqual(sorted(samples), sorted(ops.TITLES))
        for rule, body in samples.items():
            self.assertTrue(body, rule)

    def test_parses_postgres_timestamps(self):
        for text in ("2026-10-17 09:30:00+00", "2026-10-17T09:30:00Z", "2026-10-17T09:30:00.123456+00:00",
                     "2026-10-17 09:30:00.12345+00"):
            self.assertEqual(ops.parse_time(text).replace(microsecond=0),
                             dt.datetime(2026, 10, 17, 9, 30, tzinfo=dt.timezone.utc))

    def test_a_non_json_200_is_an_answer_not_a_timeout(self):
        original = ops.request_json

        def html(*a, **k):
            raise ValueError("not json")
        ops.request_json = html
        try:
            probes = ops.probe_health("https://example.test", attempts=1)
        finally:
            ops.request_json = original
        self.assertEqual(probes, [(200, None)])
        self.assertIn("HTTP 200", ops.health_findings(probes)["health"])

    def test_probe_stops_at_the_first_healthy_answer(self):
        answers = iter([(503, {"ok": False}), (200, {"ok": True}), (503, None)])
        original = ops.request_json
        ops.request_json = lambda *a, **k: next(answers)
        try:
            pauses = []
            probes = ops.probe_health("https://example.test/", sleep=pauses.append)
        finally:
            ops.request_json = original
        self.assertEqual(len(probes), 2)
        self.assertEqual(pauses, [ops.HEALTH_PAUSE_SECONDS])


class FakeIssues:
    def __init__(self, issues, labelled=True):
        self.issues = issues
        self.labelled = labelled
        self.calls = []

    def __call__(self, url, headers, body, method):
        path = url.split("/repos/owner/repo", 1)[1]
        self.calls.append((method or "GET", path.split("?")[0], body))
        if method is None:
            return 200, [dict(i) for i in self.issues]
        if method == "POST" and path == "/labels":
            raise ops.urllib.error.HTTPError(url, 422, "exists", {}, None)
        if method == "POST" and path == "/issues":
            created = {"number": 99, "title": body["title"], "state": "open",
                       "labels": [{"name": n} for n in body["labels"]] if self.labelled else []}
            self.issues.append(created)
            return 201, created
        return 200, {}


class TestAlertTest(unittest.TestCase):
    def test_each_rule_opens_and_closes_one_labelled_test_issue(self):
        for rule in ops.TITLES:
            fake = FakeIssues([])
            body = ops.test_samples(NOW)[rule]
            actions = ops.GitHub("owner/repo", "token", fake).test_alert(rule, body, NOW, "https://run")
            self.assertEqual(actions, [f"opened and closed test #99 ({rule})"])
            writes = [c for c in fake.calls if c[1] != "/labels"]
            self.assertEqual([c[:2] for c in writes],
                             [("POST", "/issues"), ("POST", "/issues/99/comments"), ("PATCH", "/issues/99")])
            created = writes[0][2]
            self.assertEqual(created["title"], f"Test alert: {rule}")
            self.assertNotIn(created["title"], ops.TITLES.values())
            self.assertEqual(created["labels"], [ops.LABEL])
            self.assertIn(body, created["body"])
            self.assertEqual(writes[2][2], {"state": "closed", "state_reason": "completed"})

    def test_cli_test_alert_reads_no_production(self):
        original = ops.read_state, ops.probe_health
        ops.read_state = ops.probe_health = lambda *a, **k: self.fail("no production read")
        env = dict(ops.os.environ)
        try:
            for name in ("GITHUB_TOKEN", "GITHUB_REPOSITORY"):
                ops.os.environ.pop(name, None)
            self.assertEqual(ops.main(["--test-alert", "grounding"]), 0)
        finally:
            ops.read_state, ops.probe_health = original
            ops.os.environ.clear()
            ops.os.environ.update(env)


class SyncTest(unittest.TestCase):
    def sync(self, issues, findings, labelled=True):
        fake = FakeIssues(issues, labelled)
        actions = ops.GitHub("owner/repo", "token", fake).sync(findings, NOW, "https://run")
        return actions, [c for c in fake.calls if c[0] != "GET" and c[1] != "/labels"]

    def test_fails_loudly_when_a_new_issue_lost_its_label(self):
        with self.assertRaises(RuntimeError):
            self.sync([], {"health": "down"}, labelled=False)

    def test_opens_one_issue_then_updates_it(self):
        actions, calls = self.sync([], {"health": "down"})
        self.assertEqual(actions, ["opened #99 (health)"])
        self.assertEqual(calls[0][2]["labels"], [ops.LABEL])
        self.assertEqual(calls[0][2]["title"], ops.TITLES["health"])
        open_issue = {"number": 5, "title": ops.TITLES["health"], "state": "open"}
        actions, calls = self.sync([open_issue], {"health": "still down"})
        self.assertEqual(actions, ["updated #5 (health)"])
        self.assertEqual(calls, [("PATCH", "/issues/5", {"body": calls[0][2]["body"]})])
        self.assertIn("still down", calls[0][2]["body"])

    def test_closes_the_open_issue_when_clear_and_does_nothing_when_none(self):
        open_issue = {"number": 5, "title": ops.TITLES["job-pass"], "state": "open"}
        actions, calls = self.sync([open_issue], {"job-pass": None, "health": None})
        self.assertEqual(actions, ["closed #5 (job-pass)"])
        self.assertEqual([c[:2] for c in calls], [("POST", "/issues/5/comments"), ("PATCH", "/issues/5")])

    def test_reopens_a_recently_closed_issue_instead_of_filing_another(self):
        recent = {"number": 7, "title": ops.TITLES["health"], "state": "closed", "closed_at": iso(1)}
        actions, _ = self.sync([recent], {"health": "down again"})
        self.assertEqual(actions, ["reopened #7 (health)"])
        old = {"number": 7, "title": ops.TITLES["health"], "state": "closed", "closed_at": iso(5)}
        actions, _ = self.sync([old], {"health": "a new outage"})
        self.assertEqual(actions, ["opened #99 (health)"])


if __name__ == "__main__":
    unittest.main()
