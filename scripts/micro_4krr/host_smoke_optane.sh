#!/usr/bin/env bash
set -euo pipefail

DEV="${DPAS_DEV:-nvme1n1}"
PART="${DPAS_PART:-nvme1n1p1}"
MNT="${DPAS_MNT:-/mnt/dpas-optane}"
TESTDIR="${DPAS_TESTDIR:-${MNT}/dpas-host-test}"
LOG_ROOT="${DPAS_LOG_ROOT:-/tmp/dpas-host-postboot}"
RUNTIME="${DPAS_RUNTIME:-10}"
RAMP_TIME="${DPAS_RAMP_TIME:-3}"
PREFILL_SIZE="${DPAS_PREFILL_SIZE:-100m}"
PREFILL_JOBS="${DPAS_PREFILL_JOBS:-20}"
MODES="${DPAS_MODES:-INT CP LHP PAS}"
UNMOUNT_AFTER="${DPAS_UNMOUNT_AFTER:-0}"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT="${LOG_ROOT}/host-smoke-${RUN_ID}"
Q="/sys/block/${DEV}/queue"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

if [[ "${PART}" == "${DEV}" ]]; then
  echo "Refusing to use whole disk /dev/${DEV}; set DPAS_PART to a partition." >&2
  exit 1
fi

if [[ ! -b "/dev/${PART}" ]]; then
  echo "Missing block device: /dev/${PART}" >&2
  exit 1
fi

if [[ ! -d "${Q}" ]]; then
  echo "Missing queue sysfs path: ${Q}" >&2
  exit 1
fi

require_knob() {
  local name="$1"
  if [[ ! -e "${Q}/${name}" ]]; then
    echo "Missing required knob: ${Q}/${name}" >&2
    exit 1
  fi
}

require_knob io_poll
require_knob io_poll_delay
require_knob pas_enabled
require_knob pas_adaptive_enabled

if ! fio --enghelp | grep -qw pvsync2; then
  echo "fio pvsync2 engine is missing; aborting." >&2
  exit 1
fi

POLL_QUEUES="$(cat /sys/module/nvme/parameters/poll_queues 2>/dev/null || echo 0)"
if [[ "${POLL_QUEUES}" -lt 1 ]]; then
  echo "nvme.poll_queues=${POLL_QUEUES}; polling modes cannot run." >&2
  exit 1
fi

mkdir -p "${OUT}" "${MNT}"
ln -sfn "${OUT}" "${LOG_ROOT}/host-smoke-latest"

echo "== DPAS host Optane smoke =="
echo "log: ${OUT}"
echo "device: /dev/${DEV}"
echo "partition: /dev/${PART}"
echo "mount: ${MNT}"
echo "testdir: ${TESTDIR}"
echo "modes: ${MODES}"
echo

{
  date '+%Y-%m-%d %H:%M:%S %Z %z'
  uname -a
  cat /proc/cmdline
  echo "nvme.poll_queues=${POLL_QUEUES}"
} | tee "${OUT}/00-basic.txt"

lsblk -o NAME,TYPE,SIZE,FSTYPE,UUID,PARTUUID,MOUNTPOINTS,MODEL "/dev/${DEV}" \
  | tee "${OUT}/01-lsblk-${DEV}.txt"

MOUNTED_BY_SCRIPT=0
if findmnt -rn "${MNT}" >/dev/null; then
  CURRENT_SOURCE="$(findmnt -rn -o SOURCE "${MNT}")"
  if [[ "$(readlink -f "${CURRENT_SOURCE}")" != "$(readlink -f "/dev/${PART}")" ]]; then
    echo "${MNT} is mounted from ${CURRENT_SOURCE}, expected /dev/${PART}; aborting." >&2
    exit 1
  fi
  CURRENT_OPTIONS="$(findmnt -rn -o OPTIONS "${MNT}")"
  if [[ ",${CURRENT_OPTIONS}," == *,ro,* ]]; then
    echo "${MNT} is read-only; remounting rw."
    mount -o remount,rw "${MNT}"
  fi
else
  mount "/dev/${PART}" "${MNT}"
  MOUNTED_BY_SCRIPT=1
fi

findmnt "${MNT}" | tee "${OUT}/02-findmnt.txt"
if [[ "$(readlink -f "$(findmnt -rn -o SOURCE "${MNT}")")" != "$(readlink -f "/dev/${PART}")" ]]; then
  echo "Post-mount source check failed; aborting." >&2
  exit 1
fi

mkdir -p "${TESTDIR}"
if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
  chown "${SUDO_UID}:${SUDO_GID}" "${TESTDIR}" || true
fi

KNOBS=(
  io_poll
  io_poll_delay
  nomerges
  pas_enabled
  pas_adaptive_enabled
  ehp_enabled
  switch_enabled
  switch_param1
  switch_param2
  switch_param3
  switch_param4
  pas_poll_threshold
  pas_d_init
  pas_up_init
  pas_dn_init
)

wq() {
  local name="$1"
  local value="$2"
  if [[ -e "${Q}/${name}" ]]; then
    echo "${value}" > "${Q}/${name}"
  fi
}

show_knobs() {
  local f
  for f in "${KNOBS[@]}"; do
    if [[ -e "${Q}/${f}" ]]; then
      printf "%-24s " "${f}"
      cat "${Q}/${f}"
    fi
  done
}

reset_knobs() {
  wq io_poll 1
  wq io_poll_delay -1
  wq nomerges 0
  wq pas_enabled 0
  wq pas_adaptive_enabled 0
  wq ehp_enabled 0
  wq switch_enabled 0
  wq pas_poll_threshold 0
  wq pas_d_init 100
  wq pas_up_init 10000
  wq pas_dn_init 100000
}

set_mode() {
  local mode="$1"
  reset_knobs
  case "${mode}" in
    INT)
      ;;
    CP)
      ;;
    LHP)
      wq io_poll_delay 0
      ;;
    PAS)
      wq io_poll_delay 0
      wq pas_enabled 1
      wq pas_adaptive_enabled 1
      wq switch_enabled 0
      ;;
    *)
      echo "Unsupported mode for host smoke: ${mode}" >&2
      return 1
      ;;
  esac
  show_knobs
}

cleanup() {
  set +e
  reset_knobs
  show_knobs > "${OUT}/final-knobs.txt"
  sync
  if [[ "${UNMOUNT_AFTER}" == "1" || "${UNMOUNT_AFTER}" == "yes" ]]; then
    umount "${MNT}"
  elif [[ "${MOUNTED_BY_SCRIPT}" == "1" ]]; then
    echo "Leaving ${MNT} mounted. Set DPAS_UNMOUNT_AFTER=1 to unmount at exit."
  fi
}
trap cleanup EXIT

echo "== initial knobs =="
show_knobs | tee "${OUT}/03-initial-knobs.txt"

echo "== prefill =="
fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
  --rw=write --bs=1m --size="${PREFILL_SIZE}" --numjobs="${PREFILL_JOBS}" \
  --direct=1 --end_fsync=1 --group_reporting --name=prefill \
  | tee "${OUT}/04-prefill.log"
sync

ls -lh "${TESTDIR}"/testfile.* | tee "${OUT}/05-prefill-files.txt"

echo "== smoke =="
for MODE in ${MODES}; do
  echo "## ${MODE}"
  set_mode "${MODE}" | tee "${OUT}/knobs-${MODE}.txt"

  echo 3 > /proc/sys/vm/drop_caches

  HIPRI=()
  if [[ "${MODE}" != "INT" ]]; then
    HIPRI=(--hipri)
  fi

  fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
    --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
    --iodepth=1 --runtime="${RUNTIME}" --ramp_time="${RAMP_TIME}" \
    --numjobs=1 --time_based --group_reporting --name=run \
    --eta-newline=1 "${HIPRI[@]}" \
    | tee "${OUT}/smoke-${MODE}.log"

  dmesg -T | tail -100 > "${OUT}/dmesg-after-${MODE}.txt"
done

echo "== dmesg important =="
dmesg -T \
  | grep -Ei 'panic|oops|BUG:|WARNING:|fail|error|nvme|i40e|pas|lhp' \
  | tail -200 \
  | tee "${OUT}/dmesg-important.txt" || true

echo "== quick summary =="
grep -H 'IOPS=' "${OUT}"/smoke-*.log || true
grep -H 'cpu          :' "${OUT}"/smoke-*.log || true

if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
  chown -R "${SUDO_UID}:${SUDO_GID}" "${OUT}" "${TESTDIR}" || true
fi

echo "SMOKE_DONE"
echo "log: ${OUT}"
