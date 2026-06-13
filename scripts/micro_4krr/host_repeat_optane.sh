#!/usr/bin/env bash
set -euo pipefail

DEV="${DPAS_DEV:-nvme1n1}"
PART="${DPAS_PART:-nvme1n1p1}"
MNT="${DPAS_MNT:-/mnt/dpas-optane}"
TESTDIR="${DPAS_TESTDIR:-${MNT}/dpas-host-test}"
LOG_ROOT="${DPAS_LOG_ROOT:-/tmp/dpas-host-postboot}"
RUNTIME="${DPAS_RUNTIME:-30}"
RAMP_TIME="${DPAS_RAMP_TIME:-3}"
WARMUP_RUNTIME="${DPAS_WARMUP_RUNTIME:-0}"
WARMUP_RAMP_TIME="${DPAS_WARMUP_RAMP_TIME:-${RAMP_TIME}}"
REPEATS="${DPAS_REPEATS:-5}"
JOBS="${DPAS_JOBS:-1}"
PREFILL_SIZE="${DPAS_PREFILL_SIZE:-100m}"
PREFILL_JOBS="${DPAS_PREFILL_JOBS:-20}"
MODES="${DPAS_MODES:-INT CP LHP PAS}"
UNMOUNT_AFTER="${DPAS_UNMOUNT_AFTER:-0}"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT="${LOG_ROOT}/host-repeat-${RUN_ID}"
Q="/sys/block/${DEV}/queue"
SUMMARY="${OUT}/summary.csv"

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

for mode in ${MODES}; do
  case "${mode}" in
    INT|CP|LHP|PAS) ;;
    *)
      echo "Unsupported mode: ${mode}. Allowed: INT CP LHP PAS" >&2
      exit 1
      ;;
  esac
done

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
ln -sfn "${OUT}" "${LOG_ROOT}/host-repeat-latest"

MODE_COUNT="$(wc -w <<< "${MODES}")"
JOB_COUNT="$(wc -w <<< "${JOBS}")"
EST_SECONDS=$(( REPEATS * MODE_COUNT * JOB_COUNT * (RUNTIME + RAMP_TIME) ))
if (( WARMUP_RUNTIME > 0 )); then
  EST_SECONDS=$(( EST_SECONDS + REPEATS * MODE_COUNT * JOB_COUNT * (WARMUP_RUNTIME + WARMUP_RAMP_TIME) ))
fi

echo "== DPAS host Optane repeat test =="
echo "log: ${OUT}"
echo "summary: ${SUMMARY}"
echo "device: /dev/${DEV}"
echo "partition: /dev/${PART}"
echo "mount: ${MNT}"
echo "testdir: ${TESTDIR}"
echo "modes: ${MODES}"
echo "jobs: ${JOBS}"
echo "repeats: ${REPEATS}"
echo "runtime/ramp: ${RUNTIME}s/${RAMP_TIME}s"
echo "warmup runtime/ramp: ${WARMUP_RUNTIME}s/${WARMUP_RAMP_TIME}s"
echo "estimated fio wall time: ~${EST_SECONDS}s"
echo

{
  date '+%Y-%m-%d %H:%M:%S %Z %z'
  uname -a
  cat /proc/cmdline
  echo "nvme.poll_queues=${POLL_QUEUES}"
  echo "modes=${MODES}"
  echo "jobs=${JOBS}"
  echo "repeats=${REPEATS}"
  echo "runtime=${RUNTIME}"
  echo "ramp_time=${RAMP_TIME}"
  echo "warmup_runtime=${WARMUP_RUNTIME}"
  echo "warmup_ramp_time=${WARMUP_RAMP_TIME}"
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
      echo "Unsupported mode for host repeat: ${mode}" >&2
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
  if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
    chown -R "${SUDO_UID}:${SUDO_GID}" "${OUT}" "${TESTDIR}" || true
  fi
}
trap cleanup EXIT

append_summary() {
  local repeat="$1"
  local mode="$2"
  local jobs="$3"
  local json="$4"
  python3 - "$repeat" "$mode" "$jobs" "$json" <<'PY'
import json
import sys

repeat, mode, jobs, path = sys.argv[1:5]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

job = data["jobs"][0]
read = job.get("read", {})
err = job.get("error", data.get("error", 0))
iops = float(read.get("iops", 0.0))
if "bw_bytes" in read:
    bw_mib = float(read["bw_bytes"]) / 1024 / 1024
else:
    bw_mib = float(read.get("bw", 0.0)) / 1024

lat = read.get("lat_ns") or read.get("clat_ns") or {}
lat_avg_us = float(lat.get("mean", 0.0)) / 1000
lat_stdev_us = float(lat.get("stddev", 0.0)) / 1000
lat_min_us = float(lat.get("min", 0.0)) / 1000
lat_max_us = float(lat.get("max", 0.0)) / 1000
usr = float(job.get("usr_cpu", 0.0))
sys_cpu = float(job.get("sys_cpu", 0.0))
ctx = int(job.get("ctx", 0))

print(
    f"{repeat},{mode},{jobs},{err},{iops:.2f},{bw_mib:.2f},"
    f"{lat_avg_us:.3f},{lat_stdev_us:.3f},{lat_min_us:.3f},{lat_max_us:.3f},"
    f"{usr:.2f},{sys_cpu:.2f},{usr + sys_cpu:.2f},{ctx},{path}"
)
PY
}

summarize_csv() {
  python3 - "${SUMMARY}" <<'PY'
import csv
import statistics as st
import sys
from collections import defaultdict

path = sys.argv[1]
rows = list(csv.DictReader(open(path, newline="", encoding="utf-8")))
groups = defaultdict(list)
for row in rows:
    groups[(row["mode"], row["jobs"])].append(row)

print("mode,jobs,n,err_sum,iops_mean,iops_stdev,bw_mib_mean,lat_avg_us_mean,cpu_total_mean,ctx_mean")
for key in sorted(groups, key=lambda x: (int(x[1]), ["INT", "CP", "LHP", "PAS"].index(x[0]))):
    vals = groups[key]
    def nums(name):
        return [float(v[name]) for v in vals]
    iops = nums("iops")
    bw = nums("bw_mib")
    lat = nums("lat_avg_us")
    cpu = nums("cpu_total")
    ctx = nums("ctx")
    err_sum = sum(int(v["err"]) for v in vals)
    iops_sd = st.stdev(iops) if len(iops) > 1 else 0.0
    print(
        f"{key[0]},{key[1]},{len(vals)},{err_sum},"
        f"{st.mean(iops):.2f},{iops_sd:.2f},{st.mean(bw):.2f},"
        f"{st.mean(lat):.3f},{st.mean(cpu):.2f},{st.mean(ctx):.0f}"
    )
PY
}

echo "repeat,mode,jobs,err,iops,bw_mib,lat_avg_us,lat_stdev_us,lat_min_us,lat_max_us,cpu_usr,cpu_sys,cpu_total,ctx,json" > "${SUMMARY}"

echo "== initial knobs =="
show_knobs | tee "${OUT}/03-initial-knobs.txt"

echo "== prefill =="
fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
  --rw=write --bs=1m --size="${PREFILL_SIZE}" --numjobs="${PREFILL_JOBS}" \
  --direct=1 --end_fsync=1 --group_reporting --name=prefill \
  --output-format=json --output="${OUT}/04-prefill.json"
python3 -m json.tool "${OUT}/04-prefill.json" > "${OUT}/04-prefill.pretty.json"
sync
ls -lh "${TESTDIR}"/testfile.* | tee "${OUT}/05-prefill-files.txt"

echo "== repeat test =="
for repeat in $(seq 1 "${REPEATS}"); do
  for jobs in ${JOBS}; do
    for mode in ${MODES}; do
      echo "## repeat=${repeat} jobs=${jobs} mode=${mode}"
      mode_dir="${OUT}/repeat-${repeat}/${jobs}T/${mode}"
      mkdir -p "${mode_dir}"
      set_mode "${mode}" | tee "${mode_dir}/knobs.txt"

      echo 3 > /proc/sys/vm/drop_caches

      hipri=()
      if [[ "${mode}" != "INT" ]]; then
        hipri=(--hipri)
      fi

      if (( WARMUP_RUNTIME > 0 )); then
        warmup_json="${mode_dir}/warmup.json"
        fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
          --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
          --iodepth=1 --runtime="${WARMUP_RUNTIME}" --ramp_time="${WARMUP_RAMP_TIME}" \
          --numjobs="${jobs}" --time_based --group_reporting --name=warmup \
          --eta-newline=1 "${hipri[@]}" \
          --output-format=json --output="${warmup_json}"

        python3 -m json.tool "${warmup_json}" > "${mode_dir}/warmup.pretty.json"
        echo 3 > /proc/sys/vm/drop_caches
      fi

      json="${mode_dir}/fio.json"
      fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
        --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
        --iodepth=1 --runtime="${RUNTIME}" --ramp_time="${RAMP_TIME}" \
        --numjobs="${jobs}" --time_based --group_reporting --name=run \
        --eta-newline=1 "${hipri[@]}" \
        --output-format=json --output="${json}"

      python3 -m json.tool "${json}" > "${mode_dir}/fio.pretty.json"
      append_summary "${repeat}" "${mode}" "${jobs}" "${json}" >> "${SUMMARY}"
      dmesg -T | tail -100 > "${mode_dir}/dmesg-after.txt"
    done
  done
done

echo "== dmesg important =="
dmesg -T \
  | grep -Ei 'panic|oops|BUG:|WARNING:|fail|error|nvme|i40e|pas|lhp' \
  | tail -200 \
  | tee "${OUT}/dmesg-important.txt" || true

echo "== aggregate =="
summarize_csv | tee "${OUT}/summary-aggregate.csv"

echo "REPEAT_DONE"
echo "log: ${OUT}"
echo "summary: ${SUMMARY}"
