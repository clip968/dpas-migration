#!/usr/bin/env bash
#
# Host one-touch runner for the full-DPAS micro_4krr sweep on this Optane host.
#
# Lineage:
#   * Execution UX (root/cmd checks, options, CPU online, parse + pretty
#     output, chown-back) is modeled on ../../run_all.sh.
#   * Device / sysfs-knob / fio mechanics are modeled on
#     ./run_optane_full_dpas_no_ehp.sh, but with the full-DPAS mode
#     (switch_enabled=1 + switch_param1~7) RE-ENABLED.
#
# It is self-contained: unlike run_all.sh (which drives micro_*/run.sh and the
# heavy 3-device macro benchmark), this script runs only the 4K random-read
# micro sweep on a single whole-disk NVMe (default nvme1n1) and tolerates a
# built-in nvme driver (modprobe reload is skipped automatically).
#
# WARNING: data-destructive. The prerun step runs `mkfs.xfs -f` on every
# target device. Pin DPAS_DEVICE_LIST to the disks you are willing to wipe.

set -euo pipefail
export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/scripts"
UTILS_DIR="${REPO_ROOT}/utils"

# ---------------------------------------------------------------------------
# run_all.sh-style wrapper helpers
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage:
  sudo ./run_host_dpas_optane.sh [--draft] [--clean] [--raw] [--no-parse] [-h]

Options:
  --draft     Quick smoke mode: short runtime, small thread sweep (all modes).
  --clean     Remove ./fio_data ./parsed_data ./result_data before running.
  --raw       Print raw parsed_data instead of the pretty table.
  --no-parse  Run fio only; skip parse.py / pretty_print.py.
  -h, --help  Show this help.

Environment overrides (comma-separated lists):
  DPAS_DEVICE_LIST   default: nvme1n1
  DPAS_IO_MODE       default: INT,CP,LHP,PAS,DPAS   (keep INT first for tables)
  DPAS_JOB_LIST      default: 20,16,8,4,2,1
  DPAS_RUNTIME       default: 10   (seconds per fio run)
  DPAS_REPEATS       default: 1
  DPAS_THRESHOLD     default: 30 for nvme1n1 (Optane theta=3), else 10
  DPAS_SWITCH_PARAM1..7  override individual DPAS switch params
                         (defaults: 0,10,<threshold>,1,100,1000,10000)
  DPAS_PYTHON        python used for parse/pretty-print
                     (default: repo-root .venv/bin/python3 if present, else python3)

Notes:
  * Full-DPAS mode sets pas_enabled=1, pas_adaptive_enabled=1, switch_enabled=1
    and switch_param1~7. switch_param3 defaults to the per-device threshold.
  * nvme is built-in on this host; modprobe reload is skipped and the boot
    nvme.poll_queues value is reused for all polling modes.
EOF
}

die() {
  echo "[ERROR] $*" >&2
  exit 1
}

require_root() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || die "this script must be run as root (sudo)."
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

join_by() {
  local sep="$1"
  shift
  local out="" item
  for item in "$@"; do
    if [ -z "${out}" ]; then
      out="${item}"
    else
      out="${out}${sep}${item}"
    fi
  done
  printf '%s' "${out}"
}

has_io_mode() {
  local wanted="$1" mode
  for mode in "${IO_MODE[@]}"; do
    [ "${mode}" = "${wanted}" ] && return 0
  done
  return 1
}

ensure_all_cpus_online() {
  local cpu_tool="${UTILS_DIR}/cpu"
  if [ -x "${cpu_tool}" ]; then
    echo "[INFO] bringing all CPUs online via utils/cpu"
    "${cpu_tool}" on || true
    return 0
  fi
  echo "[INFO] utils/cpu not found; bringing CPUs online via sysfs"
  local d
  for d in /sys/devices/system/cpu/cpu[0-9]*; do
    [ -d "${d}" ] || continue
    [ -f "${d}/online" ] || continue
    echo 1 > "${d}/online" 2>/dev/null || true
  done
}

chown_outputs_to_invoker() {
  local owner="${SUDO_USER:-}"
  [ -n "${owner}" ] && [ "${owner}" != "root" ] || return 0
  local p
  for p in "$@"; do
    [ -e "${p}" ] || continue
    chown -R "${owner}:${owner}" "${p}" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# Option parsing
# ---------------------------------------------------------------------------
DRAFT=0
CLEAN=0
RAW=0
DO_PARSE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --draft) DRAFT=1; shift ;;
    --clean) CLEAN=1; shift ;;
    --raw) RAW=1; shift ;;
    --no-parse) DO_PARSE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *) die "unexpected extra argument: $1" ;;
  esac
done

require_root
require_cmd fio
require_cmd python3
require_cmd mkfs.xfs
require_cmd mount
require_cmd umount
require_cmd findmnt

if ! fio --enghelp 2>/dev/null | grep -qw pvsync2; then
  die "fio pvsync2 engine is missing."
fi

# ---------------------------------------------------------------------------
# Sweep configuration (run_optane_full_dpas_no_ehp.sh-style, env-overridable)
# ---------------------------------------------------------------------------
DEVICES=("nvme1n1")
IO_MODE=("INT" "CP" "LHP" "PAS" "DPAS")
JOBS=(20 16 8 4 2 1)
RR_RW=("RR")
REPEATS="${DPAS_REPEATS:-1}"
RUNTIME="${DPAS_RUNTIME:-10}"

if [ -n "${DPAS_DEVICE_LIST:-}" ]; then
  IFS=',' read -r -a DEVICES <<< "${DPAS_DEVICE_LIST}"
fi
if [ -n "${DPAS_IO_MODE:-}" ]; then
  IFS=',' read -r -a IO_MODE <<< "${DPAS_IO_MODE}"
fi
if [ -n "${DPAS_JOB_LIST:-}" ]; then
  IFS=',' read -r -a JOBS <<< "${DPAS_JOB_LIST}"
fi

SLEEP_DROP="${DPAS_SLEEP_DROP:-1}"
SLEEP_AFTER_RUN="${DPAS_SLEEP_AFTER_RUN:-1}"
SLEEP_AFTER_UMOUNT="${DPAS_SLEEP_AFTER_UMOUNT:-1}"
PRERUN_RUNTIME="${DPAS_PRERUN_RUNTIME:-60}"

# DPAS switch_param defaults (run.sh-verified values; param3 = per-dev threshold)
SW1="${DPAS_SWITCH_PARAM1:-0}"
SW2="${DPAS_SWITCH_PARAM2:-10}"
SW4="${DPAS_SWITCH_PARAM4:-1}"
SW5="${DPAS_SWITCH_PARAM5:-100}"
SW6="${DPAS_SWITCH_PARAM6:-1000}"
SW7="${DPAS_SWITCH_PARAM7:-10000}"

if [ "${DRAFT}" -eq 1 ]; then
  RUNTIME=5
  PRERUN_RUNTIME=5
  JOBS=(8 1)
  CLEAN=1
  echo "[INFO] --draft: RUNTIME=${RUNTIME}, JOBS=${JOBS[*]}, all modes kept"
fi

# Keep parse.py (which reads the same env) in lockstep with what we actually run.
export DPAS_DEVICE_LIST="$(join_by , "${DEVICES[@]}")"
export DPAS_IO_MODE="$(join_by , "${IO_MODE[@]}")"
export DPAS_JOB_LIST="$(join_by , "${JOBS[@]}")"
export DPAS_RW_FLAGS="$(join_by , "${RR_RW[@]}")"

case "${IO_MODE[0]}" in
  INT) ;;
  *) echo "[WARN] IO_MODE[0]=${IO_MODE[0]} (not INT); parse.py tables may misalign." >&2 ;;
esac

# fio affinity: honor cpuset/cgroup-allowed CPUs to avoid fio_setaffinity errors.
CPU_ALLOWED_LIST="$(awk -F: '/Cpus_allowed_list/ {gsub(/^[ \t]+/, "", $2); print $2}' /proc/self/status || true)"
if [ -z "${CPU_ALLOWED_LIST}" ]; then
  CPU_ALLOWED_LIST="0-$(( $(nproc --all) - 1 ))"
fi

if [ -e /sys/module/nvme/initstate ]; then
  NVME_RELOADABLE=1
else
  NVME_RELOADABLE=0
fi

# ---------------------------------------------------------------------------
# sysfs knob + nvme helpers
# ---------------------------------------------------------------------------
nvme_setup() {
  local poll_queues="$1"
  if [ "${NVME_RELOADABLE}" = "1" ]; then
    if [ -n "${poll_queues}" ]; then
      modprobe -r nvme && modprobe nvme poll_queues="${poll_queues}"
    else
      modprobe -r nvme && modprobe nvme
    fi
    sleep "${DPAS_SLEEP_AFTER_MODPROBE:-1}"
  else
    echo "[info] nvme is builtin; skipping modprobe reload (poll_queues stays at boot value)"
  fi
}

wq() {
  local device="$1" name="$2" value="$3"
  local knob="/sys/block/${device}/queue/${name}"
  # Missing knob = skip (kernels differ); an existing knob that rejects the
  # write = real failure, so abort rather than silently degrade the mode.
  if [ -e "${knob}" ]; then
    echo "${value}" > "${knob}" || die "failed to write '${value}' to ${knob}"
  fi
  return 0
}

reset_queue_knobs() {
  local device="$1"
  wq "$device" io_poll_delay -1
  wq "$device" nomerges 0
  wq "$device" pas_enabled 0
  wq "$device" pas_adaptive_enabled 0
  wq "$device" ehp_enabled 0
  wq "$device" switch_enabled 0
}

set_mode_knobs() {
  local device="$1" mode="$2" threshold="$3"
  reset_queue_knobs "${device}"
  case "${mode}" in
    INT)
      ;;
    CP)
      wq "$device" io_poll 1
      ;;
    LHP)
      wq "$device" io_poll 1
      wq "$device" io_poll_delay 0
      ;;
    PAS)
      wq "$device" io_poll 1
      wq "$device" io_poll_delay 0
      wq "$device" pas_enabled 1
      wq "$device" pas_adaptive_enabled 1
      ;;
    DPAS)
      # Full DPAS runtime mode switching.
      wq "$device" io_poll 1
      wq "$device" io_poll_delay 0
      wq "$device" pas_enabled 1
      wq "$device" pas_adaptive_enabled 1
      wq "$device" logging_enabled 2
      wq "$device" switch_param1 "${SW1}"
      wq "$device" switch_param2 "${SW2}"
      wq "$device" switch_param3 "${DPAS_SWITCH_PARAM3:-${threshold}}"
      wq "$device" switch_param4 "${SW4}"
      wq "$device" switch_param5 "${SW5}"
      wq "$device" switch_param6 "${SW6}"
      wq "$device" switch_param7 "${SW7}"
      # switch_enabled last: enabling it resets the switch state machine.
      wq "$device" switch_enabled 1
      ;;
    *)
      echo "[WARN] unsupported mode '${mode}', running with reset knobs only." >&2
      ;;
  esac
}

dev_threshold() {
  local device="$1"
  if [ -n "${DPAS_THRESHOLD:-}" ]; then
    echo "${DPAS_THRESHOLD}"
  elif [ "${device}" = "nvme1n1" ]; then
    echo 30   # Optane 5800X, theta := 3 (10x)
  else
    echo 10   # NAND SSDs, theta := 1 (10x)
  fi
}

require_knob() {
  local device="$1" name="$2"
  [ -e "/sys/block/${device}/queue/${name}" ] \
    || die "missing required sysfs knob /sys/block/${device}/queue/${name} (is the DPAS kernel booted?)"
}

# Validate a target device (and the knobs the selected modes need) BEFORE any
# destructive mkfs, so a missing device/knob fails loudly instead of silently
# running fio against the wrong filesystem or in a degraded mode.
preflight_device() {
  local device="$1" mode n
  [ -b "/dev/${device}" ] || die "/dev/${device} is not a block device; refusing to test '${device}'."
  require_knob "${device}" io_poll
  require_knob "${device}" io_poll_delay
  for mode in "${IO_MODE[@]}"; do
    case "${mode}" in
      PAS|DPAS)
        require_knob "${device}" pas_enabled
        require_knob "${device}" pas_adaptive_enabled
        ;;
    esac
    if [ "${mode}" = "DPAS" ]; then
      require_knob "${device}" switch_enabled
      require_knob "${device}" logging_enabled
      require_knob "${device}" dpas_switch_stats
      for n in 1 2 3 4 5 6 7; do
        require_knob "${device}" "switch_param${n}"
      done
    fi
  done
}

# ---------------------------------------------------------------------------
# Run from the experiment dir so fio_data/parsed_data land beside parse.py.
# ---------------------------------------------------------------------------
cd "${SCRIPT_DIR}" || die "cannot cd into ${SCRIPT_DIR}"

if [ "${CLEAN}" -eq 1 ]; then
  rm -rf ./fio_data ./parsed_data ./result_data || true
fi

echo "============================================================"
echo "[RUN] host full-DPAS micro_4krr"
echo "  devices : ${DEVICES[*]}"
echo "  modes   : ${IO_MODE[*]}"
echo "  jobs    : ${JOBS[*]}"
echo "  repeats : ${REPEATS}"
echo "  runtime : ${RUNTIME}s   nvme reloadable: ${NVME_RELOADABLE}"
echo "  poll_q  : $(cat /sys/module/nvme/parameters/poll_queues 2>/dev/null || echo '?')"
echo "============================================================"

ensure_all_cpus_online

# Fail fast (before the destructive mkfs) if a target device or required knob
# is absent.
for device in "${DEVICES[@]}"; do
  preflight_device "${device}"
done

# Precondition (mkfs.xfs -f + write fill) — run from scripts/ like the others.
(
  cd "${SCRIPTS_DIR}" || exit 1
  for device in "${DEVICES[@]}"; do
    DPAS_PRERUN_RUNTIME="${PRERUN_RUNTIME}" ./xfs_fio_prerun.sh "${device}"
  done
) || die "precondition (xfs_fio_prerun) failed; aborting before fio."

for device in "${DEVICES[@]}"; do
  mkdir -p "test_${device}"
  umount "/dev/${device}" 2>/dev/null || true
  sleep "${SLEEP_AFTER_UMOUNT}"
done

cleanup() {
  trap - EXIT INT TERM
  set +e
  local device kv knob
  for device in "${DEVICES[@]}"; do
    # Best-effort knob reset; cleanup must never abort.
    for kv in io_poll_delay=-1 nomerges=0 pas_enabled=0 pas_adaptive_enabled=0 ehp_enabled=0 switch_enabled=0; do
      knob="/sys/block/${device}/queue/${kv%%=*}"
      [ -e "${knob}" ] && echo "${kv#*=}" > "${knob}" 2>/dev/null
    done
    umount "test_${device}" 2>/dev/null
    umount "/dev/${device}" 2>/dev/null
  done
  chown_outputs_to_invoker ./fio_data ./parsed_data ./result_data ./test_* 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

echo "[INFO] start: $(date)"

for rr_rw in "${RR_RW[@]}"; do
  for repeat in $(seq 1 "${REPEATS}"); do
    for job in "${JOBS[@]}"; do
      for device in "${DEVICES[@]}"; do
        threshold="$(dev_threshold "${device}")"
        for mode in "${IO_MODE[@]}"; do

          mkdir -p "./fio_data/${device}/${rr_rw}/${job}T/${mode}"
          echo 3 > /proc/sys/vm/drop_caches
          sleep "${SLEEP_DROP}"

          FIO_CMD="fio --directory=./test_${device} --filename_format=testfile.\$jobnum --direct=1 --ramp_time=3 --size=100m --bs=4k --ioengine=pvsync2 --iodepth=1 --runtime=${RUNTIME} --numjobs=${job} --time_based --group_reporting --name=run --eta-newline=1 --cpus_allowed=${CPU_ALLOWED_LIST} --cpus_allowed_policy=split --nice=-10 --prioclass=2 --prio=0"

          if [ "${rr_rw}" = "RR" ]; then
            FIO_CMD="${FIO_CMD} --readonly --rw=randread"
          else
            FIO_CMD="${FIO_CMD} --rw=randwrite"
          fi

          # Polling modes use the high-priority (poll) completion path.
          if [ "${mode}" != "INT" ]; then
            FIO_CMD="${FIO_CMD} --hipri"
            nvme_setup "${job}"
          else
            nvme_setup ""
          fi

          set_mode_knobs "${device}" "${mode}" "${threshold}"

          mount "/dev/${device}" "test_${device}" \
            || die "mount /dev/${device} -> test_${device} failed (${mode} ${job}T)"
          # Guard against fio hitting the local fs if the mount silently no-op'd.
          mnt_src="$(findmnt -rn -o SOURCE "${PWD}/test_${device}" 2>/dev/null || true)"
          if [ "$(readlink -f "${mnt_src}")" != "$(readlink -f "/dev/${device}")" ]; then
            die "test_${device} is mounted from '${mnt_src}', not /dev/${device}; refusing to run fio on the wrong filesystem"
          fi

          echo "${device} repeat${repeat} ${mode} ${job}T ${rr_rw}"
          ${FIO_CMD} > "./fio_data/${device}/${rr_rw}/${job}T/${mode}/fio_report_${repeat}.log" \
            || die "fio failed for ${device} ${mode} ${job}T"
          if [ "${mode}" = "DPAS" ]; then
            cat "/sys/block/${device}/queue/dpas_switch_stats" \
              > "./fio_data/${device}/${rr_rw}/${job}T/${mode}/dpas_switch_stats_${repeat}.txt" \
              || die "failed to capture dpas_switch_stats for ${device} ${mode} ${job}T"
          fi
          sync
          umount "/dev/${device}" || die "umount /dev/${device} failed"
          sleep "${SLEEP_AFTER_RUN}"

        done
      done
    done
  done
done

echo "[INFO] end: $(date)"

# ---------------------------------------------------------------------------
# Parse + pretty output (run_all.sh-style)
# ---------------------------------------------------------------------------
if [ "${DO_PARSE}" -eq 1 ]; then
  # Prefer the repo-root venv python for parsing if present (it has numpy, which
  # mean_std.py needs); fall back to system python3. Override with DPAS_PYTHON.
  PYBIN="${DPAS_PYTHON:-python3}"
  if [ -z "${DPAS_PYTHON:-}" ] && [ -x "${REPO_ROOT}/.venv/bin/python3" ]; then
    PYBIN="${REPO_ROOT}/.venv/bin/python3"
    # parse.py spawns `python3 mean_std.py` via os.system, so put the venv on
    # PATH too — otherwise that child would fall back to system python3.
    export PATH="${REPO_ROOT}/.venv/bin:${PATH}"
  fi
  echo
  echo "[OUTPUT] parsing fio_data -> parsed_data  (python: ${PYBIN})"
  if "${PYBIN}" ./parse.py "${REPEATS}"; then
    if [ "${RAW}" -eq 1 ]; then
      for f in ./parsed_data/*; do
        [ -f "${f}" ] || continue
        cat "${f}"
      done
    elif [ -f "${UTILS_DIR}/pretty_print.py" ]; then
      "${PYBIN}" "${UTILS_DIR}/pretty_print.py" ./parsed_data || true
    else
      for f in ./parsed_data/*; do
        [ -f "${f}" ] || continue
        cat "${f}"
      done
    fi
    if has_io_mode DPAS; then
      echo
      echo "[OUTPUT] parsing dpas_switch_stats -> parsed_data/result_data"
      "${PYBIN}" ./parse_dpas_switch_stats.py "${REPEATS}" || \
        echo "[WARN] parse_dpas_switch_stats.py failed." >&2
    fi
  else
    echo "[WARN] parse.py failed (a mode may have produced no fio output)." >&2
  fi
fi

echo "DONE"
