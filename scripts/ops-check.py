#!/usr/bin/env python3
"""Production alerts (OD02): /api/health, stale backups and unfinished job passes, as GitHub issues.

  python3 scripts/ops-check.py

Runs from .github/workflows/ops-check.yml every 15 minutes. No new vendor: each alert is one GitHub
issue, labelled `ops-alert`, opened when the problem starts, kept up to date while it lasts and
closed when it clears, so one outage is one issue (an issue closed in the last two hours is reopened
instead of opening another, so a flapping check does not file a pile). Issue bodies carry only
status codes, job names, dates and ages: never a user id, an email, a row, or a response body.

Checks:
- health: GET <HEALTH_URL>/api/health. Down means three attempts, 20 s apart, all failing
  (not 200, or `ok` not true). HEALTH_URL defaults to the production URL in README.md.
- backup-json: the newest `backup_runs` row with status ok finished more than 36 h ago (or none).
- backup-hosted: the newest hosted encrypted backup (scripts/backup-hosted.py) is more than 36 h
  old. Watched once the first one exists, so it stays quiet until the backup workflow is set up.
- job-pass: a job whose newest `job_cursors` pass (of the last 7 days) started more than 12 h ago
  and is still not done. Every scheduled job's fires fall within four hours of its pass starting,
  and a later finished pass clears the alert.

The database checks read through the Supabase Management API with the SUPABASE_ACCESS_TOKEN and
SUPABASE_PROJECT_REF secrets the migration-drift check already uses; one read-only select. Unset,
they are skipped with a log line and their issues are left as they are. GITHUB_TOKEN and
GITHUB_REPOSITORY come from the workflow; unset, findings are only printed.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LABEL = "ops-alert"
DEFAULT_HEALTH_URL = "https://sasha-meal-companion.vercel.app"
BACKUP_MAX_AGE = dt.timedelta(hours=36)
REOPEN_WINDOW = dt.timedelta(hours=2)
HEALTH_ATTEMPTS = 3
HEALTH_PAUSE_SECONDS = 20

TITLES = {
    "health": "Alert: production health check failing",
    "backup-json": "Alert: JSON backup is stale",
    "backup-hosted": "Alert: hosted database backup is stale",
    "job-pass": "Alert: a background job pass did not finish",
}

STATE_QUERY = """
with newest as (
  select distinct on (job) job, period, done, pass_started_at
  from public.job_cursors
  where pass_started_at > now() - interval '7 days'
  order by job, pass_started_at desc
)
select json_build_object(
  'now', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'backup_ok_at', (select to_char(max(finished_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                   from public.backup_runs where status = 'ok'),
  'hosted_at', (select to_char(max(created_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                from storage.objects
                where bucket_id = 'backups' and name like 'hosted/%/receipt.json'),
  'unfinished', (select coalesce(json_agg(json_build_object(
                   'job', job, 'period', period,
                   'started', to_char(pass_started_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                   order by job), '[]'::json)
                 from newest
                 where not done and pass_started_at < now() - interval '12 hours')
) as state;
"""


def parse_time(value):
    if value is None:
        return None
    text = str(value).replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Postgres can print "+00" for the offset; fromisoformat wants "+00:00" before Python 3.11.
    if len(text) >= 3 and text[-3] in "+-" and text[-2:].isdigit():
        text += ":00"
    # ...and exactly six fraction digits (STATE_QUERY sends whole seconds; this is for other callers).
    text = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], text, count=1)
    parsed = dt.datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def hours(delta):
    return int(delta.total_seconds() // 3600)


def health_findings(probes):
    """probes: [(status code or None, body dict or None)], one per attempt, all failing = down."""
    if any(status == 200 and isinstance(body, dict) and body.get("ok") is True for status, body in probes):
        return {"health": None}
    lines = []
    for index, (status, body) in enumerate(probes, 1):
        db = body.get("db") if isinstance(body, dict) and body.get("db") in ("ok", "down") else "unknown"
        lines.append(f"- attempt {index}: {'no response' if status is None else f'HTTP {status}'}, db {db}")
    return {"health": "`GET /api/health` failed every attempt.\n\n" + "\n".join(lines)}


def state_findings(state):
    """The database checks from one STATE_QUERY row. A key maps to a body, or None when clear."""
    now = parse_time(state["now"])
    found = {}
    backup_ok = parse_time(state.get("backup_ok_at"))
    if backup_ok is None:
        found["backup-json"] = "No `backup_runs` row has finished with status ok."
    elif now - backup_ok > BACKUP_MAX_AGE:
        found["backup-json"] = (f"The newest successful JSON backup finished {hours(now - backup_ok)} h ago "
                                f"({backup_ok:%Y-%m-%d %H:%M} UTC); the limit is {hours(BACKUP_MAX_AGE)} h.")
    else:
        found["backup-json"] = None
    hosted = parse_time(state.get("hosted_at"))
    if hosted is not None and now - hosted > BACKUP_MAX_AGE:
        found["backup-hosted"] = (f"The newest hosted encrypted backup is {hours(now - hosted)} h old "
                                  f"({hosted:%Y-%m-%d %H:%M} UTC); the limit is {hours(BACKUP_MAX_AGE)} h.")
    else:
        found["backup-hosted"] = None
    unfinished = state.get("unfinished") or []
    if unfinished:
        rows = [f"- `{row['job']}` period `{row['period']}`, started "
                f"{hours(now - parse_time(row['started']))} h ago" for row in unfinished]
        found["job-pass"] = "These `job_cursors` passes are still not done:\n\n" + "\n".join(rows)
    else:
        found["job-pass"] = None
    return found


def request_json(url, headers=None, body=None, method=None, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        return response.status, (json.loads(raw) if raw else None)


def probe_health(base_url, attempts=HEALTH_ATTEMPTS, pause=HEALTH_PAUSE_SECONDS, sleep=time.sleep):
    probes = []
    for attempt in range(attempts):
        try:
            status, body = request_json(f"{base_url.rstrip('/')}/api/health", timeout=15)
        except urllib.error.HTTPError as error:
            status, body = error.code, None
            try:
                body = json.loads(error.read() or b"null")
            except ValueError:
                pass
        except ValueError:
            # A 200 that is not JSON (an HTML error page): an answer, but not a healthy one.
            status, body = 200, None
        except Exception:  # noqa: BLE001 — timeouts, DNS and TLS failures are all "no response".
            status, body = None, None
        probes.append((status, body))
        if status == 200 and isinstance(body, dict) and body.get("ok") is True:
            break
        if attempt + 1 < attempts:
            sleep(pause)
    return probes


def read_state(ref, token):
    status, rows = request_json(f"https://api.supabase.com/v1/projects/{ref}/database/query",
                                {"Authorization": f"Bearer {token}"}, {"query": STATE_QUERY}, "POST")
    if status not in (200, 201) or not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("Management API returned an unexpected answer")
    state = rows[0]["state"]
    return json.loads(state) if isinstance(state, str) else state


class GitHub:
    def __init__(self, repo, token, call=request_json):
        self.repo, self.call = repo, call
        self.headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ops-check-workflow"}

    def api(self, path, body=None, method=None):
        return self.call(f"https://api.github.com/repos/{self.repo}{path}", self.headers, body, method)[1]

    def ensure_label(self):
        """Issue lookup depends on the label, so make sure it exists (422: it already does)."""
        try:
            self.api("/labels", {"name": LABEL, "color": "b60205",
                                 "description": "Opened and closed by scripts/ops-check.py"}, "POST")
        except urllib.error.HTTPError as error:
            if error.code != 422:
                raise

    def alert_issues(self):
        issues = []
        for page in range(1, 11):
            query = urllib.parse.urlencode({"labels": LABEL, "state": "all", "per_page": 100, "page": page,
                                            "sort": "updated", "direction": "desc"})
            batch = self.api(f"/issues?{query}")
            issues += [issue for issue in batch if "pull_request" not in issue]
            if len(batch) < 100:
                break
        return issues

    def sync(self, findings, now, run_url):
        """Open, update, reopen or close one issue per finding key. Returns one log line per action."""
        self.ensure_label()
        issues = self.alert_issues()
        actions = []
        for key, body in findings.items():
            title = TITLES[key]
            same = sorted((i for i in issues if i["title"] == title), key=lambda i: i["number"])
            open_issue = next((i for i in same if i["state"] == "open"), None)
            if body is None:
                if open_issue:
                    self.api(f"/issues/{open_issue['number']}/comments",
                             {"body": f"Cleared at {now:%Y-%m-%d %H:%M} UTC ({run_url})."}, "POST")
                    self.api(f"/issues/{open_issue['number']}", {"state": "closed", "state_reason": "completed"},
                             "PATCH")
                    actions.append(f"closed #{open_issue['number']} ({key})")
                continue
            text = f"{body}\n\nLast checked {now:%Y-%m-%d %H:%M} UTC by [ops check]({run_url})."
            if open_issue:
                self.api(f"/issues/{open_issue['number']}", {"body": text}, "PATCH")
                actions.append(f"updated #{open_issue['number']} ({key})")
                continue
            recent = [i for i in same if i.get("closed_at") and now - parse_time(i["closed_at"]) < REOPEN_WINDOW]
            if recent:
                number = recent[-1]["number"]
                self.api(f"/issues/{number}", {"state": "open", "body": text}, "PATCH")
                actions.append(f"reopened #{number} ({key})")
                continue
            created = self.api("/issues", {"title": title, "body": text, "labels": [LABEL]}, "POST")
            if LABEL not in [label.get("name") for label in created.get("labels", [])]:
                # Unlabelled, the next run could not find it and would open another every 15 minutes.
                raise RuntimeError(f"issue #{created['number']} was created without the {LABEL} label")
            actions.append(f"opened #{created['number']} ({key})")
        return actions


def main():
    env = os.environ
    now = dt.datetime.now(dt.timezone.utc)
    failed = False
    findings = health_findings(probe_health(env.get("HEALTH_URL") or DEFAULT_HEALTH_URL))

    token, ref = env.get("SUPABASE_ACCESS_TOKEN"), env.get("SUPABASE_PROJECT_REF")
    if token and ref:
        try:
            findings.update(state_findings(read_state(ref, token)))
        except Exception as error:  # noqa: BLE001 — never print a response body or a header.
            print(f"ops check: database state unreadable ({type(error).__name__}); its issues are unchanged")
            failed = True
    else:
        print("ops check: database checks skipped (SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF not set)")

    for key, body in findings.items():
        print(f"ops check: {key}: {'ALERT' if body else 'ok'}")
    repo, github_token = env.get("GITHUB_REPOSITORY"), env.get("GITHUB_TOKEN")
    if not repo or not github_token:
        print("ops check: GITHUB_TOKEN / GITHUB_REPOSITORY not set, issues not filed")
    else:
        run_url = (f"{env.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/"
                   f"{env.get('GITHUB_RUN_ID', '')}")
        for line in GitHub(repo, github_token).sync(findings, now, run_url):
            print(f"ops check: {line}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
