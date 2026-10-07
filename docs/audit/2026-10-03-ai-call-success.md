# AI call success by purpose and model — 7 days to 2026-10-03

Source: `pnpm timings:ai --days 7 --by-model` (ai_calls, read-only).

| purpose · model | ok | total | success |
|---|---:|---:|---:|
| coach google/gemini-3.6-flash | 23 | 35 | 66% |
| coach google/gemini-3.8-flash | 4 | 7 | 57% |
| coach-intent typesafe/jev-1.13.0 | 44 | 44 | 100% |
| coach-openrouter openrouter/anthropic/claude-haiku-4.5 | 0 | 2 | 0% |
| coach-openrouter openrouter/google/gemini-2.5-flash | 44 | 46 | 96% |
| coach-openrouter openrouter/google/gemini-3-flash-preview | 3 | 5 | 60% |
| coach-verify typesafe/jev-1.13.0 | 20 | 20 | 100% |
| food_facets typesafe/jev-1.13.0 | 32 | 32 | 100% |
| log_sanity typesafe/jev-1.13.0 | 1 | 1 | 100% |
| suggest-options typesafe/jev-1.13.0 | 6 | 6 | 100% |
| suggest-options typesafe/jev-latest | 0 | 3 | 0% |
| textToItems google/gemini-3.6-flash | 1 | 1 | 100% |
| textToItems google/gemini-3.8-flash | 0 | 3 | 0% |
| weeklyReview google/gemini-3.6-flash | 3 | 3 | 100% |

**Action taken:** text/photo/label capture moved from direct Gemini to OpenRouter (textToItems 0/3, all ~19 s timeouts). Coach already moved (OpenRouter gemini-2.5-flash 44/46, p50 2.4 s).
