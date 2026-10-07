"""Unit tests for the pure parts of scripts/import-fdc.py.

Run either way:
    python3 -m pytest tests/catalog/test_import_fdc.py
    python3 -m unittest tests.catalog.test_import_fdc
"""

import contextlib
import hashlib
import importlib.util
import inspect
import io
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load_worker():
    spec = importlib.util.spec_from_file_location("import_fdc", ROOT / "scripts" / "import-fdc.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fdc = load_worker()


class SourceRegistry(unittest.TestCase):
    def test_three_bulk_sources_with_catalog_source_keys(self):
        self.assertEqual(sorted(fdc.SOURCES), ["fdc_fndds", "fdc_foundation", "fdc_sr_legacy"])

    def test_quality_class_matches_the_spec(self):
        self.assertEqual(fdc.SOURCES["fdc_foundation"].quality_class, "analytical")
        self.assertEqual(fdc.SOURCES["fdc_sr_legacy"].quality_class, "analytical")
        self.assertEqual(fdc.SOURCES["fdc_fndds"].quality_class, "survey")

    def test_data_type_matches_each_source_s_own_food_csv_rows(self):
        # A bulk zip's food.csv is not one data_type: Foundation's, for example, is mostly
        # sub_sample_food/market_acquisition/sample_food/agricultural_acquisition rows, not
        # foundation_food. Each source must name only the data_type that is its own real foods.
        self.assertEqual(fdc.SOURCES["fdc_foundation"].data_type, "foundation_food")
        self.assertEqual(fdc.SOURCES["fdc_sr_legacy"].data_type, "sr_legacy_food")
        self.assertEqual(fdc.SOURCES["fdc_fndds"].data_type, "survey_fndds_food")


class Checksums(unittest.TestCase):
    def test_sha256_file_matches_hashlib(self):
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(b"chicken thigh, roasted")
            path = pathlib.Path(fh.name)
        self.assertEqual(
            fdc.sha256_file(path), hashlib.sha256(b"chicken thigh, roasted").hexdigest()
        )
        path.unlink()


class Download(unittest.TestCase):
    def test_interrupted_download_never_leaves_a_trusted_partial_zip(self):
        # download() streams to a .part sibling and only os.replace()s it into place once the
        # response completes. A connection that drops mid-stream must never leave zip_path
        # behind for the exists() short-circuit above to later trust as a full download.
        import requests

        class FlakyRaw:
            def __init__(self):
                self._chunks = [b"PK\x03\x04", None]

            def read(self, size=-1):
                chunk = self._chunks.pop(0)
                if chunk is None:
                    raise requests.exceptions.ConnectionError("connection reset mid-stream")
                return chunk

        class FakeResponse:
            raw = FlakyRaw()

            def raise_for_status(self):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc_info):
                return False

        source = fdc.SOURCES["fdc_foundation"]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with mock.patch.object(requests, "get", return_value=FakeResponse()):
                with self.assertRaises(requests.exceptions.ConnectionError):
                    fdc.download(source, "test-v1", root=root)
            self.assertFalse((root / "test-v1" / f"{source.key}.zip").exists())
            self.assertFalse((root / "test-v1" / "checksums.json").exists())


CONTRACT_CODES = {
    "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
    "sugars_total", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc",
    "vitamin_c", "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae",
    "saturated_fat", "cholesterol",
}


class NutrientMap(unittest.TestCase):
    def test_covers_every_contract_code_exactly_once(self):
        codes = [n.code for n in fdc.NUTRIENT_MAP.values()] + [fdc.CALC_NUTRIENT.code]
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(set(codes), CONTRACT_CODES)

    def test_binds_the_fdc_nutrient_numbers_the_spec_names(self):
        expected = {
            1008: "energy_kcal", 1003: "protein", 1005: "carbohydrate", 1004: "fat_total",
            1079: "fiber_total", 2000: "sugars_total", 1093: "sodium", 1092: "potassium",
            1087: "calcium", 1089: "iron", 1090: "magnesium", 1095: "zinc",
            1162: "vitamin_c", 1114: "vitamin_d", 1178: "vitamin_b12", 1190: "folate_dfe",
            1106: "vitamin_a_rae", 1258: "saturated_fat", 1253: "cholesterol",
        }
        self.assertEqual({k: v.code for k, v in fdc.NUTRIENT_MAP.items()}, expected)

    def test_units_are_the_four_the_contract_allows(self):
        units = {n.unit for n in fdc.NUTRIENT_MAP.values()} | {fdc.CALC_NUTRIENT.unit}
        self.assertEqual(units, {"kcal", "g", "mg", "µg"})

    def test_energy_kcal_calc_is_derivation_calculated(self):
        self.assertEqual(fdc.CALC_NUTRIENT.derivation, "calculated")

    def test_assert_nutrient_ids_rejects_a_missing_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "nutrient.csv"
            path.write_text("id,name,unit_name,nutrient_nbr,rank\n1008,Energy,KCAL,208,300\n")
            with self.assertRaises(SystemExit) as caught:
                fdc.assert_nutrient_ids(pathlib.Path(tmp))
            self.assertIn("1003", str(caught.exception))

    def test_assert_nutrient_ids_passes_when_every_id_is_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "nutrient.csv"
            rows = ["id,name,unit_name,nutrient_nbr,rank"]
            rows += [f"{i},x,G,0,0" for i in fdc.NUTRIENT_MAP]
            path.write_text("\n".join(rows) + "\n")
            fdc.assert_nutrient_ids(pathlib.Path(tmp))  # must not raise

    def test_catalog_nutrient_rows_carry_fdc_ids_and_a_null_for_the_calculated_code(self):
        rows = {r[0]: r for r in fdc.catalog_nutrient_rows()}
        self.assertEqual(rows["protein"][1], 1003)
        self.assertIsNone(rows["energy_kcal_calc"][1])


class Staging(unittest.TestCase):
    def test_ddl_creates_every_table_the_loader_writes(self):
        for table in ("food", "food_nutrient", "food_portion", "measure_unit", "food_category"):
            self.assertIn(f"catalog_staging.{table}", fdc.STAGING_DDL)

    def test_ddl_is_idempotent(self):
        self.assertEqual(fdc.STAGING_DDL.count("create table if not exists"), 5)

    def test_ddl_drops_every_staged_table_before_rebuilding_it(self):
        # Fix round 2: catalog_staging is a throwaway landing zone rebuilt every run, so a
        # shape change (e.g. the row_id column) never strands an environment that already
        # ran an older version of this worker on a manual ALTER.
        for _, table, _, _, _ in fdc.STAGING_LOADS:
            self.assertIn(f"drop table if exists catalog_staging.{table} cascade",
                          fdc.STAGING_DDL)

    def test_numeric_or_none_reads_blanks_and_junk_as_none(self):
        self.assertIsNone(fdc._numeric_or_none(""))
        self.assertIsNone(fdc._numeric_or_none(None))
        self.assertIsNone(fdc._numeric_or_none("n/a"))
        self.assertEqual(fdc._numeric_or_none(" 28.35 "), 28.35)

    def test_fndds_nutrient_nbr_is_translated_to_the_catalog_nutrient_id(self):
        # FNDDS's food_nutrient.csv carries the legacy nutrient_nbr (203) in the nutrient_id
        # column, not nutrient.csv's own id (1003) like Foundation/SR Legacy do.
        with tempfile.TemporaryDirectory() as tmp:
            csv_dir = pathlib.Path(tmp)
            (csv_dir / "nutrient.csv").write_text(
                "id,name,unit_name,nutrient_nbr,rank\n1003,Protein,G,203,600\n"
            )
            (csv_dir / "food_nutrient.csv").write_text(
                "id,fdc_id,nutrient_id,amount\n1,2705384,203,12.5\n"
            )
            rows = list(fdc._staged_food_nutrient_rows("fdc_fndds", csv_dir))
        self.assertEqual(rows, [["fdc_fndds", "2705384", 1003, 12.5]])

    def test_staged_food_nutrient_rows_skips_an_untranslatable_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_dir = pathlib.Path(tmp)
            (csv_dir / "nutrient.csv").write_text(
                "id,name,unit_name,nutrient_nbr,rank\n1003,Protein,G,203,600\n"
            )
            (csv_dir / "food_nutrient.csv").write_text(
                "id,fdc_id,nutrient_id,amount\n1,2705384,999,12.5\n"
            )
            rows = list(fdc._staged_food_nutrient_rows("fdc_fndds", csv_dir))
        self.assertEqual(rows, [])

    def test_nutrient_nbr_match_is_exact_not_a_truncating_int_cast(self):
        # nutrient.csv has nbrs that differ only by a decimal suffix: 205 "Carbohydrate, by
        # difference" (tracked, id 1005) vs 205.2 "Carbohydrate, by summation" (untracked,
        # id 1050). A lossy int(float(nbr)) cast collides both onto key 205 and the later
        # row wins - losing every FNDDS food's carbohydrate. Exact decimal matching must not.
        with tempfile.TemporaryDirectory() as tmp:
            csv_dir = pathlib.Path(tmp)
            (csv_dir / "nutrient.csv").write_text(
                "id,name,unit_name,nutrient_nbr,rank\n"
                "1005,\"Carbohydrate, by difference\",G,205,1110\n"
                "1050,\"Carbohydrate, by summation\",G,205.2,1120\n"
            )
            (csv_dir / "food_nutrient.csv").write_text(
                "id,fdc_id,nutrient_id,amount\n"
                "1,2705384,205,20.1\n"
                "2,2705384,205.2,19.8\n"
            )
            rows = list(fdc._staged_food_nutrient_rows("fdc_fndds", csv_dir))
        self.assertEqual(rows, [["fdc_fndds", "2705384", 1005, 20.1]])

    def test_an_nbr_that_resolves_outside_nutrient_map_is_skipped(self):
        # Real FNDDS data: nbr 319 resolves to id 1105 ("Retinol"), a real nutrient.csv
        # entry that is simply not one of the 19 this app tracks.
        with tempfile.TemporaryDirectory() as tmp:
            csv_dir = pathlib.Path(tmp)
            (csv_dir / "nutrient.csv").write_text(
                "id,name,unit_name,nutrient_nbr,rank\n1105,Retinol,UG,319,7430\n"
            )
            (csv_dir / "food_nutrient.csv").write_text(
                "id,fdc_id,nutrient_id,amount\n1,2705384,319,45.0\n"
            )
            rows = list(fdc._staged_food_nutrient_rows("fdc_fndds", csv_dir))
        self.assertEqual(rows, [])

    def test_food_portion_rows_skip_a_blank_fdc_id_and_report_the_count(self):
        columns = next(c for _, t, c, _, _ in fdc.STAGING_LOADS if t == "food_portion")
        with tempfile.TemporaryDirectory() as tmp:
            csv_dir = pathlib.Path(tmp)
            (csv_dir / "food_portion.csv").write_text(
                "id,fdc_id,seq_num,amount,measure_unit_id,portion_description,modifier,"
                "gram_weight\n"
                "1,1105295,1,1.0,1119,,Peel,56.7\n"
                "2,,1,1.0,,,,30.0\n"
            )
            counts = {}
            rows = list(fdc._staged_food_portion_rows("fdc_foundation", csv_dir, columns, counts))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][:2], ["fdc_foundation", "1105295"])
        self.assertEqual(counts["portions_skipped_no_fdc_id"], 1)


class PrepState(unittest.TestCase):
    def test_case_expression_covers_the_mapped_vocabulary(self):
        for state in ("raw", "cooked", "boiled", "roasted", "fried", "grilled"):
            self.assertIn(f"'{state}'", fdc.PREP_STATE_CASE)

    def test_case_expression_never_emits_a_value_outside_the_ddl_check(self):
        # 'canned' and 'dried' are not in contracts §3's PrepState union (Lane G Open question 2);
        # the DDL check no longer accepts them, so the mapper must never try to write them either.
        self.assertNotIn("'canned'", fdc.PREP_STATE_CASE)
        self.assertNotIn("'dried'", fdc.PREP_STATE_CASE)

    def test_case_expression_defaults_to_null_not_a_guess(self):
        self.assertTrue(fdc.PREP_STATE_CASE.rstrip().endswith("else null end"))

    def test_case_expression_uses_postgres_word_boundaries_not_backspace(self):
        # Fix round 1: Postgres's regex engine (ARE) reads \b as a literal backspace character,
        # not a word boundary - \y is the word-boundary anchor there. \b matched nothing on real
        # data (every one of 101,207 real revisions got prep_state null before this fix).
        self.assertIn(r"\y", fdc.PREP_STATE_CASE)
        self.assertNotIn(r"\b", fdc.PREP_STATE_CASE)


class DataTypeScope(unittest.TestCase):
    # Fix round 1: a bulk zip's food.csv carries more than one data_type; each source's build
    # must touch only its own (see SourceRegistry.test_data_type_matches_each_source_s_own_food_csv_rows).
    def test_food_insert_filters_on_the_source_s_data_type(self):
        source = inspect.getsource(fdc._write_version_and_foods)
        self.assertIn("s.data_type", source)

    def test_revision_insert_filters_on_the_source_s_data_type(self):
        source = inspect.getsource(fdc._write_revisions)
        self.assertIn("s.data_type", source)


class SearchDoc(unittest.TestCase):
    # Controller ruling: catalog_food_revisions.search_doc is NOT a generated column (frozen
    # contract, migration 090000) - the revision insert must write it itself on every import.
    def test_revision_insert_names_search_doc_and_calls_the_immutable_helper(self):
        source = inspect.getsource(fdc._write_revisions)
        self.assertIn("search_doc", source)
        self.assertIn("catalog_search_doc(", source)

    def test_revision_insert_passes_description_null_brand_then_category(self):
        # brand is null for FDC bulk (no brand column in this source's staging data).
        source = inspect.getsource(fdc._write_revisions)
        self.assertIn("catalog_search_doc(s.description, null, c.description)", source)


class Portions(unittest.TestCase):
    def test_label_joins_amount_unit_description_and_modifier(self):
        self.assertEqual(fdc.portion_label("1.000", "cup", "", "chopped"), "1 cup chopped")

    def test_label_drops_the_undetermined_unit(self):
        self.assertEqual(fdc.portion_label("1", "undetermined", "1 thigh", ""), "1 1 thigh")

    def test_label_collapses_whitespace(self):
        self.assertEqual(fdc.portion_label(" 2 ", " oz ", "  ", " raw "), "2 oz raw")

    def test_normalise_keeps_only_gram_weighted_measures(self):
        rows = [
            {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
             "modifier": "", "gram_weight": "158"},
            {"seq_num": "2", "amount": "1", "unit_name": "cup", "portion_description": "",
             "modifier": "", "gram_weight": "0"},
            {"seq_num": "3", "amount": "", "unit_name": "", "portion_description": "",
             "modifier": "", "gram_weight": "40"},
        ]
        out = fdc.normalise_portions(rows)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["description"], "1 cup")
        self.assertEqual(out[0]["gram_weight"], 158.0)

    def test_normalise_marks_the_first_measure_default_and_numbers_from_one(self):
        rows = [
            {"seq_num": "2", "amount": "1", "unit_name": "oz", "portion_description": "",
             "modifier": "", "gram_weight": "28.35"},
            {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
             "modifier": "", "gram_weight": "158"},
        ]
        out = fdc.normalise_portions(rows)
        self.assertEqual([r["seq"] for r in out], [1, 2])
        self.assertEqual([r["is_default"] for r in out], [True, False])
        self.assertEqual(out[0]["description"], "1 cup")

    def test_normalise_treats_seq_num_zero_as_a_real_position_not_missing(self):
        # `if seq_num else 10 ** 6` treated 0 as falsy and sorted it last with the rows that
        # carry no seq_num at all; 0 is a real, present FDC value and must sort first.
        rows = [
            {"seq_num": "1", "amount": "1", "unit_name": "oz", "portion_description": "",
             "modifier": "", "gram_weight": "28.35"},
            {"seq_num": "0", "amount": "1", "unit_name": "cup", "portion_description": "",
             "modifier": "", "gram_weight": "158"},
        ]
        self.assertEqual(
            [r["description"] for r in fdc.normalise_portions(rows)], ["1 cup", "1 oz"]
        )

    def test_normalise_puts_rows_without_a_seq_num_last(self):
        rows = [
            {"seq_num": "", "amount": "1", "unit_name": "oz", "portion_description": "",
             "modifier": "", "gram_weight": "28.35"},
            {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
             "modifier": "", "gram_weight": "158"},
        ]
        self.assertEqual(
            [r["description"] for r in fdc.normalise_portions(rows)], ["1 cup", "1 oz"]
        )

    def test_normalise_returns_nothing_for_a_food_with_no_measures(self):
        self.assertEqual(fdc.normalise_portions([]), [])

    def test_normalise_breaks_a_seq_num_and_label_tie_by_gram_weight_regardless_of_input_order(self):
        # Fix round 1, Important #1: two rows that share both seq_num and label (only
        # gram_weight differs) must land in the same order every time, even when the rows
        # arrive in a different order (an SQL scan without a full ORDER BY, or a caller
        # that just built the list a different way).
        lighter = {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
                   "modifier": "", "gram_weight": "158"}
        heavier = {"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
                   "modifier": "", "gram_weight": "200"}
        out_forward = fdc.normalise_portions([lighter, heavier])
        out_reversed = fdc.normalise_portions([heavier, lighter])
        self.assertEqual(out_forward, out_reversed)
        self.assertEqual([r["gram_weight"] for r in out_forward], [158.0, 200.0])

    def test_normalise_drops_a_gram_weight_that_rounds_to_zero(self):
        # Fix round 1, minor #3: round before the > 0 filter so (0, 0.005) is dropped
        # rather than written as a misleading 0.00.
        rows = [{"seq_num": "1", "amount": "1", "unit_name": "cup", "portion_description": "",
                 "modifier": "", "gram_weight": "0.004"}]
        self.assertEqual(fdc.normalise_portions(rows), [])

    def test_normalise_skips_a_generic_gram_unit_for_is_default(self):
        # Fix round 1, Important #2: a generic gram unit ("100 g") is kept as a portion but
        # is never is_default - the household measure that sorts next ("1 cup") is instead.
        rows = [
            {"seq_num": "1", "amount": "100", "unit_name": "g", "portion_description": "",
             "modifier": "", "gram_weight": "100"},
            {"seq_num": "2", "amount": "1", "unit_name": "cup", "portion_description": "",
             "modifier": "", "gram_weight": "158"},
        ]
        out = fdc.normalise_portions(rows)
        self.assertEqual([r["description"] for r in out], ["100 g", "1 cup"])
        self.assertEqual([r["is_default"] for r in out], [False, True])

    def test_normalise_marks_no_default_when_every_kept_row_is_a_gram_unit(self):
        rows = [
            {"seq_num": "1", "amount": "100", "unit_name": "g", "portion_description": "",
             "modifier": "", "gram_weight": "100"},
            {"seq_num": "2", "amount": "1", "unit_name": "gm", "portion_description": "",
             "modifier": "", "gram_weight": "1"},
        ]
        out = fdc.normalise_portions(rows)
        self.assertEqual([r["is_default"] for r in out], [False, False])


class Gates(unittest.TestCase):
    def test_row_floors_exist_for_all_three_sources(self):
        self.assertEqual(sorted(fdc.MIN_ROWS), ["fdc_fndds", "fdc_foundation", "fdc_sr_legacy"])
        self.assertTrue(all(v > 0 for v in fdc.MIN_ROWS.values()))

    def test_macro_coverage_and_mismatch_gates_match_the_spec(self):
        self.assertEqual(fdc.MAX_MISMATCH_RATE, 0.10)
        self.assertGreaterEqual(fdc.MIN_MACRO_COVERAGE, 0.90)

    def test_assert_gates_rejects_a_truncated_dataset(self):
        report = {"revisions": 10, "macro_coverage": 1.0, "energy_mismatch_rate": 0.0}
        with self.assertRaises(SystemExit):
            fdc.assert_gates(fdc.SOURCES["fdc_sr_legacy"], report)

    def test_assert_gates_accepts_a_healthy_dataset(self):
        report = {"revisions": 7500, "macro_coverage": 0.97, "energy_mismatch_rate": 0.02}
        fdc.assert_gates(fdc.SOURCES["fdc_sr_legacy"], report)  # must not raise
        self.assertEqual(report["warnings"], [])

    def test_assert_gates_warns_but_does_not_raise_on_low_macro_coverage(self):
        report = {"revisions": 7500, "macro_coverage": 0.80, "energy_mismatch_rate": 0.02}
        fdc.assert_gates(fdc.SOURCES["fdc_sr_legacy"], report)  # must not raise
        self.assertEqual(len(report["warnings"]), 1)
        warning = report["warnings"][0]
        self.assertIn("fdc_sr_legacy", warning)
        self.assertIn("macro coverage", warning)
        self.assertIn("0.8", warning)
        self.assertIn(str(fdc.MIN_MACRO_COVERAGE), warning)

    def test_assert_gates_warns_but_does_not_raise_on_high_mismatch_rate(self):
        report = {"revisions": 7500, "macro_coverage": 0.97, "energy_mismatch_rate": 0.20}
        fdc.assert_gates(fdc.SOURCES["fdc_sr_legacy"], report)  # must not raise
        self.assertEqual(len(report["warnings"]), 1)
        warning = report["warnings"][0]
        self.assertIn("fdc_sr_legacy", warning)
        self.assertIn("mismatch", warning)
        self.assertIn("0.2", warning)
        self.assertIn(str(fdc.MAX_MISMATCH_RATE), warning)


class Cli(unittest.TestCase):
    def test_version_label_is_required_without_rollback(self):
        with self.assertRaises(SystemExit):
            fdc.parse_args(["--db-url", "postgres://x"])

    def test_rollback_alone_is_enough(self):
        args = fdc.parse_args(["--db-url", "postgres://x", "--rollback-to", "2026-06-01"])
        self.assertEqual(args.rollback_to, "2026-06-01")
        self.assertIsNone(args.version_label)

    def test_dry_run_defaults_off(self):
        args = fdc.parse_args(["--db-url", "postgres://x", "--version-label", "2026-09-12"])
        self.assertFalse(args.dry_run)


class ConnectionFailure(unittest.TestCase):
    def test_connect_failure_withholds_the_connection_string(self):
        import psycopg

        secret_url = "postgres://user:secret@127.0.0.1:1/x"

        def boom(*args, **kwargs):
            # Real psycopg OperationalError text often echoes the DSN verbatim - this is
            # exactly the shape main() must never let leak into an exit message or output.
            raise psycopg.OperationalError(
                f"connection to server failed: could not translate host name in {secret_url}"
            )

        out, err = io.StringIO(), io.StringIO()
        # main() now fetches (downloads/extracts) every source before it opens the DB
        # connection, so those must be stubbed out here too - this test is only about the
        # connect-failure message, never about hitting the real network.
        with mock.patch.object(fdc, "download", return_value=pathlib.Path("/dev/null")), \
             mock.patch.object(fdc, "extract", return_value=pathlib.Path("/dev/null")), \
             mock.patch.object(fdc, "assert_nutrient_ids", return_value=None), \
             mock.patch.object(psycopg, "connect", side_effect=boom):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    fdc.main(["--db-url", secret_url, "--version-label", "t"])

        exit_message = str(ctx.exception)
        for leaked in ("secret", secret_url):
            self.assertNotIn(leaked, exit_message)
            self.assertNotIn(leaked, out.getvalue())
            self.assertNotIn(leaked, err.getvalue())


if __name__ == "__main__":
    unittest.main()
