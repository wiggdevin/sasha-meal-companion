#!/usr/bin/env python3
"""The zip half of the W4 release fingerprint (Sol W4 r3): what scripts/import-fdc.py stores for
each `fdc_fndds` revision, computed from the FNDDS CSVs with import-fdc.py's OWN helpers, so both
sides read the files the same way. Prints one JSON object per dish (FoodData Central id order):

  {"fdcId", "description", "nutrients": [[code, amount|null], ...], "portions": [[seq, label, grams, is_default], ...]}

nutrients: every NUTRIENT_MAP nutrient import-fdc.py stages for the food (`_staged_food_nutrient_rows`),
  the max amount per code as `_write_nutrients` keeps it (null when every staged amount is null).
  `energy_kcal_calc` is not here: the catalog derives it in SQL from these rows.
portions: `normalise_portions` over the food's staged portion rows, in `load_portions` order
  (seq_num nulls last, then the row id), with the measure unit's name joined.

Usage: python3 scripts/priors/fndds_release_rows.py <dir holding the FNDDS CSVs>
Standard library only (import-fdc.py imports psycopg and requests lazily).
"""
import csv
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("import_fdc", ROOT / "scripts" / "import-fdc.py")
fdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fdc)

SOURCE = "fdc_fndds"
DATA_TYPE = fdc.SOURCES[SOURCE].data_type


def main(csv_dir: Path) -> None:
    foods = {}
    for row in fdc._generic_rows(SOURCE, csv_dir / "food.csv", "food",
                                 ["fdc_id", "data_type", "description", "food_category_id"]):
        _, fdc_id, data_type, description, _cat = row
        if data_type == DATA_TYPE and description is not None:
            foods[fdc_id] = description

    amounts = defaultdict(lambda: defaultdict(list))
    for _, fdc_id, nutrient_id, amount in fdc._staged_food_nutrient_rows(SOURCE, csv_dir):
        if fdc_id in foods:
            amounts[fdc_id][fdc.NUTRIENT_MAP[nutrient_id].code].append(amount)

    units = {row[1]: row[2] for row in fdc._generic_rows(SOURCE, csv_dir / "measure_unit.csv", "measure_unit",
                                                         ["id", "name"])}
    columns = ["fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier", "gram_weight",
               "row_id"]
    staged = defaultdict(list)
    for row in fdc._staged_food_portion_rows(SOURCE, csv_dir, columns, {}):
        record = dict(zip(["source"] + columns, row))
        if record["fdc_id"] in foods:
            staged[record["fdc_id"]].append(record)

    for fdc_id in sorted(foods, key=int):
        nutrients = []
        for code in sorted(amounts[fdc_id]):
            present = [a for a in amounts[fdc_id][code] if a is not None]
            nutrients.append([code, repr(max(present)) if present else None])
        rows = sorted(staged[fdc_id], key=lambda r: (r["seq_num"] is None, r["seq_num"] or 0,
                                                    r["row_id"] is None, r["row_id"] or 0))
        portions = fdc.normalise_portions([{
            "seq_num": "" if r["seq_num"] is None else str(r["seq_num"]),
            "amount": r["amount"] or "", "unit_name": units.get(r["measure_unit_id"]) or "",
            "portion_description": r["portion_description"] or "", "modifier": r["modifier"] or "",
            "gram_weight": "" if r["gram_weight"] is None else repr(r["gram_weight"])} for r in rows])
        print(json.dumps({"fdcId": fdc_id, "description": foods[fdc_id], "nutrients": nutrients,
                          "portions": [[p["seq"], p["description"], repr(p["gram_weight"]), p["is_default"]]
                                       for p in portions]}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: fndds_release_rows.py <csv dir>")
    main(Path(sys.argv[1]))
