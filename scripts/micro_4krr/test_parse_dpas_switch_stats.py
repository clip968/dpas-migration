#!/usr/bin/env python3

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import parse_dpas_switch_stats


class ParseDpasSwitchStatsTest(unittest.TestCase):
    def test_parses_stats_text_and_converts_qd_x10(self):
        stats = parse_dpas_switch_stats.parse_stats_text(
            "\n".join(
                [
                    "pas_eval=10",
                    "pas_to_cp=2",
                    "pas_to_ol=1",
                    "pas_stay_not_qd1=7",
                    "ol_eval=1",
                    "ol_to_pas=0",
                    "ol_to_int=1",
                    "ol_stay_between=0",
                    "cp_to_pas=2",
                    "int_to_ol=1",
                    "last_avg_qd_x10=18",
                    "min_avg_qd_x10=10",
                    "max_avg_qd_x10=35",
                ]
            )
        )

        self.assertEqual(stats["pas_to_cp"], 2)
        self.assertEqual(stats["last_qd"], 1.8)
        self.assertEqual(stats["min_qd"], 1.0)
        self.assertEqual(stats["max_qd"], 3.5)

    def test_writes_raw_and_summary_tables_from_fio_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / "fio_data"
            for job, repeats in {
                4: [(1, 10, 0, 1, 9, 12), (2, 20, 2, 0, 18, 10)],
                2: [(1, 30, 3, 0, 27, 10), (2, 50, 5, 0, 45, 10)],
            }.items():
                d = base / "nvme1n1" / "RR" / f"{job}T" / "DPAS"
                d.mkdir(parents=True)
                for repeat, pas_eval, pas_to_cp, pas_to_ol, stay, min_qd_x10 in repeats:
                    (d / f"dpas_switch_stats_{repeat}.txt").write_text(
                        "\n".join(
                            [
                                f"pas_eval={pas_eval}",
                                f"pas_to_cp={pas_to_cp}",
                                f"pas_to_ol={pas_to_ol}",
                                f"pas_stay_not_qd1={stay}",
                                "ol_eval=1",
                                "ol_to_pas=0",
                                "ol_to_int=1",
                                "ol_stay_between=0",
                                f"cp_to_pas={pas_to_cp}",
                                "int_to_ol=1",
                                "last_avg_qd_x10=15",
                                f"min_avg_qd_x10={min_qd_x10}",
                                "max_avg_qd_x10=30",
                            ]
                        )
                        + "\n"
                    )

            written = parse_dpas_switch_stats.write_reports(
                base_dir=base,
                parsed_dir=root / "parsed_data",
                result_dir=root / "result_data",
                devices=["nvme1n1"],
                rw_flags=["RR"],
                jobs=[4, 2],
                repeats=2,
            )

            raw_path = root / "parsed_data" / "nvme1n1-RR-dpas-switch-repeat_2.txt"
            summary_path = root / "result_data" / "nvme1n1-RR-dpas-switch-repeat_2.txt"
            self.assertEqual(written, [summary_path])

            raw = raw_path.read_text()
            self.assertIn("Thread Repeat pas_eval pas_to_cp", raw)
            self.assertIn("4 1 10 0 1 9", raw)
            self.assertIn("2 2 50 5 0 45", raw)

            summary = summary_path.read_text()
            self.assertIn("mean", summary)
            self.assertIn("4 15.00 1.00 0.50 13.50", summary)
            self.assertIn("2 40.00 4.00 0.00 36.00", summary)
            self.assertIn("std", summary)


if __name__ == "__main__":
    unittest.main()
