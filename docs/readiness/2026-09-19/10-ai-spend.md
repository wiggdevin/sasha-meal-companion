# 10 — AI spend, last 24 hours

**Outcome:** proved

- `AI_DAILY_SPEND_CAP_USD` is present in the Vercel production environment.
- Configured cap: **$2.00/day**.
- Production `ai_calls`, rolling 24 hours, queried read-only:

| Provider | Calls | Input tokens | Output tokens | Cost |
|---|---:|---:|---:|---:|
| `google` | 5 | 29,527 | 1,149 | $0.026454 |

Calculation:

- Total spend: **$0.026454**.
- Cap utilization: `$0.026454 / $2.00 × 100` = **1.3227%**.
- Remaining headroom: **$1.973546** (98.6773%).

No AI request was made for this check; it used existing accounting rows only.
