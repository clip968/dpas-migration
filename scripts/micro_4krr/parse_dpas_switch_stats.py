#!/usr/bin/env python3

import os
import statistics
import sys
from pathlib import Path


STAT_FIELDS = [
    "pas_eval",
    "pas_to_cp",
    "pas_to_ol",
    "pas_stay_not_qd1",
    "ol_eval",
    "ol_to_pas",
    "ol_to_int",
    "ol_stay_between",
    "cp_to_pas",
    "int_to_ol",
]

QD_FIELD_MAP = {
    "last_avg_qd_x10": "last_qd",
    "min_avg_qd_x10": "min_qd",
    "max_avg_qd_x10": "max_qd",
}

REPORT_FIELDS = STAT_FIELDS + list(QD_FIELD_MAP.values())


def _csv_env(name: str, default: str):
    val = os.environ.get(name, default).strip()
    return [x.strip() for x in val.split(",") if x.strip()]


def parse_stats_text(text: str) -> dict[str, float]:
    raw: dict[str, int] = {}

    for line in text.splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue

        key, value = line.split("=", 1)
        raw[key.strip()] = int(value.strip())

    missing = [field for field in STAT_FIELDS if field not in raw]
    missing.extend(key for key in QD_FIELD_MAP if key not in raw)
    if missing:
        raise ValueError(f"missing dpas switch stats fields: {', '.join(missing)}")

    parsed: dict[str, float] = {}
    for field in STAT_FIELDS:
        parsed[field] = raw[field]

    for source, target in QD_FIELD_MAP.items():
        parsed[target] = raw[source] / 10.0

    return parsed


def _stats_path(base_dir: Path, device: str, rw_flag: str, job: int, repeat: int) -> Path:
    return (
        base_dir
        / device
        / rw_flag
        / f"{job}T"
        / "DPAS"
        / f"dpas_switch_stats_{repeat}.txt"
    )


def _read_rows(base_dir: Path, device: str, rw_flag: str, jobs: list[int], repeats: int):
    rows = []
    for job in jobs:
        for repeat in range(1, repeats + 1):
            path = _stats_path(base_dir, device, rw_flag, job, repeat)
            stats = parse_stats_text(path.read_text())
            rows.append({"thread": job, "repeat": repeat, **stats})
    return rows


def _format_raw_value(field: str, value: float) -> str:
    if field in STAT_FIELDS:
        return str(int(value))
    return f"{value:.1f}"


def _write_raw(path: Path, rows) -> None:
    with path.open("w") as f:
        print("DPAS_SWITCH_STATS", file=f)
        print("Thread Repeat " + " ".join(REPORT_FIELDS), file=f)
        for row in rows:
            values = [_format_raw_value(field, row[field]) for field in REPORT_FIELDS]
            print(f"{row['thread']} {row['repeat']} " + " ".join(values), file=f)


def _write_summary(path: Path, rows, jobs: list[int]) -> None:
    rows_by_thread: dict[int, list[dict[str, float]]] = {job: [] for job in jobs}
    for row in rows:
        rows_by_thread[row["thread"]].append(row)

    with path.open("w") as f:
        print("DPAS_SWITCH_STATS_SUMMARY", file=f)
        print("mean", file=f)
        print("Thread " + " ".join(REPORT_FIELDS), file=f)
        for job in jobs:
            values = []
            for field in REPORT_FIELDS:
                field_values = [row[field] for row in rows_by_thread[job]]
                values.append(f"{statistics.mean(field_values):.2f}")
            print(f"{job} " + " ".join(values), file=f)

        print("", file=f)
        print("std", file=f)
        print("Thread " + " ".join(REPORT_FIELDS), file=f)
        for job in jobs:
            values = []
            for field in REPORT_FIELDS:
                field_values = [row[field] for row in rows_by_thread[job]]
                values.append(f"{statistics.pstdev(field_values):.2f}")
            print(f"{job} " + " ".join(values), file=f)


def write_reports(
    *,
    base_dir: Path,
    parsed_dir: Path,
    result_dir: Path,
    devices: list[str],
    rw_flags: list[str],
    jobs: list[int],
    repeats: int,
) -> list[Path]:
    parsed_dir.mkdir(parents=True, exist_ok=True)
    result_dir.mkdir(parents=True, exist_ok=True)

    summary_paths = []
    for rw_flag in rw_flags:
        for device in devices:
            rows = _read_rows(base_dir, device, rw_flag, jobs, repeats)
            raw_path = parsed_dir / f"{device}-{rw_flag}-dpas-switch-repeat_{repeats}.txt"
            summary_path = result_dir / f"{device}-{rw_flag}-dpas-switch-repeat_{repeats}.txt"

            _write_raw(raw_path, rows)
            _write_summary(summary_path, rows, jobs)
            summary_paths.append(summary_path)

    return summary_paths


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} [repeats]", file=sys.stderr)
        return 2

    repeats = int(argv[1])
    devices = _csv_env("DPAS_DEVICE_LIST", "nvme0n1,nvme1n1,nvme2n1")
    rw_flags = _csv_env("DPAS_RW_FLAGS", "RR")
    jobs = [int(x) for x in _csv_env("DPAS_JOB_LIST", "1,2,4,8,16,20")]

    cwd = Path.cwd()
    summary_paths = write_reports(
        base_dir=cwd / "fio_data",
        parsed_dir=cwd / "parsed_data",
        result_dir=cwd / "result_data",
        devices=devices,
        rw_flags=rw_flags,
        jobs=jobs,
        repeats=repeats,
    )

    for path in summary_paths:
        print(f"[DPAS_SWITCH_STATS] {path}")
        print(path.read_text(), end="")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
