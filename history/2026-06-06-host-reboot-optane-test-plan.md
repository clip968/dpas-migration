# 2026-06-06 host DPAS 커널 재부팅 후 Optane 테스트 전체 절차

목적: `7.1.0-rc4-dpas-host-g4be3fefb1311`로 host 1회성 부팅 후, Optane SSD에서 기본 polling/PAS 경로를 안전하게 검증한다.

현재 예약 상태:

- GRUB one-shot entry: `DPAS host 7.1.0-rc4 one-shot candidate`
- kernel image: `/boot/vmlinuz-7.1.0-rc4-dpas-host-g4be3fefb1311`
- host root: `/dev/sdc2`, ext4, `PARTUUID=b1db2aa1-2042-4f43-b6f9-b8d916802e8e`
- Optane 대상: disk `/dev/nvme1n1`, partition `/dev/nvme1n1p1`
- 테스트 모드: `INT`, `CP`, `LHP`, `PAS`
- `DPAS1`과 `DPAS`는 이번 host smoke/stability 테스트에서 제외한다.

현재 부팅 검증 상태:

- 2026-06-06 17:36 KST DPAS host one-shot boot는 systemd emergency mode에 진입했다.
- 확인된 직접 원인: `/boot/efi` vfat mount 실패.
- 로그: `FAT-fs (sdc1): IO charset iso8859-1 not found`, `Failed to mount boot-efi.mount`, `Dependency failed for local-fs.target`.
- config 원인: `CONFIG_NLS_ISO8859_1=m`인데 DPAS 커널용 `/lib/modules`/initramfs 없이 `bzImage`만 직접 부팅했다.
- 이후 DPAS 커널용 modules 설치와 `/boot/initrd.img-7.1.0-rc4-dpas-host-g4be3fefb1311` 생성, GRUB `initrd` line 추가 후 재부팅했다.
- 2026-06-06 18:29 KST 기준 DPAS host 커널 부팅은 성공했다. `/`와 `/boot/efi`는 `rw`, `systemctl --failed`는 0개, `ssh`는 active, `nvme.poll_queues=20`, GRUB `next_entry=`로 one-shot은 소비됐다.
- 2026-06-06 18:48 KST 기준 Optane 4-mode smoke도 완료했다. `INT`, `CP`, `LHP`, `PAS` 모두 fio `err=0`; `DPAS`/`DPAS1`은 실행하지 않았다. 상세 로그는 `/tmp/dpas-host-postboot/host-smoke-20260606-184834`.
- 따라서 이 문서의 2-14번 post-boot smoke 절차는 통과한 상태다. 아직 full micro_4krr host run은 진행하지 않았다.

중요한 중단 조건:

- 부팅 후 `uname -r`이 `7.1.0-rc4-dpas-host-g4be3fefb1311`가 아니면 모든 Optane 테스트를 중단한다.
- `/`가 `/dev/sdc2` ext4로 mount되지 않았으면 중단한다.
- `nvme1n1`이 `INTEL SSDPED1D480GA`로 보이지 않으면 중단한다.
- `fio --enghelp`에서 `pvsync2`가 보이지 않으면 polling/PAS 테스트를 중단한다.
- `/sys/block/nvme1n1/queue` 아래 PAS/polling knob가 없으면 해당 모드 테스트를 중단하고 기록한다.
- 현재 initramfs 포함 GRUB entry에는 `nvme.poll_queues=20`이 들어 있고, 부팅 후 실제 값도 20으로 확인됐다. 그래도 smoke/full 테스트 전 `/sys/module/nvme/parameters/poll_queues`를 다시 확인한다.

주의:

- 기존 `scripts/micro_4krr/run.sh`를 그대로 실행하지 않는다. 이 스크립트는 `/dev/nvme1n1` whole disk를 mount/format할 수 있고, `modprobe -r nvme`를 전제한다.
- host 커널에서는 NVMe가 built-in이므로 `modprobe -r nvme` 방식으로 poll queue state를 바꾸면 안 된다.
- 테스트 데이터는 partition `/dev/nvme1n1p1`의 mounted filesystem 안에 파일로 쓴다. whole disk `/dev/nvme1n1`에는 filesystem 작업을 하지 않는다.
- 사용자가 Optane partition mount/overwrite를 허용했지만, `mkfs`는 별도 결정 없이는 하지 않는다.

---

## 1. 부팅 실패 시 복구 기준

부팅 후 SSH가 안 붙으면 local console/IPMI에서 확인한다. 이번 설정은 `grub-reboot` one-shot이므로, 실패 후 다시 재부팅하면 기본 Ubuntu entry로 돌아오는 것이 기대 동작이다.

local console에서 확인:

```bash
uname -r
cat /proc/cmdline
systemctl --failed
journalctl -b -p warning..alert --no-pager | tail -200
```

DPAS 커널에서 root mount panic 또는 NIC failure가 발생하면 기본 Ubuntu로 재부팅한 뒤, `/boot/grub/custom.cfg`와 `/boot/grub/grubenv`를 확인한다.

---

## 2. 부팅 직후 커널/커맨드라인 확인

```bash
uname -r
cat /proc/cmdline
findmnt -no SOURCE,FSTYPE,OPTIONS /
hostname
date '+%Y-%m-%d %H:%M:%S %Z %z'
```

기대:

```text
uname -r -> 7.1.0-rc4-dpas-host-g4be3fefb1311
/ -> /dev/sdc2 ext4
```

기록 파일 준비:

```bash
cd /home/urop1/dpas-migration
mkdir -p /tmp/dpas-host-postboot
{
  echo "## basic"
  date '+%Y-%m-%d %H:%M:%S %Z %z'
  uname -a
  cat /proc/cmdline
  findmnt -no SOURCE,FSTYPE,OPTIONS /
} | tee /tmp/dpas-host-postboot/00-basic.txt
```

---

## 3. GRUB one-shot 상태 확인

성공 부팅 후 one-shot entry가 소비됐는지 확인한다.

```bash
strings /boot/grub/grubenv | tee /tmp/dpas-host-postboot/01-grubenv.txt
```

기대:

- `next_entry=DPAS host 7.1.0-rc4 one-shot candidate`가 사라졌거나 비어 있어야 한다.
- 남아 있으면 다음 재부팅도 DPAS로 갈 수 있으므로, 재부팅 전에 정리 여부를 결정한다.

정리가 필요할 때만:

```bash
sudo grub-editenv /boot/grub/grubenv unset next_entry
strings /boot/grub/grubenv
```

---

## 4. root/NVMe/NIC driver binding 확인

```bash
lsblk -o NAME,TYPE,SIZE,FSTYPE,UUID,PARTUUID,MOUNTPOINTS,MODEL | tee /tmp/dpas-host-postboot/02-lsblk.txt
lspci -nnk | tee /tmp/dpas-host-postboot/03-lspci-nnk.txt
```

필수 확인:

```bash
lspci -nnk | grep -A4 -E 'SATA controller|Non-Volatile memory controller|Ethernet controller'
```

기대:

- SATA controller: `Kernel driver in use: ahci`
- Optane: `Intel Corporation Optane SSD 900P Series` 또는 `INTEL SSDPED1D480GA`, `Kernel driver in use: nvme`
- NIC: Intel X722, `Kernel driver in use: i40e`

중단:

- `nvme1n1`이 사라졌거나 다른 장치명으로 바뀌면 이후 모든 command의 device명을 갱신하기 전까지 중단한다.
- `i40e`가 bound되지 않았고 원격 접속 안정성이 없으면 성능 테스트를 중단한다.

---

## 5. 부팅 에러 확인

```bash
dmesg -T | tee /tmp/dpas-host-postboot/04-dmesg-full.txt >/dev/null
dmesg -T | grep -Ei 'panic|oops|BUG:|WARNING:|fail|error|ahci|nvme|i40e|dpas|pas|lhp' | tee /tmp/dpas-host-postboot/05-dmesg-important.txt
journalctl -b -p warning..alert --no-pager | tee /tmp/dpas-host-postboot/06-journal-warnings.txt
```

중단:

- kernel panic/oops/BUG가 있으면 중단.
- AHCI/NVMe reset storm, I/O timeout, filesystem error가 있으면 Optane mount 전에 중단.
- i40e link flap이 계속되면 원격 성능 테스트를 중단.

---

## 6. NVMe poll queue 확인

현재 initramfs 포함 GRUB entry에는 `nvme.poll_queues=20`이 들어 있고, 이번 부팅에서 실제 값도 20으로 확인됐다. built-in NVMe는 `modprobe nvme poll_queues=...`로 바꿀 수 없으므로, 성능 테스트 전 반드시 다시 확인한다.

```bash
cat /sys/module/nvme/parameters/poll_queues | tee /tmp/dpas-host-postboot/07-nvme-poll-queues.txt
```

판정:

- `20` 이상이면 job list `1,2,4,8,16,20` full smoke 가능.
- `1` 이상 20 미만이면 해당 값 이하 job만 제한적으로 가능. full 성능 테스트는 중단.
- `0`이면 CP/LHP/PAS polling 성능 테스트는 중단.

poll queue가 부족하면 다음 절차로 GRUB cmdline을 수정하고 다시 one-shot boot한다. 현재 값이 20으로 유지되면 이 재부팅 절차는 건너뛴다.

```bash
sudo sed -i 's/loglevel=7/loglevel=7 nvme.poll_queues=20/' /boot/grub/custom.cfg
grub-script-check /boot/grub/custom.cfg
sudo grub-reboot 'DPAS host 7.1.0-rc4 one-shot candidate'
sudo reboot
```

재부팅 후 다시 2번부터 반복한다.

---

## 7. PAS/polling queue knob 존재 확인

```bash
DEV=nvme1n1
Q=/sys/block/${DEV}/queue

ls -1 ${Q} | grep -Ei 'io_poll|pas|lhp|ehp|switch' | sort | tee /tmp/dpas-host-postboot/08-pas-knobs.txt

for f in io_poll io_poll_delay nomerges pas_enabled pas_adaptive_enabled ehp_enabled switch_enabled switch_param1 switch_param2 switch_param3 switch_param4 pas_poll_threshold pas_d_init pas_up_init pas_dn_init; do
  if [ -e "${Q}/${f}" ]; then
    printf "%-24s " "${f}"
    cat "${Q}/${f}"
  else
    printf "%-24s MISSING\n" "${f}"
  fi
done | tee /tmp/dpas-host-postboot/09-dpas-knob-values.txt
```

필수:

- `io_poll`
- `io_poll_delay`
- `pas_enabled`
- `pas_adaptive_enabled`

`switch_*`가 있더라도 이번 smoke/stability 테스트에서는 사용하지 않는다. `reset_knobs`에서 `switch_enabled=0`으로 꺼진 상태만 확인한다.

---

## 8. fio engine 확인

```bash
fio --enghelp | grep -w pvsync2 | tee /tmp/dpas-host-postboot/10-fio-pvsync2.txt
fio --version | tee /tmp/dpas-host-postboot/11-fio-version.txt
```

중단:

- `pvsync2`가 없으면 이번 DPAS polling path 테스트를 중단한다. 다른 engine으로 대체하지 않는다.

---

## 9. Optane partition 식별과 mount

절대 whole disk를 mount하지 않는다. mount 대상은 `/dev/nvme1n1p1`이다.

```bash
DEV=nvme1n1
PART=nvme1n1p1
MNT=/mnt/dpas-optane

lsblk -o NAME,TYPE,SIZE,FSTYPE,UUID,PARTUUID,MOUNTPOINTS,MODEL /dev/${DEV} | tee /tmp/dpas-host-postboot/12-optane-lsblk.txt
sudo mkdir -p ${MNT}
sudo mount /dev/${PART} ${MNT}
findmnt ${MNT} | tee /tmp/dpas-host-postboot/13-optane-findmnt.txt
sudo mkdir -p ${MNT}/dpas-host-test
sudo chown -R "$(id -u)":"$(id -g)" ${MNT}/dpas-host-test
```

중단:

- mount가 실패하면 `mkfs`하지 말고 중단한다.
- `/dev/nvme1n1p1`가 아닌 장치가 mount되면 즉시 umount하고 중단한다.

---

## 10. mode 설정 함수 준비

아래 함수는 mounted Optane에서 smoke/full 테스트를 돌리기 전에 shell에 붙여 넣는다.

```bash
DEV=nvme1n1
Q=/sys/block/${DEV}/queue

wq() {
  local name="$1"
  local value="$2"
  if [ -e "${Q}/${name}" ]; then
    echo "${value}" | sudo tee "${Q}/${name}" >/dev/null
  fi
}

show_knobs() {
  for f in io_poll io_poll_delay nomerges pas_enabled pas_adaptive_enabled ehp_enabled switch_enabled switch_param1 switch_param2 switch_param3 switch_param4 pas_poll_threshold pas_d_init pas_up_init pas_dn_init; do
    if [ -e "${Q}/${f}" ]; then
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
  wq switch_param1 0
  wq switch_param2 0
  wq switch_param3 0
  wq switch_param4 0
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
      echo "unknown mode: ${mode}" >&2
      return 1
      ;;
  esac
  show_knobs
}
```

mode 의미:

- `INT`: fio에 `--hipri`를 주지 않는 interrupt baseline.
- `CP`: `--hipri`, `io_poll_delay=-1`, classic busy poll.
- `LHP`: `--hipri`, `io_poll_delay=0`, low-power hybrid polling.
- `PAS`: `--hipri`, `pas_enabled=1`, `pas_adaptive_enabled=1`, `switch_enabled=0`.

---

## 11. 실제 write prefill

read benchmark 전에 반드시 실제 write prefill을 한다. `fallocate` 또는 `--create_only`는 사용하지 않는다.

```bash
MNT=/mnt/dpas-optane
TESTDIR=${MNT}/dpas-host-test
MAXJOBS=20

fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
  --rw=write --bs=1m --size=100m --numjobs=${MAXJOBS} \
  --direct=1 --end_fsync=1 --group_reporting --name=prefill \
  | tee /tmp/dpas-host-postboot/14-prefill.log

sync
```

기대:

- `testfile.0`부터 `testfile.19`까지 생성.
- 전체 약 2GiB 실제 write.

확인:

```bash
ls -lh ${TESTDIR}/testfile.* | tee /tmp/dpas-host-postboot/15-prefill-files.txt
```

---

## 12. 단일 mode smoke: INT 먼저

```bash
MODE=INT
set_mode ${MODE} | tee /tmp/dpas-host-postboot/16-knobs-${MODE}.txt
echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null

fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
  --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
  --iodepth=1 --runtime=10 --ramp_time=3 --numjobs=1 --time_based \
  --group_reporting --name=run --eta-newline=1 \
  | tee /tmp/dpas-host-postboot/17-smoke-${MODE}.log

dmesg -T | tail -100 | tee /tmp/dpas-host-postboot/18-dmesg-after-${MODE}.txt
```

중단:

- fio exit code가 0이 아니면 중단.
- dmesg에 I/O timeout, reset storm, BUG/OOPS가 있으면 중단.

---

## 13. 단일 mode smoke: CP

`CP`부터는 `--hipri`를 사용한다.

```bash
MODE=CP
set_mode ${MODE} | tee /tmp/dpas-host-postboot/19-knobs-${MODE}.txt
echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null

fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
  --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
  --iodepth=1 --runtime=10 --ramp_time=3 --numjobs=1 --time_based \
  --group_reporting --name=run --eta-newline=1 --hipri \
  | tee /tmp/dpas-host-postboot/20-smoke-${MODE}.log

dmesg -T | tail -100 | tee /tmp/dpas-host-postboot/21-dmesg-after-${MODE}.txt
```

중단:

- fio가 `hipri` 또는 polling 관련 error를 내면 poll queue 부족 가능성이 높다. 6번으로 돌아가 `nvme.poll_queues`를 확인한다.

---

## 14. 4-mode smoke

INT/CP smoke가 통과한 뒤에만 실행한다.

```bash
for MODE in INT CP LHP PAS; do
  set_mode ${MODE} | tee "/tmp/dpas-host-postboot/22-knobs-${MODE}.txt"
  echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null

  HIPRI=""
  if [ "${MODE}" != "INT" ]; then
    HIPRI="--hipri"
  fi

  fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
    --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
    --iodepth=1 --runtime=10 --ramp_time=3 --numjobs=1 --time_based \
    --group_reporting --name=run --eta-newline=1 ${HIPRI} \
    | tee "/tmp/dpas-host-postboot/23-smoke-${MODE}.log"

  rc=${PIPESTATUS[0]}
  dmesg -T | tail -100 | tee "/tmp/dpas-host-postboot/24-dmesg-after-${MODE}.txt"
  if [ "${rc}" -ne 0 ]; then
    echo "fio failed for ${MODE}; stop"
    break
  fi
done
```

기대:

- 4개 모드 모두 fio exit 0.
- `PAS`에서 `pas_enabled=1`, `pas_adaptive_enabled=1`, `switch_enabled=0`이 확인됨.
- dmesg에 새 BUG/OOPS/I/O timeout 없음.

---

## 15. full micro_4krr host run

4-mode smoke 통과 후에만 실행한다. 기존 runner를 그대로 쓰지 말고, 아래 manual loop를 사용한다. 결과 directory 구조는 기존 parser가 읽기 쉽도록 `scripts/micro_4krr/fio_data/nvme1n1/RR/<job>T/<mode>/fio_report_1.log` 형식을 따른다.

```bash
cd /home/urop1/dpas-migration/scripts/micro_4krr

DEV=nvme1n1
MNT=/mnt/dpas-optane
TESTDIR=${MNT}/dpas-host-test
RUNTIME=10
REPEAT=1
JOBS_LIST="1 2 4 8 16 20"
MODES_LIST="INT CP LHP PAS"

for JOB in ${JOBS_LIST}; do
  for MODE in ${MODES_LIST}; do
    mkdir -p "./fio_data/${DEV}/RR/${JOB}T/${MODE}"
    set_mode ${MODE} > "./fio_data/${DEV}/RR/${JOB}T/${MODE}/knobs_${REPEAT}.txt"
    echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null

    HIPRI=""
    if [ "${MODE}" != "INT" ]; then
      HIPRI="--hipri"
    fi

    echo "${DEV} repeat${REPEAT} ${MODE} ${JOB}T RR"
    fio --directory="${TESTDIR}" --filename_format='testfile.$jobnum' \
      --direct=1 --readonly --rw=randread --bs=4k --ioengine=pvsync2 \
      --iodepth=1 --runtime=${RUNTIME} --ramp_time=3 --numjobs=${JOB} \
      --time_based --group_reporting --name=run --eta-newline=1 ${HIPRI} \
      > "./fio_data/${DEV}/RR/${JOB}T/${MODE}/fio_report_${REPEAT}.log"

    rc=$?
    dmesg -T | tail -100 > "./fio_data/${DEV}/RR/${JOB}T/${MODE}/dmesg_after_${REPEAT}.txt"
    if [ "${rc}" -ne 0 ]; then
      echo "fio failed: mode=${MODE} job=${JOB}; stop"
      exit "${rc}"
    fi
    sleep 1
  done
done
```

주의:

- 이 loop는 shell에 10번의 `set_mode` 함수가 이미 정의돼 있어야 한다.
- `DPAS_IO_MODE`에 `DPAS1` 또는 `DPAS`를 넣지 않는다.
- `EHP`는 이번 host plan에서 제외한다.

---

## 16. parse/summary

기존 parser 기본값에는 `DPAS1`이 있으므로 반드시 env override를 준다. 이번 smoke/stability 기준에서는 `DPAS`도 넣지 않는다.

```bash
cd /home/urop1/dpas-migration/scripts/micro_4krr
DPAS_DEVICE_LIST=nvme1n1 \
DPAS_JOB_LIST=1,2,4,8,16,20 \
DPAS_IO_MODE=INT,CP,LHP,PAS \
DPAS_RW_FLAGS=RR \
python3 parse.py 1
```

빠른 원시 확인:

```bash
for MODE in INT CP LHP PAS; do
  echo "## ${MODE}"
  rg 'IOPS=|cpu          :' fio_data/nvme1n1/RR/*T/${MODE}/fio_report_1.log
done | tee /tmp/dpas-host-postboot/25-quick-summary.txt
```

기대 경향:

- `CP`는 CPU 사용률이 가장 높다.
- `INT`는 interrupt baseline으로 CPU 사용률이 낮고 polling 계열과 IOPS/latency가 다를 수 있다.
- `LHP`, `PAS`는 CP 대비 CPU 절감이 관측돼야 한다.

---

## 17. 테스트 후 cleanup

```bash
reset_knobs
show_knobs | tee /tmp/dpas-host-postboot/26-final-knobs.txt
sync
sudo umount /mnt/dpas-optane
findmnt /mnt/dpas-optane || true
dmesg -T | grep -Ei 'panic|oops|BUG:|WARNING:|fail|error|nvme|i40e|dpas|pas|lhp' | tail -200 | tee /tmp/dpas-host-postboot/27-final-dmesg-important.txt
```

테스트 결과 보존:

```bash
cd /home/urop1/dpas-migration
tar -C /tmp -czf /tmp/dpas-host-postboot-$(date +%Y%m%d-%H%M%S).tar.gz dpas-host-postboot
```

---

## 18. 결과 보고에 포함할 항목

다음 내용을 오늘 history 또는 별도 결과 md에 기록한다.

- 부팅 kernel release와 `/proc/cmdline`
- root mount 결과
- Optane device/model/partition 확인
- AHCI/NVMe/i40e driver binding
- `nvme.poll_queues` 값
- PAS/polling knob 존재 여부
- prefill 성공 여부
- 4-mode smoke 결과: `INT`, `CP`, `LHP`, `PAS`
- full run을 했다면 job별 IOPS/CPU 표
- dmesg/journal의 새 warning/error
- 중단했다면 중단 단계와 이유

---

## 19. 현재 계획의 핵심 리스크

- 이전 one-shot GRUB cmdline에는 `nvme.poll_queues=20`이 빠져 있었지만, initramfs 포함 entry에서는 적용됐고 실제 값 20을 확인했다. 단, custom entry를 다시 수정하면 poll queue 확인을 반복한다.
- 기존 host runner들은 whole disk와 module reload 전제가 있어 그대로 쓰면 위험하다.
- `DPAS1`과 `DPAS`는 이번 host smoke/stability 테스트에서 제외됐으므로, parser/runner 기본값은 반드시 override해야 한다.
