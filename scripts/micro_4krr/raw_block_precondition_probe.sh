#!/usr/bin/env bash
set -euo pipefail

PART="${DPAS_RAW_PART:-/dev/nvme1n1p1}"
DEV="${DPAS_DEV:-nvme1n1}"
LOG_ROOT="${DPAS_LOG_ROOT:-/tmp/dpas-host-postboot}"
RUNTIME="${DPAS_RUNTIME:-27}"
RAMP_TIME="${DPAS_RAMP_TIME:-3}"
WARMUP_RUNTIME="${DPAS_WARMUP_RUNTIME:-5}"
WARMUP_RAMP_TIME="${DPAS_WARMUP_RAMP_TIME:-3}"
REPEATS="${DPAS_REPEATS:-5}"
JOBS="${DPAS_JOBS:-1}"
RAW_OFFSET="${DPAS_RAW_OFFSET:-4g}"
RAW_SIZE="${DPAS_RAW_SIZE:-100m}"
CASES="${DPAS_RAW_CASES:-cold same-seed diff-seed}"
MODES="${DPAS_MODES:-CP}"
SEED_A="${DPAS_RANDSEED_A:-0x89}"
SEED_B="${DPAS_RANDSEED_B:-0x12345}"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT="${LOG_ROOT}/raw-block-precondition-${RUN_ID}"
SUMMARY="${OUT}/summary.csv"
Q="/sys/block/${DEV}/queue"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

if [[ ! -b "${PART}" ]]; then
  echo "Missing block device: ${PART}" >&2
  exit 1
fi

if [[ "${PART}" == "/dev/${DEV}" ]]; then
  echo "Refusing whole disk ${PART}; use a partition such as /dev/${DEV}p1." >&2
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

mkdir -p "${OUT}"
ln -sfn "${OUT}" "${LOG_ROOT}/raw-block-precondition-latest"

echo "repeat,case,mode,jobs,seed,warmup_seed,err,iops,bw_mib,lat_avg_us,lat_stdev_us,lat_p50_us,lat_p95_us,lat_p99_us,cpu_usr,cpu_sys,cpu_total,ctx,json" > "${SUMMARY}"

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
  esac
  show_knobs
}

cleanup() {
  set +e
  reset_knobs
  show_knobs > "${OUT}/final-knobs.txt"
  if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
    chown -R "${SUDO_UID}:${SUDO_GID}" "${OUT}" || true
  fi
}
trap cleanup EXIT

append_summary() {
  local repeat="$1"
  local case_name="$2"
  local mode="$3"
  local jobs="$4"
  local seed="$5"
  local warmup_seed="$6"
  local json="$7"
  python3 - "$repeat" "$case_name" "$mode" "$jobs" "$seed" "$warmup_seed" "$json" <<'PY'
import json
import sys

repeat, case_name, mode, jobs, seed, warmup_seed, path = sys.argv[1:8]
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
clat = read.get("clat_ns") or lat
pct = clat.get("percentile", {})
lat_avg_us = float(lat.get("mean", 0.0)) / 1000
lat_stdev_us = float(lat.get("stddev", 0.0)) / 1000
lat_p50_us = float(pct.get("50.000000", 0.0)) / 1000
lat_p95_us = float(pct.get("95.000000", 0.0)) / 1000
lat_p99_us = float(pct.get("99.000000", 0.0)) / 1000
usr = float(job.get("usr_cpu", 0.0))
sys_cpu = float(job.get("sys_cpu", 0.0))
ctx = int(job.get("ctx", 0))

print(
    f"{repeat},{case_name},{mode},{jobs},{seed},{warmup_seed},{err},"
    f"{iops:.2f},{bw_mib:.2f},{lat_avg_us:.3f},{lat_stdev_us:.3f},"
    f"{lat_p50_us:.3f},{lat_p95_us:.3f},{lat_p99_us:.3f},"
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

rows = list(csv.DictReader(open(sys.argv[1], newline="", encoding="utf-8")))
groups = defaultdict(list)
for row in rows:
    groups[(row["case"], row["mode"], row["jobs"])].append(row)

print("case,mode,jobs,n,err_sum,iops_mean,iops_stdev,lat_avg_us_mean,lat_p95_us_mean,lat_p99_us_mean,cpu_total_mean,ctx_mean")
for key in sorted(groups):
    vals = groups[key]
    def nums(name):
        return [float(v[name]) for v in vals]
    iops = nums("iops")
    err_sum = sum(int(v["err"]) for v in vals)
    print(
        f"{key[0]},{key[1]},{key[2]},{len(vals)},{err_sum},"
        f"{st.mean(iops):.2f},{(st.stdev(iops) if len(iops) > 1 else 0.0):.2f},"
        f"{st.mean(nums('lat_avg_us')):.3f},{st.mean(nums('lat_p95_us')):.3f},"
        f"{st.mean(nums('lat_p99_us')):.3f},{st.mean(nums('cpu_total')):.2f},"
        f"{st.mean(nums('ctx')):.0f}"
    )
PY
}

fio_raw_read() {
  local name="$1"
  local mode="$2"
  local jobs="$3"
  local runtime="$4"
  local ramp="$5"
  local seed="$6"
  local output="$7"

  local hipri=()
  if [[ "${mode}" != "INT" ]]; then
    hipri=(--hipri)
  fi

  fio --name="${name}" --filename="${PART}" \
    --readonly --rw=randread --bs=4k --direct=1 --ioengine=pvsync2 \
    --iodepth=1 --numjobs="${jobs}" --time_based \
    --runtime="${runtime}" --ramp_time="${ramp}" --group_reporting \
    --eta-newline=1 --offset="${RAW_OFFSET}" --size="${RAW_SIZE}" \
    --randrepeat=1 --randseed="${seed}" "${hipri[@]}" \
    --output-format=json --output="${output}"
}

{
  date '+%Y-%m-%d %H:%M:%S %Z %z'
  uname -a
  cat /proc/cmdline
  echo "part=${PART}"
  echo "nvme.poll_queues=${POLL_QUEUES}"
  echo "cases=${CASES}"
  echo "modes=${MODES}"
  echo "jobs=${JOBS}"
  echo "repeats=${REPEATS}"
  echo "runtime=${RUNTIME}"
  echo "ramp_time=${RAMP_TIME}"
  echo "warmup_runtime=${WARMUP_RUNTIME}"
  echo "warmup_ramp_time=${WARMUP_RAMP_TIME}"
  echo "raw_offset=${RAW_OFFSET}"
  echo "raw_size=${RAW_SIZE}"
  echo "seed_a=${SEED_A}"
  echo "seed_b=${SEED_B}"
  echo "randrepeat=1"
} | tee "${OUT}/00-basic.txt"

lsblk -o NAME,TYPE,SIZE,FSTYPE,UUID,PARTUUID,MOUNTPOINTS,MODEL "${PART}" \
  | tee "${OUT}/01-lsblk.txt"
findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS "${PART}" 2>/dev/null \
  | tee "${OUT}/02-findmnt-part.txt" || true

echo "== initial knobs =="
show_knobs | tee "${OUT}/03-initial-knobs.txt"

echo "== raw block precondition probe =="
for repeat in $(seq 1 "${REPEATS}"); do
  for jobs in ${JOBS}; do
    for mode in ${MODES}; do
      for case_name in ${CASES}; do
        echo "## repeat=${repeat} jobs=${jobs} mode=${mode} case=${case_name}"
        case_dir="${OUT}/repeat-${repeat}/${jobs}T/${mode}/${case_name}"
        mkdir -p "${case_dir}"
        set_mode "${mode}" | tee "${case_dir}/knobs.txt"
        echo 3 > /proc/sys/vm/drop_caches

        seed="${SEED_A}"
        warmup_seed="none"
        case "${case_name}" in
          cold)
            ;;
          same-seed)
            warmup_seed="${SEED_A}"
            fio_raw_read warmup "${mode}" "${jobs}" "${WARMUP_RUNTIME}" "${WARMUP_RAMP_TIME}" "${warmup_seed}" "${case_dir}/warmup.json"
            python3 -m json.tool "${case_dir}/warmup.json" > "${case_dir}/warmup.pretty.json"
            echo 3 > /proc/sys/vm/drop_caches
            ;;
          diff-seed)
            warmup_seed="${SEED_A}"
            seed="${SEED_B}"
            fio_raw_read warmup "${mode}" "${jobs}" "${WARMUP_RUNTIME}" "${WARMUP_RAMP_TIME}" "${warmup_seed}" "${case_dir}/warmup.json"
            python3 -m json.tool "${case_dir}/warmup.json" > "${case_dir}/warmup.pretty.json"
            echo 3 > /proc/sys/vm/drop_caches
            ;;
          *)
            echo "Unsupported case: ${case_name}. Allowed: cold same-seed diff-seed" >&2
            exit 1
            ;;
        esac

        fio_raw_read run "${mode}" "${jobs}" "${RUNTIME}" "${RAMP_TIME}" "${seed}" "${case_dir}/fio.json"
        python3 -m json.tool "${case_dir}/fio.json" > "${case_dir}/fio.pretty.json"
        append_summary "${repeat}" "${case_name}" "${mode}" "${jobs}" "${seed}" "${warmup_seed}" "${case_dir}/fio.json" >> "${SUMMARY}"
        dmesg -T | tail -100 > "${case_dir}/dmesg-after.txt"
      done
    done
  done
done

echo "== aggregate =="
summarize_csv | tee "${OUT}/summary-aggregate.csv"

echo "RAW_BLOCK_PRECONDITION_DONE"
echo "log: ${OUT}"
echo "summary: ${SUMMARY}"
