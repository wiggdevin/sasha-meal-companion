# Catalog receipts

A receipt is the sanitized stdout of one named command — who ran it, when, and against which
Supabase project — saved next to the number it backs. It is the only thing that turns a number into
evidence: a figure quoted in a doc, a spec or a ruling without a receipt beside it is a **claim**,
not a measurement, and it says nothing about who ran what or whether it is current. Sanitizing
removes credentials (API keys, passwords) but never rows, counts, timings or failure lines; the
command, the operator and the project are recorded in the header.

The receipts here are all from 2026-09-12, run by the driver (Claude Fable 5 session) against
production project `fivatgdpuenszxxnijpc`: `2026-09-12-production-import.txt` (psql counts after
`scripts/import-fdc.py` and `scripts/load-synonyms.ts`), and
`2026-09-12-search-eval-production-run1.txt` / `…-run2.txt` (the two `scripts/search-eval.ts --dry-run`
runs, before and after the synonym load).
