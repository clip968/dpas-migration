#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/ext4_file_precondition_probe.sh"

out="$(
  DPAS_DRY_RUN=1 \
  DPAS_TESTDIR=/mnt/dpas-optane/dpas-host-test-ext4-probe \
  DPAS_REPEATS=1 \
  DPAS_MODES=CP \
  "${SCRIPT}"
)"

for case_name in cold same-file-same-seed same-file-diff-seed diff-file-same-seed; do
  grep -q "case=${case_name}" <<< "${out}"
done

grep -q "measured_file=.*/fileA" <<< "${out}"
grep -q "warmup_file=.*/fileB" <<< "${out}"
grep -q -- "--filename=.*fileA" <<< "${out}"

if grep -q -- "--filename=/dev/" <<< "${out}"; then
  echo "dry-run unexpectedly targets a raw block device" >&2
  exit 1
fi

echo "ext4_file_precondition_probe dry-run test passed"
