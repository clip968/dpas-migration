#!/usr/bin/env bash
set -euo pipefail

DEV="${DPAS_DEV:-nvme1n1}"
PART="${DPAS_PART:-nvme1n1p1}"
MNT="${DPAS_MNT:-/mnt/dpas-optane}"
TESTDIR="${DPAS_TESTDIR:-${MNT}/dpas-host-test-ext4-probe}"
LOG_ROOT="${DPAS_LOG_ROOT:-/tmp/dpas-host-postboot}"
RUNTIME="${DPAS_RUNTIME:-27}"
RAMP_TIME="${DPAS_RAMP_TIME:-3}"
WARMUP_RUNTIME="${DPAS_WARMUP_RUNTIME:-5}"
WARMUP_RAMP_TIME="${DPAS_WARMUP_RAMP_TIME:-3}"
REPEATS="${DPAS_REPEATS:-5}"
JOBS="${DPAS_JOBS:-1}"
FILE_SIZE="${DPAS_FILE_SIZE:-100m}"
CASES="${DPAS_EXT4_CASES:-cold same-file-same-seed same-file-diff-seed diff-file-same-seed}"
MODES="${DPAS_MODES:-CP}"
SEED_A="${DPAS_RANDSEED_A:-0x89}"
SEED_B="${DPAS_RANDSEED_B:-0x12345}"
DRY_RUN="${DPAS_DRY_RUN:-0}"

RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT="${LOG_ROOT}/ext4-file-precondition-${RUN_ID}"
SUMMARY="${OUT}/summary.csv"
Q="/sys/block/${DEV}/queue"
FILE_A="${TESTDIR}/fileA"
FILE_B="${TESTDIR}/fileB"

for jobs in ${JOBS}; do
  if [[ "${jobs}" != "1" ]]; then
    echo "This probe is intentionally limited to DPAS_JOBS=1." >&2
    exit 1
  fi
done

for mode in ${MODES}; do
  case "${mode}" in
    INT|CP|LHP|PAS) ;;
    *)
      echo "Unsupported mode: ${mode}. Allowed: INT CP LHP PAS" >&2
      exit 1
      ;;
  esac
done

for case_name in ${CASES}; do
  case "${case_name}" in
    cold|same-file-same-seed|same-file-diff-seed|diff-file-same-seed) ;;
    *)
      echo "Unsupported case: ${case_name}." >&2
      echo "Allowed: cold same-file-same-seed same-file-diff-seed diff-file-same-seed" >&2
      exit 1
      ;;
  esac
done

if [[ "${DRY_RUN}" == "1" || "${DRY_RUN}" == "yes" ]]; then
  for case_name in ${CASES}; do
    measured_file="${FILE_A}"
    warmup_file="none"
    seed="${SEED_A}"
    warmup_seed="none"
    case "${case_name}" in
      cold)
        ;;
      same-file-same-seed)
        warmup_file="${FILE_A}"
        warmup_seed="${SEED_A}"
        ;;
      same-file-diff-seed)
        warmup_file="${FILE_A}"
        warmup_seed="${SEED_A}"
        seed="${SEED_B}"
        ;;
      diff-file-same-seed)
        warmup_file="${FILE_B}"
        warmup_seed="${SEED_A}"
        ;;
    esac
    echo "case=${case_name} measured_file=${measured_file} warmup_file=${warmup_file} seed=${seed} warmup_seed=${warmup_seed}"
    echo "fio --name=run --filename=${measured_file} --readonly --rw=randread --bs=4k --direct=1 --ioengine=pvsync2 --iodepth=1 --numjobs=1 --runtime=${RUNTIME} --ramp_time=${RAMP_TIME} --randrepeat=1 --randseed=${seed}"
  done
  exit 0
fi

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
ln -sfn "${OUT}" "${LOG_ROOT}/ext4-file-precondition-latest"

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

mkdir -p "${TESTDIR}"
if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
  chown "${SUDO_UID}:${SUDO_GID}" "${TESTDIR}" || true
fi

echo "repeat,case,mode,jobs,measured_file,warmup_file,seed,warmup_seed,err,iops,bw_mib,lat_avg_us,lat_stdev_us,lat_p50_us,lat_p95_us,lat_p99_us,cpu_usr,cpu_sys,cpu_total,ctx,json" > "${SUMMARY}"

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
  sync
  if [[ "${MOUNTED_BY_SCRIPT}" == "1" ]]; then
    echo "Leaving ${MNT} mounted. Unmount manually if desired."
  fi
  if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
    chown -R "${SUDO_UID}:${SUDO_GID}" "${OUT}" "${TESTDIR}" || true
  fi
}
trap cleanup EXIT

append_summary() {
  local repeat="$1"
  local case_name="$2"
  local mode="$3"
  local jobs="$4"
  local measured_file="$5"
  local warmup_file="$6"
  local seed="$7"
  local warmup_seed="$8"
  local json="$9"
  python3 - "$repeat" "$case_name" "$mode" "$jobs" "$measured_file" "$warmup_file" "$seed" "$warmup_seed" "$json" <<'PY'
import json
import sys

repeat, case_name, mode, jobs, measured_file, warmup_file, seed, warmup_seed, path = sys.argv[1:10]
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
    f"{repeat},{case_name},{mode},{jobs},{measured_file},{warmup_file},"
    f"{seed},{warmup_seed},{err},{iops:.2f},{bw_mib:.2f},"
    f"{lat_avg_us:.3f},{lat_stdev_us:.3f},{lat_p50_us:.3f},"
    f"{lat_p95_us:.3f},{lat_p99_us:.3f},{usr:.2f},{sys_cpu:.2f},"
    f"{usr + sys_cpu:.2f},{ctx},{path}"
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

fio_file_read() {
  local name="$1"
  local mode="$2"
  local file="$3"
  local runtime="$4"
  local ramp="$5"
  local seed="$6"
  local output="$7"

  local hipri=()
  if [[ "${mode}" != "INT" ]]; then
    hipri=(--hipri)
  fi

  fio --name="${name}" --filename="${file}" \
    --readonly --rw=randread --bs=4k --direct=1 --ioengine=pvsync2 \
    --iodepth=1 --numjobs=1 --time_based \
    --runtime="${runtime}" --ramp_time="${ramp}" --group_reporting \
    --eta-newline=1 --randrepeat=1 --randseed="${seed}" "${hipri[@]}" \
    --output-format=json --output="${output}"
}

prefill_file() {
  local name="$1"
  local file="$2"
  local output="$3"
  fio --name="${name}" --filename="${file}" \
    --rw=write --bs=1m --size="${FILE_SIZE}" --direct=1 --end_fsync=1 \
    --group_reporting --output-format=json --output="${output}"
}

{
  date '+%Y-%m-%d %H:%M:%S %Z %z'
  uname -a
  cat /proc/cmdline
  echo "nvme.poll_queues=${POLL_QUEUES}"
  echo "mount=${MNT}"
  echo "testdir=${TESTDIR}"
  echo "file_a=${FILE_A}"
  echo "file_b=${FILE_B}"
  echo "cases=${CASES}"
  echo "modes=${MODES}"
  echo "jobs=${JOBS}"
  echo "repeats=${REPEATS}"
  echo "runtime=${RUNTIME}"
  echo "ramp_time=${RAMP_TIME}"
  echo "warmup_runtime=${WARMUP_RUNTIME}"
  echo "warmup_ramp_time=${WARMUP_RAMP_TIME}"
  echo "file_size=${FILE_SIZE}"
  echo "seed_a=${SEED_A}"
  echo "seed_b=${SEED_B}"
  echo "randrepeat=1"
} | tee "${OUT}/00-basic.txt"

findmnt "${MNT}" | tee "${OUT}/01-findmnt.txt"
lsblk -o NAME,TYPE,SIZE,FSTYPE,UUID,PARTUUID,MOUNTPOINTS,MODEL "/dev/${DEV}" \
  | tee "${OUT}/02-lsblk-${DEV}.txt"

echo "== initial knobs =="
show_knobs | tee "${OUT}/03-initial-knobs.txt"

echo "== prefill ext4 files =="
prefill_file prefill-fileA "${FILE_A}" "${OUT}/04-prefill-fileA.json"
prefill_file prefill-fileB "${FILE_B}" "${OUT}/05-prefill-fileB.json"
python3 -m json.tool "${OUT}/04-prefill-fileA.json" > "${OUT}/04-prefill-fileA.pretty.json"
python3 -m json.tool "${OUT}/05-prefill-fileB.json" > "${OUT}/05-prefill-fileB.pretty.json"
sync
ls -lh "${FILE_A}" "${FILE_B}" | tee "${OUT}/06-prefill-files.txt"
if command -v filefrag >/dev/null 2>&1; then
  filefrag -v "${FILE_A}" "${FILE_B}" > "${OUT}/07-filefrag.txt" || true
else
  echo "filefrag not found" > "${OUT}/07-filefrag.txt"
fi

echo "== ext4 file precondition probe =="
for repeat in $(seq 1 "${REPEATS}"); do
  for jobs in ${JOBS}; do
    for mode in ${MODES}; do
      for case_name in ${CASES}; do
        echo "## repeat=${repeat} jobs=${jobs} mode=${mode} case=${case_name}"
        case_dir="${OUT}/repeat-${repeat}/${jobs}T/${mode}/${case_name}"
        mkdir -p "${case_dir}"
        set_mode "${mode}" | tee "${case_dir}/knobs.txt"
        echo 3 > /proc/sys/vm/drop_caches

        measured_file="${FILE_A}"
        warmup_file="none"
        seed="${SEED_A}"
        warmup_seed="none"
        case "${case_name}" in
          cold)
            ;;
          same-file-same-seed)
            warmup_file="${FILE_A}"
            warmup_seed="${SEED_A}"
            ;;
          same-file-diff-seed)
            warmup_file="${FILE_A}"
            warmup_seed="${SEED_A}"
            seed="${SEED_B}"
            ;;
          diff-file-same-seed)
            warmup_file="${FILE_B}"
            warmup_seed="${SEED_A}"
            ;;
        esac

        if [[ "${warmup_file}" != "none" ]]; then
          fio_file_read warmup "${mode}" "${warmup_file}" "${WARMUP_RUNTIME}" "${WARMUP_RAMP_TIME}" "${warmup_seed}" "${case_dir}/warmup.json"
          python3 -m json.tool "${case_dir}/warmup.json" > "${case_dir}/warmup.pretty.json"
          echo 3 > /proc/sys/vm/drop_caches
        fi

        fio_file_read run "${mode}" "${measured_file}" "${RUNTIME}" "${RAMP_TIME}" "${seed}" "${case_dir}/fio.json"
        python3 -m json.tool "${case_dir}/fio.json" > "${case_dir}/fio.pretty.json"
        append_summary "${repeat}" "${case_name}" "${mode}" "${jobs}" "${measured_file}" "${warmup_file}" "${seed}" "${warmup_seed}" "${case_dir}/fio.json" >> "${SUMMARY}"
        dmesg -T | tail -100 > "${case_dir}/dmesg-after.txt"
      done
    done
  done
done

echo "== aggregate =="
summarize_csv | tee "${OUT}/summary-aggregate.csv"

echo "EXT4_FILE_PRECONDITION_DONE"
echo "log: ${OUT}"
echo "summary: ${SUMMARY}"
