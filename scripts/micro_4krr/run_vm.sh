#!/bin/bash
#
# run_vm.sh — micro_4krr runner adapted for the DPAS VM (and bare metal).
#
# Differences from run.sh (Option A, sub-choice (b): reuse ext4):
#   1. nvme module is AUTO-DETECTED:
#        - loadable module (bare metal): behaves like run.sh
#          (modprobe -r nvme && modprobe nvme poll_queues=N, which also resets device state)
#        - built-in (VM): modprobe is impossible, so it is SKIPPED. poll_queues stays at the
#          value fixed by the kernel cmdline (nvme.poll_queues=N).
#   2. Because the built-in path cannot reload the driver, DPAS/queue knobs (including PAS
#      learning state) are reset EXPLICITLY at the start of every mode (reset_knobs) so state
#      does not leak between modes or repeated runs.
#   3. No mkfs.xfs / xfsprogs dependency. The existing ext4 scratch filesystem is reused
#      as-is (mkfs.ext4 -F is done ONLY if the device has no filesystem at all).
#   4. No conditioning warmup. A short fio --create_only pass only LAYS OUT the read target
#      files (testfile.N, 100m each); this is required because the read workload is --readonly.
#
# Mode labels (this is a pre-full-DPAS performance-signal exploration):
#   INT   = non-hipri interrupt baseline
#   CP    = hipri classic polling
#   LHP   = adaptive LHP, io_poll_delay=0
#   PAS   = PAS, adaptive up/dn off  (pas_enabled=1, pas_adaptive_enabled=0)
#   DPAS1 = PAS + adaptive up/dn on  (pas_enabled=1, pas_adaptive_enabled=1)
#   (full DPAS mode switching via switch_* is intentionally NOT exercised here)
#
# Output layout is identical to run.sh:
#   ./fio_data/<dev>/<rw>/<job>T/<mode>/fio_report_<repeat>.log
# so parse.py / pretty_print.py work without modification.
#
# WARNING: still data-affecting. It umounts the target device and, if the device has no
# filesystem, runs mkfs.ext4 -F. Point DPAS_DEVICE_LIST at a scratch device only.

DEVICES=("nvme0n1" "nvme1n1" "nvme2n1")
IO_MODE=("CP" "DPAS1" "PAS" "LHP" "INT")
JOBS=(20 16 8 4 2 1)
RR_RW=("RR")
REPEATS=(1)
MAX_CORE=20
RUNTIME="${DPAS_RUNTIME:-10}"

# Optional overrides (comma-separated)
if [[ -n "${DPAS_DEVICE_LIST:-}" ]]; then
  IFS=',' read -r -a DEVICES <<< "${DPAS_DEVICE_LIST}"
fi
if [[ -n "${DPAS_IO_MODE:-}" ]]; then
  IFS=',' read -r -a IO_MODE <<< "${DPAS_IO_MODE}"
fi
if [[ -n "${DPAS_JOB_LIST:-}" ]]; then
  IFS=',' read -r -a JOBS <<< "${DPAS_JOB_LIST}"
fi
if [[ -n "${DPAS_RW_FLAGS:-}" ]]; then
  IFS=',' read -r -a RR_RW <<< "${DPAS_RW_FLAGS}"
fi

SLEEP_DROP="${DPAS_SLEEP_DROP:-1}"
SLEEP_AFTER_RUN="${DPAS_SLEEP_AFTER_RUN:-1}"
SLEEP_AFTER_MODPROBE="${DPAS_SLEEP_AFTER_MODPROBE:-1}"
SLEEP_AFTER_UMOUNT="${DPAS_SLEEP_AFTER_UMOUNT:-1}"

# Avoid "fio: fio_setaffinity failed" by honoring cpuset/cgroup constraints.
CPU_ALLOWED_LIST="$(awk -F: '/Cpus_allowed_list/ {gsub(/^[ \t]+/, "", $2); print $2}' /proc/self/status || true)"
if [[ -z "${CPU_ALLOWED_LIST}" ]]; then
  CPU_ALLOWED_LIST="0-$(( $(nproc --all) - 1 ))"
fi

# Largest job count -> how many testfiles we must lay out, and poll_queues to request.
MAXJOBS=1
for j in "${JOBS[@]}"; do (( j > MAXJOBS )) && MAXJOBS=$j; done

# Detect whether nvme is a loadable module. A built-in nvme (VM) has no
# /sys/module/nvme/initstate; a loaded module reports "live".
if [[ -e /sys/module/nvme/initstate ]]; then
  NVME_RELOADABLE=1
else
  NVME_RELOADABLE=0
fi
echo "[env] NVME_RELOADABLE=${NVME_RELOADABLE} (1=module/bare-metal, 0=builtin/VM), MAXJOBS=${MAXJOBS}"

NVME_POLL_QUEUES="$(cat /sys/module/nvme/parameters/poll_queues 2>/dev/null || echo unknown)"
echo "[env] nvme.poll_queues=${NVME_POLL_QUEUES}"

if [[ "${NVME_RELOADABLE}" == "0" && "${NVME_POLL_QUEUES}" != "unknown" && "${NVME_POLL_QUEUES}" -lt "${MAXJOBS}" ]]; then
  echo "[warn] built-in nvme: poll_queues=${NVME_POLL_QUEUES}, MAXJOBS=${MAXJOBS}; high job-count results are VM-limited"
fi

# Reset DPAS/queue knobs to a known baseline. On bare metal the modprobe reload already
# does this; here we do it explicitly so the built-in (VM) path is reproducible.
reset_knobs() {
  local d="$1"
  local q="/sys/block/${d}/queue"

  echo 1  > "${q}/io_poll"              2>/dev/null
  echo -1 > "${q}/io_poll_delay"        2>/dev/null
  echo 0  > "${q}/pas_enabled"          2>/dev/null
  echo 0  > "${q}/pas_adaptive_enabled" 2>/dev/null
  echo 0  > "${q}/ehp_enabled"          2>/dev/null
  echo 0  > "${q}/pas_poll_threshold"   2>/dev/null

  # PAS bucket state re-init. Matters on built-in nvme (no driver reload to clear it).
  echo 100    > "${q}/pas_d_init"  2>/dev/null
  echo 10000  > "${q}/pas_up_init" 2>/dev/null
  echo 100000 > "${q}/pas_dn_init" 2>/dev/null
}

# Per-mode nvme preparation.
#   $1 = poll_queues value (empty => omit, used for INT), $2 = device
nvme_setup() {
  if [[ "${NVME_RELOADABLE}" == "1" ]]; then
    modprobe -r nvme && modprobe nvme ${1:+poll_queues=$1}
    sleep "${SLEEP_AFTER_MODPROBE}"
  fi
  reset_knobs "$2"
}

# ---- Prerun: reuse ext4, lay out read targets (no xfs, no conditioning warmup) ----
for device in "${DEVICES[@]}"; do
  if [[ ! -b /dev/${device} ]]; then
    echo "[prerun] skip absent /dev/${device}"
    continue
  fi
  umount /dev/${device} 2>/dev/null
  if ! blkid /dev/${device} >/dev/null 2>&1; then
    echo "[prerun] no filesystem on ${device} -> mkfs.ext4 -F (one-time)"
    mkfs.ext4 -F /dev/${device}
  else
    echo "[prerun] reuse existing filesystem on ${device} (no reformat)"
  fi
  mkdir -p test_${device}
  mount /dev/${device} test_${device}
  echo "[prerun] PREFILL testfile.0..$((MAXJOBS-1)) (size=100m, real writes) on ${device}"
  # Real write prefill (NOT --create_only / fallocate): forces real block allocation so the
  # read workload hits actual data. Without this, fallocated/sparse blocks return zeros with
  # no backend I/O -> sub-us latency, no device wait, all modes converge (the symptom we saw).
  fio --directory=./test_${device} --filename_format='testfile.$jobnum' \
      --rw=write --bs=1m --size=100m --numjobs=${MAXJOBS} \
      --direct=1 --end_fsync=1 --group_reporting --name=prefill >/dev/null
  umount /dev/${device}
  sleep "${SLEEP_AFTER_UMOUNT}"
done

echo `date`

for rr_rw in "${RR_RW[@]}"; do
    for repeat in "${REPEATS[@]}"; do
        for job in "${JOBS[@]}"; do
		for device in "${DEVICES[@]}"; do
		    [[ -b /dev/${device} ]] || continue
		    for mode in "${IO_MODE[@]}"; do

                    mkdir -p ./fio_data/${device}/${rr_rw}/${job}T/${mode}
                    echo 3 > /proc/sys/vm/drop_caches
                    sleep "${SLEEP_DROP}"

                    FIO_CMD="fio --directory=./test_${device} --filename_format=testfile.\$jobnum --direct=1 --ramp_time=3 --size=100m --bs=4k --ioengine=pvsync2 --iodepth=1 --runtime=${RUNTIME} --numjobs=${job} --time_based --group_reporting --name=run --eta-newline=1 --cpus_allowed=${CPU_ALLOWED_LIST} --cpus_allowed_policy=split --nice=-10 --prioclass=2 --prio=0"

                    if [ ${rr_rw} == "RR" ]; then
                        FIO_CMD="${FIO_CMD} --readonly --rw=randread"
                    else
                        FIO_CMD="${FIO_CMD} --rw=randwrite"
                    fi

                    if [ ${mode} != "INT" ]; then
                        FIO_CMD="${FIO_CMD} --hipri"
                    fi
                    if [ ${mode} == "INT" ]; then
                        nvme_setup "" "${device}"
                        echo 0 > /sys/block/${device}/queue/nomerges
                    elif [ ${mode} == "CP" ]; then
                        nvme_setup "${MAXJOBS}" "${device}"
                        echo 0 > /sys/block/${device}/queue/nomerges
                    elif [ ${mode} == "LHP" ]; then
                        nvme_setup "${MAXJOBS}" "${device}"
                        echo 0 > /sys/block/${device}/queue/io_poll_delay
                        echo 0 > /sys/block/${device}/queue/nomerges
                    elif [ ${mode} == "EHP" ]; then
                        # not in default IO_MODE; runnable only via DPAS_IO_MODE override
                        nvme_setup "${MAXJOBS}" "${device}"
                        echo 0 > /sys/block/${device}/queue/io_poll_delay
                        echo 1 > /sys/block/${device}/queue/ehp_enabled
                        echo 0 > /sys/block/${device}/queue/nomerges
                    elif [ ${mode} == "PAS" ]; then
                        nvme_setup "${MAXJOBS}" "${device}"
                        echo 0 > /sys/block/${device}/queue/io_poll_delay
                        echo 0 > /sys/block/${device}/queue/nomerges
                        echo 1 > /sys/block/${device}/queue/pas_enabled
                        echo 0 > /sys/block/${device}/queue/pas_adaptive_enabled
                    elif [ ${mode} == "DPAS1" ]; then
                        nvme_setup "${MAXJOBS}" "${device}"
                        echo 0 > /sys/block/${device}/queue/io_poll_delay
                        echo 0 > /sys/block/${device}/queue/nomerges
                        echo 1 > /sys/block/${device}/queue/pas_enabled
                        echo 1 > /sys/block/${device}/queue/pas_adaptive_enabled
                    fi
		    mount /dev/${device} test_${device}
                    echo ${device} "repeat"${repeat} ${mode} ${job}T ${rr_rw}
                    ${FIO_CMD} > ./fio_data/${device}/${rr_rw}/${job}T/${mode}/fio_report_${repeat}.log
		    umount /dev/${device}
		    sleep "${SLEEP_AFTER_RUN}"

                done
            done
        done
    done
done

for device in "${DEVICES[@]}"; do
	umount test_${device} 2>/dev/null
done
echo `date`
