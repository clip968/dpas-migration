#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/run_optane_full_dpas_no_ehp.sh"

test -f "${SCRIPT}"

grep -q 'DEVICES=("nvme1n1")' "${SCRIPT}"
grep -q 'IO_MODE=("PAS" "INT" "CP" "LHP")' "${SCRIPT}"
grep -q '# IO_MODE=("CP" "DPAS" "PAS" "LHP" "INT")' "${SCRIPT}"
grep -q './xfs_fio_prerun.sh nvme1n1' "${SCRIPT}"
grep -q -- '--bs=4k' "${SCRIPT}"
grep -q -- '--ioengine=pvsync2' "${SCRIPT}"
grep -q -- '--readonly --rw=randread' "${SCRIPT}"
grep -q 'NVME_RELOADABLE' "${SCRIPT}"
grep -q 'nvme_setup' "${SCRIPT}"
grep -q 'reset_queue_knobs' "${SCRIPT}"
grep -q 'set_mode_knobs "${device}" "${mode}"' "${SCRIPT}"
grep -q 'wq "$device" io_poll_delay -1' "${SCRIPT}"
grep -q 'wq "$device" pas_enabled 0' "${SCRIPT}"
grep -q 'wq "$device" pas_adaptive_enabled 0' "${SCRIPT}"
grep -q 'wq "$device" ehp_enabled 0' "${SCRIPT}"
grep -q 'wq "$device" switch_enabled 0' "${SCRIPT}"
grep -q 'wq "$device" io_poll 1' "${SCRIPT}"
grep -q '#.*switch_enabled' "${SCRIPT}"
grep -q '#.*switch_param1' "${SCRIPT}"

if grep -Eq '^[[:space:]]*echo .*switch_' "${SCRIPT}"; then
  echo "switch_* writes must stay commented out" >&2
  exit 1
fi

if grep -q '"EHP"' "${SCRIPT}"; then
  echo "EHP mode must not be in the Optane PAS/CP/LHP/INT script" >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*IO_MODE=.*DPAS' "${SCRIPT}"; then
  echo "DPAS must not be in the default mode list" >&2
  exit 1
fi

echo "optane PAS/INT/CP/LHP script test passed"
