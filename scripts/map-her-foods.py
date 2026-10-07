#!/usr/bin/env python3
"""
Propose one catalog row per seed and preset food, for Devin to review.

  pnpm exec tsx scripts/export-seed-foods.ts > /tmp/her-foods.json
  python3 scripts/map-her-foods.py --foods /tmp/her-foods.json \
      --out docs/catalog/her-foods-mapping.csv

This script PROPOSES. It writes no user row and sets no catalog_food_id. Devin fills the
`decision` column (`accept` or `reject`), correcting `source`/`source_id` in place when the
proposal is wrong, and Lane G's scripts/apply-food-mapping.ts applies the reviewed file.
The sheet carries the stable (source, source_id) key, never catalog_foods.id: that id is a
sequence assigned at import time and differs between the local dry run, a preview branch and
production, so a sheet keyed by it would only ever apply to the database it was generated on. The database connection is opened
read-only (`conn.read_only = True`) so no query in this script can write.

Ranking: trigram similarity on the active revision's description, rounded to two decimals so
near-ties fall through to the source rank Foundation > SR Legacy > FNDDS, then the shortest
description — the "shortest description wins" rule scripts/build-food-db.py already uses. A
final tiebreak on catalog_food_id keeps the pick deterministic across runs when two revisions
are otherwise identical.
"""

import argparse
import csv
import json
import os
import sys

MIN_SIMILARITY = 0.20
SOURCE_RANK = {"fdc_foundation": 0, "fdc_sr_legacy": 1, "fdc_fndds": 2}

COLUMNS = ["food_id", "name", "role", "source", "source_id", "proposed_description",
           "similarity", "decision", "reason"]

QUERY = """
select f.source, f.source_id, r.description,
       round(similarity(r.description, %(q)s)::numeric, 4) as sim
  from catalog_food_revisions r
  join catalog_foods f on f.id = r.catalog_food_id
 where r.is_active
   and similarity(r.description, %(q)s) > %(floor)s
 order by round(similarity(r.description, %(q)s)::numeric, 2) desc,
          case f.source when 'fdc_foundation' then 0
                        when 'fdc_sr_legacy' then 1 else 2 end,
          length(r.description),
          r.catalog_food_id
 limit 1
"""


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Propose catalog rows for her foods")
    p.add_argument("--db-url", default=os.environ.get("CATALOG_IMPORT_DB_URL"))
    p.add_argument("--foods", required=True, help="JSON from scripts/export-seed-foods.ts")
    p.add_argument("--out", default="docs/catalog/her-foods-mapping.csv")
    p.add_argument("--min-similarity", type=float, default=MIN_SIMILARITY)
    args = p.parse_args(argv)
    if not args.db_url:
        p.error("set --db-url or CATALOG_IMPORT_DB_URL")
    return args


def search_term(name: str) -> str:
    """Her names carry a preparation clause the catalog spells differently; keep both halves."""
    return name.replace(",", " ").replace("&", " ").strip()


def propose(cur, food, floor):
    cur.execute(QUERY, {"q": search_term(food["name"]), "floor": floor})
    hit = cur.fetchone()
    if hit is None:
        return {"food_id": food["food_id"], "name": food["name"], "role": food["role"],
                "source": "", "source_id": "", "proposed_description": "",
                "similarity": "", "decision": "",
                "reason": f"no active revision above similarity {floor}"}
    source, source_id, description, sim = hit
    return {"food_id": food["food_id"], "name": food["name"], "role": food["role"],
            "source": source, "source_id": source_id, "proposed_description": description,
            "similarity": f"{float(sim):.4f}", "decision": "",
            "reason": f"top trigram match, source rank {SOURCE_RANK.get(source, 9)}"}


def main(argv=None) -> int:
    import psycopg

    args = parse_args(argv)
    with open(args.foods, encoding="utf-8") as fh:
        foods = json.load(fh)
    rows = []
    # prepare_threshold=None: the branch's Postgres URL routes through Supabase's pooler in
    # transaction mode, which reassigns pooled backend connections between sessions and can
    # collide with psycopg's default server-side autoprepare (DuplicatePreparedStatement).
    with psycopg.connect(args.db_url, prepare_threshold=None) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            cur.execute("select count(*) from catalog_versions where is_active")
            if cur.fetchone()[0] == 0:
                raise SystemExit("no active catalog version; run scripts/import-fdc.py first")
            for food in foods:
                rows.append(propose(cur, food, args.min_similarity))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    unmatched = [r["food_id"] for r in rows if not r["source_id"]]
    print(f"{len(rows)} foods, {len(unmatched)} without a proposal", file=sys.stderr)
    for food_id in unmatched:
        print(f"  unmatched: {food_id}", file=sys.stderr)
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
