#!/usr/bin/env python3
"""
Import USDA FoodData Central bulk CSVs into the catalog_* tables (architecture §7.2).

download (checksum) -> catalog_staging.* (COPY) -> build revisions -> validate
  -> catalog_activate_version(version_label), all three sources under one label.

The worker runs on the Mac or in GitHub Actions with the service role, never on Vercel.

Usage:
  python3 scripts/import-fdc.py --version-label 2026-09-12
  python3 scripts/import-fdc.py --version-label 2026-09-12 --dry-run \
      --db-url postgres://postgres:postgres@localhost:5433/postgres
  python3 scripts/import-fdc.py --rollback-to 2026-06-01
"""

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

DOWNLOAD_ROOT = Path(os.path.expanduser("~/Backups/usda/fdc"))
USER_AGENT = "sasha-meal-companion/1.0 (catalog import)"


@dataclass(frozen=True)
class Source:
    key: str            # catalog_versions.source
    url: str
    quality_class: str  # architecture §4.1 quality_class vocabulary
    data_type: str       # food.csv data_type this source's own rows carry (others share the zip)


# VERIFY AT FIRST RUN: FDC publishes one dated zip per dataset and retires old links.
# Check https://fdc.nal.usda.gov/download-datasets and override with --url key=URL.
SOURCES = {
    "fdc_foundation": Source(
        "fdc_foundation",
        "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip",
        "analytical",
        "foundation_food",
    ),
    "fdc_sr_legacy": Source(
        "fdc_sr_legacy",
        "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip",
        "analytical",
        "sr_legacy_food",
    ),
    "fdc_fndds": Source(
        "fdc_fndds",
        "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip",
        "survey",
        "survey_fndds_food",
    ),
}


@dataclass(frozen=True)
class Nutrient:
    code: str          # catalog_nutrients.code — Phase 1-2 contracts §2
    name: str
    unit: str          # kcal | g | mg | µg
    group: str
    derivation: str    # measured | calculated | label


# FDC nutrient ids (nutrient.csv `id`, which food_nutrient.nutrient_id references).
# VERIFY AGAINST nutrient.csv AT FIRST RUN — assert_nutrient_ids() below does exactly that
# and fails the import rather than silently dropping a nutrient.
NUTRIENT_MAP = {
    1008: Nutrient("energy_kcal", "Energy", "kcal", "energy", "measured"),
    1003: Nutrient("protein", "Protein", "g", "macro", "measured"),
    1005: Nutrient("carbohydrate", "Carbohydrate, by difference", "g", "macro", "measured"),
    1004: Nutrient("fat_total", "Total lipid (fat)", "g", "macro", "measured"),
    1079: Nutrient("fiber_total", "Fiber, total dietary", "g", "macro", "measured"),
    2000: Nutrient("sugars_total", "Sugars, total including NLEA", "g", "macro", "measured"),
    1093: Nutrient("sodium", "Sodium, Na", "mg", "mineral", "measured"),
    1092: Nutrient("potassium", "Potassium, K", "mg", "mineral", "measured"),
    1087: Nutrient("calcium", "Calcium, Ca", "mg", "mineral", "measured"),
    1089: Nutrient("iron", "Iron, Fe", "mg", "mineral", "measured"),
    1090: Nutrient("magnesium", "Magnesium, Mg", "mg", "mineral", "measured"),
    1095: Nutrient("zinc", "Zinc, Zn", "mg", "mineral", "measured"),
    1162: Nutrient("vitamin_c", "Vitamin C, total ascorbic acid", "mg", "vitamin", "measured"),
    1114: Nutrient("vitamin_d", "Vitamin D (D2 + D3)", "µg", "vitamin", "measured"),
    1178: Nutrient("vitamin_b12", "Vitamin B-12", "µg", "vitamin", "measured"),
    1190: Nutrient("folate_dfe", "Folate, DFE", "µg", "vitamin", "measured"),
    1106: Nutrient("vitamin_a_rae", "Vitamin A, RAE", "µg", "vitamin", "measured"),
    1258: Nutrient("saturated_fat", "Fatty acids, total saturated", "g", "lipid", "measured"),
    1253: Nutrient("cholesterol", "Cholesterol", "mg", "lipid", "measured"),
}

# Other FDC ids that carry a mapped nutrient in some datasets (W004, audit A019/A022). FDC
# Foundation publishes most energy as Atwater General (2047) or Specific (2048) factors, not 1008,
# and most sugars as 1063 ("Sugars, Total", nbr 269.3), not 2000. Each code takes the first id in
# NUTRIENT_PRIORITY order that the food has a value for, so a food with 1008 keeps it, and only a
# food without one falls back (lib/catalog/fdc-map.ts also reads 1063 for branded rows). Aliases are
# optional: assert_nutrient_ids requires only NUTRIENT_MAP ids, and catalog_nutrients keeps one
# fdc_nutrient_id per code (the primary).
NUTRIENT_PRIORITY = {
    1008: (1008, 2047, 2048),
    2000: (2000, 1063),
}
NUTRIENT_ALIASES = {
    alias: primary
    for primary, ids in NUTRIENT_PRIORITY.items()
    for alias in ids if alias != primary
}


# select_amount's answer when a food staged no row for a code at all (so no row is written).
MISSING = object()


def nutrient_ids(primary_id: int) -> tuple:
    """Every FDC id that may carry this NUTRIENT_MAP nutrient, in priority order."""
    return NUTRIENT_PRIORITY.get(primary_id, (primary_id,))


def primary_nutrient_id(fdc_id: int):
    """The NUTRIENT_MAP id a mapped or alias FDC id stands for, or None."""
    if fdc_id in NUTRIENT_MAP:
        return fdc_id
    return NUTRIENT_ALIASES.get(fdc_id)


def select_amount(amounts_by_id: dict, primary_id: int):
    """What _write_nutrients stores for one food and one code, given its staged amounts per FDC id
    ({id: [amount|None, ...]}): the max amount of the first id in priority order that has a value;
    None (a stored null) when ids were staged but none has a value; the sentinel MISSING when no id
    was staged at all (no row is written). The Python twin of the SQL in _write_nutrients, used by
    scripts/priors/fndds_release_rows.py so the release fingerprint reads what the import stored."""
    staged = False
    for fdc_id in nutrient_ids(primary_id):
        if fdc_id not in amounts_by_id:
            continue
        staged = True
        present = [a for a in amounts_by_id[fdc_id] if a is not None]
        if present:
            return max(present)
    return None if staged else MISSING


# Not an FDC nutrient: catalog_atwater_kcal writes it (§3.1).
CALC_NUTRIENT = Nutrient(
    "energy_kcal_calc", "Energy, Atwater calculated", "kcal", "energy", "calculated"
)


def catalog_nutrient_rows():
    """Rows for catalog_nutrients(code, fdc_nutrient_id, name, unit, nutrient_group, derivation)."""
    rows = [(n.code, fdc_id, n.name, n.unit, n.group, n.derivation)
            for fdc_id, n in NUTRIENT_MAP.items()]
    rows.append((CALC_NUTRIENT.code, None, CALC_NUTRIENT.name, CALC_NUTRIENT.unit,
                 CALC_NUTRIENT.group, CALC_NUTRIENT.derivation))
    return rows


def assert_nutrient_ids(csv_dir: Path) -> None:
    """Every mapped FDC id must exist in this dataset's nutrient.csv, or the import stops."""
    path = csv_dir / "nutrient.csv"
    if not path.exists():
        raise SystemExit(f"{path} is missing; the zip layout changed")
    with open(path, newline="", encoding="utf-8-sig") as fh:
        present = {int(row["id"]) for row in csv.DictReader(fh) if row["id"].strip().isdigit()}
    missing = sorted(set(NUTRIENT_MAP) - present)
    if missing:
        raise SystemExit(
            f"nutrient.csv in {csv_dir} does not carry these mapped ids: {missing}. "
            "FDC renumbered a nutrient; fix NUTRIENT_MAP before importing."
        )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(source: Source, version_label: str, root: Path = DOWNLOAD_ROOT) -> Path:
    """Fetch the zip into ~/Backups/usda/fdc/<version_label>/ and record its sha256.

    A file already on disk is reused. A recorded digest that no longer matches is a hard
    failure: the source changed underneath a label, and the label must change with it.

    Streamed to a `.part` sibling and moved into place with os.replace only once the
    response completes, so an interrupted fetch never leaves a file the exists() check
    above later trusts as a complete download.
    """
    import requests  # local import so the pure helpers load without the dependency

    target_dir = root / version_label
    target_dir.mkdir(parents=True, exist_ok=True)
    zip_path = target_dir / f"{source.key}.zip"
    if not zip_path.exists():
        print(f"downloading {source.key} from {source.url}", file=sys.stderr)
        part_path = zip_path.with_suffix(".part")
        with requests.get(source.url, stream=True, timeout=300,
                          headers={"User-Agent": USER_AGENT}) as resp:
            resp.raise_for_status()
            with open(part_path, "wb") as fh:
                shutil.copyfileobj(resp.raw, fh)
        os.replace(part_path, zip_path)
    digest = sha256_file(zip_path)
    record = target_dir / "checksums.json"
    known = json.loads(record.read_text()) if record.exists() else {}
    if known.get(source.key) not in (None, digest):
        raise SystemExit(
            f"{source.key}: sha256 changed under label {version_label}; use a new label"
        )
    known[source.key] = digest
    record.write_text(json.dumps(known, indent=2, sort_keys=True) + "\n")
    print(f"{source.key} sha256 {digest}", file=sys.stderr)
    return zip_path


def extract(zip_path: Path, dest: Path) -> Path:
    """Unpack the zip flat into dest; FDC nests the CSVs one directory deep."""
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            name = Path(member).name
            if not name.endswith(".csv"):
                continue
            with zf.open(member) as src, open(dest / name, "wb") as out:
                shutil.copyfileobj(src, out)
    return dest


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Import FDC bulk CSVs into catalog_*")
    p.add_argument("--db-url", default=os.environ.get("CATALOG_IMPORT_DB_URL"),
                   help="Postgres URL; defaults to $CATALOG_IMPORT_DB_URL")
    p.add_argument("--version-label", help="one label for all three sources, e.g. 2026-09-12")
    p.add_argument("--sources", default=",".join(SOURCES),
                   help="comma-separated subset of " + ",".join(SOURCES))
    p.add_argument("--url", action="append", default=[], metavar="KEY=URL",
                   help="override a source URL (repeatable)")
    p.add_argument("--download-root", default=str(DOWNLOAD_ROOT))
    p.add_argument("--dry-run", action="store_true",
                   help="load and validate but do not call catalog_activate_version")
    p.add_argument("--rollback-to", metavar="LABEL",
                   help="reactivate a previous version_label and exit")
    args = p.parse_args(argv)
    if not args.db_url:
        p.error("set --db-url or CATALOG_IMPORT_DB_URL")
    if not args.rollback_to and not args.version_label:
        p.error("--version-label is required unless --rollback-to is given")
    return args


# catalog_staging is a throwaway landing zone, not a migration-owned table: every table is
# dropped and rebuilt on every run (fix round 2) so a shape change (e.g. the row_id column
# below) never strands an environment that already ran an older version of this worker on a
# manual ALTER. The schema itself survives (create schema if not exists) since it's still
# migration-owned; only the tables under it are throwaway.
STAGING_DDL = """
create schema if not exists catalog_staging;
drop table if exists catalog_staging.food cascade;
create table if not exists catalog_staging.food (
  source text not null, fdc_id text not null, data_type text, description text,
  food_category_id text, primary key (source, fdc_id));
drop table if exists catalog_staging.food_nutrient cascade;
create table if not exists catalog_staging.food_nutrient (
  source text not null, fdc_id text not null, nutrient_id integer not null, amount numeric);
drop table if exists catalog_staging.food_portion cascade;
create table if not exists catalog_staging.food_portion (
  source text not null, fdc_id text not null, seq_num integer, amount text,
  measure_unit_id text, portion_description text, modifier text, gram_weight numeric,
  row_id integer);
drop table if exists catalog_staging.measure_unit cascade;
create table if not exists catalog_staging.measure_unit (
  source text not null, id text not null, name text, primary key (source, id));
drop table if exists catalog_staging.food_category cascade;
create table if not exists catalog_staging.food_category (
  source text not null, id text not null, description text, primary key (source, id));
create index if not exists staging_food_nutrient_key
  on catalog_staging.food_nutrient (source, fdc_id);
create index if not exists staging_food_portion_key
  on catalog_staging.food_portion (source, fdc_id);
"""

# (csv file, staging table, staging columns, csv columns, required). A missing optional file is
# skipped with a warning: not every FDC zip carries measure_unit.csv or food_category.csv.
# food_portion's csv_columns (4th element) is not read by its loader (_staged_food_portion_rows
# reads columns off `row` directly and handles "id" -> row_id itself), so it stays identical to
# the staging columns list minus row_id - nothing to keep in sync there.
STAGING_LOADS = [
    ("food.csv", "food",
     ["fdc_id", "data_type", "description", "food_category_id"],
     ["fdc_id", "data_type", "description", "food_category_id"], True),
    ("food_nutrient.csv", "food_nutrient",
     ["fdc_id", "nutrient_id", "amount"],
     ["fdc_id", "nutrient_id", "amount"], True),
    ("food_portion.csv", "food_portion",
     ["fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description",
      "modifier", "gram_weight", "row_id"],
     ["fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description",
      "modifier", "gram_weight"], False),
    ("measure_unit.csv", "measure_unit", ["id", "name"], ["id", "name"], False),
    ("food_category.csv", "food_category", ["id", "description"], ["id", "description"], False),
]

NUMERIC_COLUMNS = {"gram_weight"}
INTEGER_COLUMNS = {"nutrient_id", "seq_num"}


def _numeric_or_none(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _staging_value(table, column, raw):
    """One CSV cell -> one staging column value. amount is text in food_portion, numeric elsewhere."""
    if column in INTEGER_COLUMNS:
        number = _numeric_or_none(raw)
        return int(number) if number is not None else None
    if column in NUMERIC_COLUMNS or (column == "amount" and table != "food_portion"):
        return _numeric_or_none(raw)
    return raw or None


def _nutrient_nbr_key(value):
    """Exact key for a nutrient_nbr: a normalized Decimal, never a lossy int/float cast.
    nutrient.csv has nbrs that differ only by a decimal suffix - 205 "Carbohydrate, by
    difference" vs 205.2 "Carbohydrate, by summation" - and int(float(...)) collides both
    onto 205, silently losing whichever row loads second."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        return Decimal(value).normalize()
    except InvalidOperation:
        return None


def _nutrient_nbr_map(csv_dir: Path) -> dict:
    """{nutrient_nbr (exact Decimal key): id} from this source's nutrient.csv. Foundation/
    SR Legacy already number food_nutrient.nutrient_id by nutrient.csv's id; FNDDS instead
    carries the legacy nutrient_nbr there, so a food_nutrient row needs this to resolve."""
    path = csv_dir / "nutrient.csv"
    if not path.exists():
        raise SystemExit(f"{path} is missing; the zip layout changed")
    mapping = {}
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            nbr = _nutrient_nbr_key(row.get("nutrient_nbr"))
            rid = _numeric_or_none(row.get("id"))
            if nbr is not None and rid is not None:
                mapping[nbr] = int(rid)
    return mapping


def _resolve_nutrient_id(raw_nutrient_id, nbr_map: dict):
    """A food_nutrient row's raw nutrient_id -> the NUTRIENT_MAP key it means, or None to
    skip. Tried two ways, both exact (never a lossy cast): the value itself when it is
    already a whole-number NUTRIENT_MAP id (Foundation/SR Legacy), else its exact
    nutrient_nbr match in nbr_map (FNDDS). Either way the resolved id must itself be a
    NUTRIENT_MAP key or one of its NUTRIENT_ALIASES (kept as the raw id, so _write_nutrients can
    apply NUTRIENT_PRIORITY), or the row names a nutrient this app does not track and is skipped."""
    key = _nutrient_nbr_key(raw_nutrient_id)
    if key is None:
        return None
    if key == key.to_integral_value():
        candidate = int(key)
        if primary_nutrient_id(candidate) is not None:
            return candidate
    candidate = nbr_map.get(key)
    return candidate if candidate is not None and primary_nutrient_id(candidate) is not None else None


def _staged_food_nutrient_rows(source_key: str, csv_dir: Path):
    """Stream (source, fdc_id, nutrient_id, amount) rows ready for COPY: nutrient_id
    translated via this source's nutrient.csv when needed, then filtered to NUTRIENT_MAP —
    98 % of food_nutrient.csv is nutrients this app does not track."""
    nbr_map = _nutrient_nbr_map(csv_dir)
    with open(csv_dir / "food_nutrient.csv", newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            resolved = _resolve_nutrient_id(row.get("nutrient_id"), nbr_map)
            if resolved is None:
                continue
            yield [
                source_key,
                (row.get("fdc_id") or "").strip() or None,
                resolved,
                _staging_value("food_nutrient", "amount", (row.get("amount") or "").strip()),
            ]


def _staged_food_portion_rows(source_key: str, csv_dir: Path, columns: list, counts: dict):
    """Stream food_portion rows ready for COPY, skipping any with a blank fdc_id (they can
    join to no food) and recording the count under counts['portions_skipped_no_fdc_id'].

    `row_id` (CSV column "id", the FDC row's own primary key) is read separately from the
    other columns and appended last: load_portions needs it as a final ORDER BY tiebreak so
    portion order never depends on an unspecified table scan order."""
    skipped = 0
    with open(csv_dir / "food_portion.csv", newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            if not (row.get("fdc_id") or "").strip():
                skipped += 1
                continue
            values = [
                _staging_value("food_portion", col, (row.get(col) or "").strip())
                for col in columns if col != "row_id"
            ]
            row_id = _numeric_or_none(row.get("id"))
            values.append(int(row_id) if row_id is not None else None)
            yield [source_key] + values
    counts["portions_skipped_no_fdc_id"] = skipped


def _generic_rows(source_key: str, path: Path, table: str, columns: list):
    """Stream rows for a table with no source-specific handling: food, measure_unit,
    food_category."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            yield [source_key] + [
                _staging_value(table, col, (row.get(col) or "").strip()) for col in columns
            ]


def _copy_rows(cur, table: str, columns: list, rows) -> int:
    """Run one COPY ... FROM STDIN over an already-prepared row generator."""
    target = ", ".join(["source"] + columns)
    written = 0
    with cur.copy(f"copy catalog_staging.{table} ({target}) from stdin") as cp:
        for values in rows:
            cp.write_row(values)
            written += 1
    return written


def stage_source(conn, source_key: str, csv_dir: Path) -> dict:
    """COPY one dataset's CSVs into catalog_staging, replacing anything already there."""
    counts = {}
    with conn.cursor() as cur:
        cur.execute(STAGING_DDL)
        for filename, table, columns, csv_columns, required in STAGING_LOADS:
            path = csv_dir / filename
            if not path.exists():
                if required:
                    raise SystemExit(f"{path} is missing; the zip layout changed")
                print(f"  {filename}: absent, skipped", file=sys.stderr)
                counts[table] = 0
                continue
            if table == "food_nutrient":
                rows = _staged_food_nutrient_rows(source_key, csv_dir)
            elif table == "food_portion":
                rows = _staged_food_portion_rows(source_key, csv_dir, columns, counts)
            else:
                rows = _generic_rows(source_key, path, table, csv_columns)
            counts[table] = _copy_rows(cur, table, columns, rows)
            print(f"  {filename}: {counts[table]} rows", file=sys.stderr)
    return counts


# §4.1 scores prep_state_match at 0.5 when the revision has none, so an unreadable description
# must fall through to null rather than guess. Order matters: the first match wins.
# 'canned' and 'dried' descriptions fall through to null (scored 0.5, neutral) rather than a value
# the DDL check no longer accepts - contracts §3's PrepState has no member for either (Lane G Open
# question 2). 'baked' is not a distinct branch either: it already folds into 'roasted' below and
# was never a literal output.
# Fix round 1: Postgres's regex engine (ARE) reads \b as a literal backspace character, not a
# word boundary - \y is the word-boundary anchor there. \b matched nothing on real data (verified:
# every one of 101,207 real revisions got prep_state null); \y is the correct anchor.
PREP_STATE_CASE = r"""
case
  when lower(s.description) ~ '\yraw\y'                          then 'raw'
  when lower(s.description) ~ '\y(roasted|baked)\y'              then 'roasted'
  when lower(s.description) ~ '\ygrilled\y'                      then 'grilled'
  when lower(s.description) ~ '\y(fried|pan-fried|deep fried)\y' then 'fried'
  when lower(s.description) ~ '\y(boiled|simmered|poached)\y'    then 'boiled'
  when lower(s.description) ~ '\y(cooked|braised|steamed|broiled|stewed)\y' then 'cooked'
  else null end"""


def _write_version_and_foods(cur, source: Source, version_label: str) -> int:
    cur.execute(
        """insert into catalog_versions (source, version_label) values (%s, %s)
           on conflict (source, version_label) do nothing""",
        (source.key, version_label))
    cur.execute("select id from catalog_versions where source = %s and version_label = %s",
                (source.key, version_label))
    version_id = cur.fetchone()[0]
    cur.executemany(
        """insert into catalog_nutrients
             (code, fdc_nutrient_id, name, unit, nutrient_group, derivation)
           values (%s, %s, %s, %s, %s, %s) on conflict (code) do nothing""",
        catalog_nutrient_rows())
    # Identity is (source, source_id) and is never rewritten (§3.1). Scoped to this source's own
    # data_type: a bulk zip's food.csv carries other row kinds too (e.g. Foundation's food.csv is
    # mostly sub_sample_food/market_acquisition/sample_food/agricultural_acquisition rows, not
    # foundation_food) and those are not foods this catalog should carry.
    cur.execute(
        """insert into catalog_foods (source, source_id)
           select %s, s.fdc_id from catalog_staging.food s
            where s.source = %s and s.data_type = %s
           on conflict (source, source_id) do nothing""",
        (source.key, source.key, source.data_type))
    return version_id


def _write_revisions(cur, source: Source, version_id: int) -> None:
    # search_doc is NOT a generated column (frozen contract) - the insert writes it itself via
    # the immutable catalog_search_doc(description, brand, category) helper (migration 090000).
    # brand is null for FDC bulk: none of the three bulk CSVs carry a brand column.
    # Scoped to this source's own data_type (see _write_version_and_foods): catalog_foods already
    # carries only that data_type's fdc_ids, so this filter is belt-and-suspenders on the same
    # staged row rather than a different set - kept explicit so the revision insert stays correct
    # on its own if catalog_foods is ever populated some other way.
    cur.execute(
        f"""insert into catalog_food_revisions
              (catalog_food_id, catalog_version_id, description, brand, category,
               prep_state, quality_class, quality_flags, content_hash, is_active, search_doc)
            -- content_hash covers description and category only - a description/category
            -- change hash, not a full revision hash. Nutrients, portions and prep_state are
            -- not part of it, so a nutrient-only or portion-only revision keeps the same hash.
            select f.id, %s, s.description, null, c.description,
                   {PREP_STATE_CASE}, %s, '{{}}'::text[],
                   md5(coalesce(s.description, '') || '|' || coalesce(c.description, '')),
                   false, catalog_search_doc(s.description, null, c.description)
              from catalog_staging.food s
              join catalog_foods f on f.source = %s and f.source_id = s.fdc_id
              left join catalog_staging.food_category c
                     on c.source = s.source and c.id = s.food_category_id
             where s.source = %s and s.data_type = %s and s.description is not null
            on conflict (catalog_food_id, catalog_version_id) do nothing""",
        (version_id, source.quality_class, source.key, source.key, source.data_type))


NUTRIENT_INSERT_SQL = """insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
           select distinct on (r.id) r.id, %s, s.amount
             from catalog_staging.food_nutrient s
             join catalog_foods f on f.source = %s and f.source_id = s.fdc_id
             join catalog_food_revisions r
               on r.catalog_food_id = f.id and r.catalog_version_id = %s
            where s.source = %s and s.nutrient_id = any(%s::integer[])
            order by r.id, (s.amount is null), array_position(%s::integer[], s.nutrient_id),
                     s.amount desc
           on conflict (food_revision_id, nutrient_code) do update
             set amount_per_100g = excluded.amount_per_100g"""


def _write_nutrients(cur, source: Source, version_id: int) -> None:
    # FDC bulk amounts are already per 100 g. One value per revision and code: the first FDC id in
    # NUTRIENT_PRIORITY order with a value (1008 before 2047 before 2048; 2000 before 1063), its max
    # when the row is duplicated (rare, FNDDS); null only when every staged amount is null.
    # select_amount is the Python twin.
    cur.executemany(
        NUTRIENT_INSERT_SQL,
        [(n.code, source.key, version_id, source.key, list(nutrient_ids(fdc_id)),
          list(nutrient_ids(fdc_id)))
         for fdc_id, n in NUTRIENT_MAP.items()])
    # Energy, once, in SQL (§3.1). One call per revision is deliberate: the spec forbids a
    # second Atwater implementation, and the import is a quarterly job.
    cur.execute(
        """insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
           select r.id, 'energy_kcal_calc', a.kcal
             from catalog_food_revisions r, lateral catalog_atwater_kcal(r.id) a
            where r.catalog_version_id = %s and a.complete
           on conflict (food_revision_id, nutrient_code) do update
             set amount_per_100g = excluded.amount_per_100g""",
        (version_id,))


def _write_quality_flags(cur, version_id: int) -> None:
    # §3.1: atwater_incomplete (a macro is missing), carb_basis_total (no fiber reported, so
    # carbohydrate is total not available), energy_mismatch (reported vs computed above 10 %).
    cur.execute(
        """with vals as (
             select r.id,
                    max(n.amount_per_100g) filter (where n.nutrient_code = 'energy_kcal') as rep,
                    max(n.amount_per_100g) filter (where n.nutrient_code = 'energy_kcal_calc') as calc,
                    bool_or(n.nutrient_code = 'fiber_total'
                            and n.amount_per_100g is not null) as has_fiber,
                    bool_or(n.nutrient_code = 'carbohydrate'
                            and n.amount_per_100g is not null) as has_carb
               from catalog_food_revisions r
               left join catalog_food_nutrients n on n.food_revision_id = r.id
              where r.catalog_version_id = %s
              group by r.id)
           update catalog_food_revisions r
              set quality_flags = (
                    case when v.calc is null then array['atwater_incomplete'] else '{}' end
                 || case when v.has_carb and not coalesce(v.has_fiber, false)
                         then array['carb_basis_total'] else '{}' end
                 || case when v.calc is not null and v.rep is not null and v.rep > 0
                          and abs(v.rep - v.calc) / v.rep > 0.10
                         then array['energy_mismatch'] else '{}' end)::text[]
             from vals v where v.id = r.id""",
        (version_id,))


def build_source(conn, source: Source, version_label: str) -> int:
    """Write the version, foods, revisions, nutrients and flags for one dataset. Never activates."""
    with conn.cursor() as cur:
        version_id = _write_version_and_foods(cur, source, version_label)
        _write_revisions(cur, source, version_id)
        _write_nutrients(cur, source, version_id)
        _write_quality_flags(cur, version_id)
    return version_id


UNITLESS = {"", "undetermined", "na", "none"}


def portion_label(amount: str, unit: str, description: str, modifier: str) -> str:
    """One household measure, the way build-food-db.py already reads FDC portion columns."""
    amount = (amount or "").strip()
    if "." in amount:
        amount = amount.rstrip("0").rstrip(".")
    unit = (unit or "").strip()
    if unit.lower() in UNITLESS:
        unit = ""
    parts = [amount, unit, (description or "").strip(), (modifier or "").strip()]
    return re.sub(r"\s+", " ", " ".join(p for p in parts if p)).strip()


# A generic gram unit is not a household measure: "100 g" never becomes is_default, even
# when it sorts first (fix round 1, Important #2).
GRAM_UNITS = {"g", "gram", "grams", "gm"}


def normalise_portions(rows):
    """FDC food_portion rows for one food -> catalog_portions rows.

    Keeps gram-weighted household measures only, orders them by the source seq_num (rows
    without one sort last), then by label, gram_weight and finally the row's position in
    `rows` - a full tiebreak chain so a tie on (seq_num, label) resolves the same way on
    every rerun regardless of what order the caller's rows arrive in (fix round 1,
    Important #1). Numbers the kept rows from 1 and marks the FIRST ELIGIBLE one default -
    eligible means not a generic gram unit (GRAM_UNITS); if every kept row is a gram unit,
    no row is marked default. is_default is the first gram-weighted HOUSEHOLD measure.
    """
    kept = []
    for index, row in enumerate(rows):
        grams = _numeric_or_none(row.get("gram_weight"))
        # Round before the > 0 filter (fix round 1, minor #3): a value in (0, 0.005) must be
        # dropped, not written as a misleading 0.00.
        grams = round(grams, 2) if grams is not None else None
        if grams is None or grams <= 0:
            continue
        label = portion_label(row.get("amount", ""), row.get("unit_name", ""),
                              row.get("portion_description", ""), row.get("modifier", ""))
        if not label:
            continue
        seq_num = _numeric_or_none(row.get("seq_num"))
        unit = (row.get("unit_name") or "").strip().lower()
        # seq_num 0 is a real, present value - "if seq_num" would treat it as falsy and sort
        # it last with the rows that carry no seq_num at all. Test explicitly for None.
        kept.append({"order": int(seq_num) if seq_num is not None else 10 ** 6,
                     "description": label, "gram_weight": grams,
                     "is_gram_unit": unit in GRAM_UNITS, "index": index})
    kept.sort(key=lambda r: (r["order"], r["description"], r["gram_weight"], r["index"]))
    default_seq = next(
        (i for i, r in enumerate(kept, start=1) if not r["is_gram_unit"]), None)
    return [{"seq": i, "description": r["description"], "gram_weight": r["gram_weight"],
             "is_default": i == default_seq}
            for i, r in enumerate(kept, start=1)]


def load_portions(conn, source: Source, version_id: int) -> int:
    """Read this version's portions out of staging, normalise in Python, COPY them back.

    Ordered by (revision, seq_num, row_id) so the rows handed to normalise_portions arrive
    in the same order on every rerun - row_id (the FDC row's own primary key, staged as
    catalog_staging.food_portion.row_id) is the tiebreak of last resort when two portions
    share a seq_num (fix round 1, Important #1).
    """
    written = 0
    with conn.cursor() as read_cur, conn.cursor() as write_cur:
        read_cur.execute(
            """select r.id, p.seq_num, p.amount, coalesce(u.name, ''), p.portion_description,
                      p.modifier, p.gram_weight
                 from catalog_staging.food_portion p
                 join catalog_foods f on f.source = %s and f.source_id = p.fdc_id
                 join catalog_food_revisions r
                   on r.catalog_food_id = f.id and r.catalog_version_id = %s
                 left join catalog_staging.measure_unit u
                        on u.source = p.source and u.id = p.measure_unit_id
                where p.source = %s
                order by r.id, p.seq_num nulls last, p.row_id""",
            (source.key, version_id, source.key))
        by_revision = defaultdict(list)
        for rev_id, seq_num, amount, unit, desc, modifier, grams in read_cur:
            by_revision[rev_id].append({
                "seq_num": "" if seq_num is None else str(seq_num),
                "amount": amount or "", "unit_name": unit or "",
                "portion_description": desc or "", "modifier": modifier or "",
                "gram_weight": "" if grams is None else str(grams)})
        write_cur.execute(
            """delete from catalog_portions where food_revision_id in
                 (select id from catalog_food_revisions where catalog_version_id = %s)""",
            (version_id,))
        copy_sql = ("copy catalog_portions "
                    "(food_revision_id, description, gram_weight, seq, is_default) from stdin")
        with write_cur.copy(copy_sql) as cp:
            for rev_id, rows in by_revision.items():
                for row in normalise_portions(rows):
                    cp.write_row([rev_id, row["description"], row["gram_weight"],
                                  row["seq"], row["is_default"]])
                    written += 1
    print(f"  portions: {written} rows", file=sys.stderr)
    return written


# Floors, not targets: a dataset that shrinks past these has been truncated on the way in.
# MIN_ROWS is the only HARD gate (assert_gates raises SystemExit on a breach). Fix round 1
# (controller ruling, ledgered): docs/specs/phase-1-catalog.md makes energy_mismatch a per-row
# flag and requires the worker to report the rate (row_counts / sizing.md); it never makes the
# rate or macro coverage an abort. So MIN_MACRO_COVERAGE and MAX_MISMATCH_RATE are SOFT
# thresholds — a breach is reported (a stderr warning line, plus report["warnings"], persisted
# into catalog_versions.row_counts) but never stops the import.
MIN_ROWS = {"fdc_foundation": 300, "fdc_sr_legacy": 7000, "fdc_fndds": 5000}
MIN_MACRO_COVERAGE = 0.90   # soft: revisions carrying protein, carbohydrate and fat_total
MAX_MISMATCH_RATE = 0.10    # soft: §3.1 — a gap above 10 % is a flag, not a failure


def validate(conn, version_id: int) -> dict:
    """Row counts, macro coverage and the energy-mismatch rate for one version."""
    with conn.cursor() as cur:
        cur.execute(
            """select count(*),
                      count(*) filter (where 'energy_mismatch' = any(quality_flags)),
                      count(*) filter (where 'atwater_incomplete' = any(quality_flags))
                 from catalog_food_revisions where catalog_version_id = %s""",
            (version_id,))
        revisions, mismatched, incomplete = cur.fetchone()
        cur.execute(
            """select count(*) from (
                 select r.id from catalog_food_revisions r
                   join catalog_food_nutrients n on n.food_revision_id = r.id
                  where r.catalog_version_id = %s and n.amount_per_100g is not null
                    and n.nutrient_code in ('protein','carbohydrate','fat_total')
                  group by r.id having count(*) = 3) x""",
            (version_id,))
        with_macros = cur.fetchone()[0]
        cur.execute(
            """select count(*) from catalog_portions
                where food_revision_id in
                      (select id from catalog_food_revisions where catalog_version_id = %s)""",
            (version_id,))
        portions = cur.fetchone()[0]
    complete = max(revisions - incomplete, 1)
    return {
        "revisions": revisions,
        "portions": portions,
        "with_macros": with_macros,
        "macro_coverage": round(with_macros / max(revisions, 1), 4),
        "atwater_incomplete": incomplete,
        "energy_mismatch": mismatched,
        "energy_mismatch_rate": round(mismatched / complete, 4),
    }


def assert_gates(source: Source, report: dict) -> None:
    """MIN_ROWS is fatal (SystemExit). MIN_MACRO_COVERAGE / MAX_MISMATCH_RATE are soft: a
    breach is printed as a stderr warning and appended to report["warnings"] (which import_one
    then persists into catalog_versions.row_counts), but the import continues."""
    floor = MIN_ROWS[source.key]
    if report["revisions"] < floor:
        raise SystemExit(f"{source.key}: {report['revisions']} revisions, floor is {floor}")
    warnings = []
    if report["macro_coverage"] < MIN_MACRO_COVERAGE:
        warnings.append(
            f"{source.key}: macro coverage {report['macro_coverage']} below {MIN_MACRO_COVERAGE}")
    if report["energy_mismatch_rate"] > MAX_MISMATCH_RATE:
        warnings.append(
            f"{source.key}: energy mismatch rate {report['energy_mismatch_rate']} "
            f"above {MAX_MISMATCH_RATE}")
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    report["warnings"] = warnings


def already_active(conn, label: str, source_keys) -> bool:
    """A second run of the same label is a no-op (acceptance criterion 3)."""
    keys = list(source_keys)
    with conn.cursor() as cur:
        cur.execute(
            """select count(*) from catalog_versions
                where version_label = %s and is_active and source = any(%s)""",
            (label, keys))
        return cur.fetchone()[0] == len(keys)


def rollback(conn, label: str) -> None:
    with conn.cursor() as cur:
        cur.execute("select count(*) from catalog_versions where version_label = %s", (label,))
        if cur.fetchone()[0] == 0:
            raise SystemExit(f"no catalog_versions row carries label {label}")
        cur.execute("select catalog_activate_version(%s)", (label,))
    conn.commit()
    print(f"rolled back to {label}", file=sys.stderr)


def fetch_one(args, key: str, overrides: dict) -> tuple:
    """Download and extract one source's zip and verify its nutrient ids. No DB connection
    needed - this is the HTTP-bound half of an import, kept out of the transaction below."""
    base = SOURCES[key]
    source = Source(base.key, overrides.get(key, base.url), base.quality_class, base.data_type)
    print(f"== {key}", file=sys.stderr)
    zip_path = download(source, args.version_label, Path(args.download_root))
    csv_dir = extract(zip_path, Path(args.download_root) / args.version_label / key)
    assert_nutrient_ids(csv_dir)
    return source, csv_dir


def import_one(conn, source: Source, csv_dir: Path, version_label: str) -> dict:
    """Stage, build, load portions and validate one already-fetched source. DB-only: no HTTP."""
    stage_source(conn, source.key, csv_dir)
    version_id = build_source(conn, source, version_label)
    load_portions(conn, source, version_id)
    report = validate(conn, version_id)
    assert_gates(source, report)
    with conn.cursor() as cur:
        cur.execute("update catalog_versions set row_counts = %s where id = %s",
                    (json.dumps(report), version_id))
    print(f"  {json.dumps(report)}", file=sys.stderr)
    return report


def main(argv=None) -> int:
    import psycopg

    args = parse_args(argv)
    overrides = dict(pair.split("=", 1) for pair in args.url)
    keys = [k.strip() for k in args.sources.split(",") if k.strip()]
    for key in keys:
        if key not in SOURCES:
            raise SystemExit(f"unknown source {key}; choose from {', '.join(SOURCES)}")

    # Download and extract every requested source before opening the DB connection, so no
    # HTTP time is spent idle-in-transaction below.
    fetched = {} if args.rollback_to else {key: fetch_one(args, key, overrides) for key in keys}

    try:
        conn = psycopg.connect(args.db_url, autocommit=False)
    except (psycopg.Error, OSError) as exc:
        # Never str(exc) or args.db_url here: psycopg's OperationalError text often echoes the
        # DSN (host, user, even a password) verbatim - only the exception's class name is safe.
        raise SystemExit(
            f"database connection failed: {type(exc).__name__} "
            "(details withheld; check CATALOG_IMPORT_DB_URL)"
        ) from None

    with conn:
        if args.rollback_to:
            rollback(conn, args.rollback_to)
            return 0
        if already_active(conn, args.version_label, keys):
            print(f"{args.version_label} is already active; nothing to do", file=sys.stderr)
            return 0

        reports = {key: import_one(conn, source, csv_dir, args.version_label)
                   for key, (source, csv_dir) in fetched.items()}

        if args.dry_run:
            conn.commit()
            print("dry run: rows loaded, version NOT activated", file=sys.stderr)
        else:
            with conn.cursor() as cur:
                cur.execute("select catalog_activate_version(%s)", (args.version_label,))
            conn.commit()
            print(f"activated {args.version_label}", file=sys.stderr)
        print(json.dumps(reports, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
