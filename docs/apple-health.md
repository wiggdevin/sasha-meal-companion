# Connect Apple Health

Apple Health stays on your iPhone, so Meal Companion needs either a free Shortcut or Health Auto
Export to send a daily summary. Settings shows when each connection last delivered data. A
connection code is shown once; copy it before you close the sheet.

Apple may delay either method while your phone is locked. Run the Shortcut or a Manual Export once
if the Settings row says the connection needs attention.

## Free Shortcut

In Settings → Health connections → Apple Health, create a connection code. If **Add Shortcut** is
available, open it and supply that code during setup. Otherwise build the Shortcut with these exact
actions:

1. Create a shortcut named **Send Health to Meal Companion**. Add **Text**, paste the one-time
   connection code, then add **Set Variable** named **Connection Code**. This stores it in the
   shortcut instead of asking during every automated run.
2. Add **Date** and leave it at **Current Date**; name its output **Now**. Add **Format Date** twice
   from Now: custom `yyyy-MM-dd'T'HH:mm:ssXXX` as **Sent At**, then custom `VV` as the IANA
   **Time Zone**.
3. Add **Adjust Date** with **Get Start of Day** from Now as **End**; add another **Adjust Date**
   subtracting one day from End as **Start**; add **Format Date** from Start with custom
   `yyyy-MM-dd` as **Local Day**.
4. For Steps, add **Find Health Samples**: Type **Steps**; Start Date is between Start and End;
   Source is Apple Watch when available, otherwise iPhone. Add **Get Details of Health Sample** →
   **Value**, **Get Numbers from Input**, then **Calculate Statistics** → **Sum**. Wrap it in **If**
   so an empty result adds nothing.
5. Repeat step 4 for **Active Energy**. If there is no Watch reading, omit it; never insert zero.
6. For weight, add **Find Health Samples**: Type **Body Mass**; use the same date window; Sort by
   Start Date, Latest First; Limit 1. Add **Get Details of Health Sample** → **Value**. Wrap it in
   **If**; use that one latest value, not a sum.
7. For each present metric, add a **Dictionary** with the fields in the JSON below, then
   **Add to Variable** named **Samples**. Stable `vendor_sample_id` is
   `shortcut:<type>:<Local Day>`; `vendor_updated_at` is Sent At so a rerun corrects that daily
   summary.
8. Add a top-level **Dictionary**, then **URL** with `/api/health/ingest`, then
   **Get Contents of URL**: Method **POST**; Request Body **JSON**; Header **Authorization** =
   `Bearer <Connection Code>`; Header **Content-Type** = `application/json`. Add **Show Result** for
   the first manual run.
9. Run once, allow Health access, and confirm `status: applied`. Then Automation → **Time of Day**
   at a time your phone is normally unlocked → **Run Shortcut** → choose this shortcut →
   **Run Immediately**.

Use this exact body for one completed local day. Omit an entire sample when Health has no result.

```json
{
  "source_kind": "apple_health_shortcut",
  "sent_at": "2026-09-20T08:15:00-06:00",
  "tz": "America/Denver",
  "samples": [
    {"type":"step_count","value":6241,"unit":"count","start_time":"2026-09-19T00:00:00-06:00","end_time":"2026-09-20T00:00:00-06:00","vendor_sample_id":"shortcut:step_count:2026-09-19","vendor_updated_at":"2026-09-20T08:15:00-06:00","device_label":"Apple Watch"},
    {"type":"active_energy","value":386,"unit":"kcal","start_time":"2026-09-19T00:00:00-06:00","end_time":"2026-09-20T00:00:00-06:00","vendor_sample_id":"shortcut:active_energy:2026-09-19","vendor_updated_at":"2026-09-20T08:15:00-06:00","device_label":"Apple Watch"},
    {"type":"body_mass","value":57.7,"unit":"kg","start_time":"2026-09-19T07:12:00-06:00","end_time":"2026-09-19T07:12:00-06:00","vendor_sample_id":"shortcut:body_mass:2026-09-19","vendor_updated_at":"2026-09-20T08:15:00-06:00","device_label":"Apple Health"}
  ]
}
```

`sent_at` must be within ten minutes of the request. A rerun keeps the same daily sample identity
and advances `vendor_updated_at`, so the newer summary replaces the older one.

## Health Auto Export

1. Install Health Auto Export and Premium. Grant **Steps**, **Active Energy**,
   **Weight & Body Mass**, and **Sleep Analysis**.
2. In Settings → Health connections → Apple Health, create and copy a connection code.
3. In Health Auto Export, choose Automations → Add Automation → **REST API**.
4. Set the endpoint to `/api/health/ingest`; Method **POST**; Format **JSON**; Header
   **Authorization** = `Bearer <Connection Code>`.
5. Choose Data Type **Health Metrics** and only the four metrics above.
6. Turn **Summarize Data** on. Choose Time Grouping **Day**, Date Range **Previous 7 Days**, and
   turn **Batch Requests** off.
7. Schedule it daily when your phone is normally unlocked or charging.
8. Run **Manual Export** once and confirm `status: applied`.

Premium is $1.99/month, $6.99/year, or $24.99 lifetime. Repeated seven-day summaries are safe:
each source/type/local-day has one identity, a later receipt replaces the older value, and the
server accepts an eight-day freshness window.
