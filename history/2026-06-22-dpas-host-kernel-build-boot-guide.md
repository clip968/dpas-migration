# DPAS host 커널 빌드와 one-shot 부팅 가이드

이 문서는 현재 `dpas-kernel` 코드를 host OS에 올려 한 번만 부팅하기 위한 절차다.

## 핵심 원칙

- 먼저 `scripts/dpas_build_host_kernel.sh`로 빌드 산출물과 module 버전을 확인한다.
- 그 다음 root 권한으로 `/lib/modules`, `/boot`, initramfs, GRUB one-shot entry를 갱신한다.
- `KREL`은 kernel release 문자열이다. `/boot/vmlinuz-$KREL`, `/boot/initrd.img-$KREL`, `/lib/modules/$KREL`이 모두 같은 값을 써야 한다.
- initramfs는 부팅 초기에 module을 로드하기 위한 임시 파일시스템이다. host 부팅에서는 `initrd` 줄을 반드시 둔다.
- one-shot 부팅은 `grub-reboot`로 다음 부팅 1회만 특정 GRUB entry를 선택하는 방식이다.

## 1. 현재 커널 코드 빌드

```bash
cd /home/urop1/dpas-migration

./scripts/dpas_build_host_kernel.sh
```

이 스크립트가 하는 일:

- `build/dpas-kernel-host/.config` 기준 `olddefconfig` 실행.
- `bzImage modules` 빌드.
- `build/dpas-kernel-host/arch/x86/boot/bzImage`의 버전이 `KREL`과 맞는지 확인.
- `build/dpas-kernel-host/fs/xfs/xfs.ko`와 `build/dpas-kernel-host/net/netfilter/nf_tables.ko`의 `vermagic`가 `KREL`과 맞는지 확인.

`vermagic`는 module이 어느 커널 버전과 설정으로 빌드됐는지 나타내는 문자열이다.

## 2. KREL 확인

```bash
KREL=$(make -s -C dpas-kernel O=../build/dpas-kernel-host kernelrelease)
echo "$KREL"
test -n "$KREL" || { echo "KREL is empty"; exit 1; }
```

예시:

```text
7.1.0-rc4-dpas-host-g465aff72610e
```

이후 모든 설치 경로는 이 `$KREL`을 기준으로 맞춘다.

## 3. module 설치

```bash
sudo make -C dpas-kernel O=../build/dpas-kernel-host modules_install
```

정상 결과는 `/lib/modules/$KREL/` 디렉터리가 생기는 것이다.

이 단계를 건너뛰면 `xfs.ko`, `nf_tables.ko`, `nls_iso8859_1.ko` 같은 module이 이전 커널용으로 남아 부팅 또는 방화벽/XFS 동작이 깨질 수 있다.

## 4. kernel image, System.map, config 설치

```bash
sudo install -m 0644 build/dpas-kernel-host/arch/x86/boot/bzImage /boot/vmlinuz-$KREL
sudo install -m 0644 build/dpas-kernel-host/System.map /boot/System.map-$KREL
sudo install -m 0644 build/dpas-kernel-host/.config /boot/config-$KREL
```

설치 확인:

```bash
ls -lh \
  /boot/vmlinuz-$KREL \
  /boot/System.map-$KREL \
  /boot/config-$KREL
```

## 5. depmod와 initramfs 생성

```bash
sudo depmod "$KREL"
sudo mkinitramfs -o /boot/initrd.img-$KREL "$KREL"
```

확인:

```bash
ls -lh /boot/initrd.img-$KREL
```

`depmod`는 module 의존성 정보를 만든다. `mkinitramfs`는 새 커널용 initramfs를 만든다.

## 6. module 버전 재확인

```bash
modinfo -F vermagic /lib/modules/$KREL/kernel/fs/xfs/xfs.ko
modinfo -F vermagic /lib/modules/$KREL/kernel/net/netfilter/nf_tables.ko
```

정상 기준:

- 두 출력 모두 `$KREL`로 시작해야 한다.
- 예: `7.1.0-rc4-dpas-host-g465aff72610e SMP preempt mod_unload modversions`

확인 필요:

- `xfs.ko`가 없으면 `CONFIG_XFS_FS`가 module인지 built-in인지 `/boot/config-$KREL`에서 확인한다.
- `nf_tables.ko`가 없으면 `CONFIG_NF_TABLES`가 module인지 built-in인지 `/boot/config-$KREL`에서 확인한다.

## 7. GRUB custom entry 작성

현재 host에서 사용해 온 값:

```bash
ROOT_PARTUUID=b1db2aa1-2042-4f43-b6f9-b8d916802e8e
BOOT_UUID=cb519fe9-d069-48d2-99d1-260e60a7963e
```

확인 필요:

- root disk나 boot disk 구성이 바뀌었으면 아래 값을 다시 확인한다.

```bash
ROOT_DEV=$(findmnt -no SOURCE /)
BOOT_DEV=$(findmnt -no SOURCE /boot 2>/dev/null || true)
if [ -z "$BOOT_DEV" ]; then
  BOOT_DEV="$ROOT_DEV"
fi

sudo blkid -s PARTUUID -o value "$ROOT_DEV"
sudo blkid -s UUID -o value "$BOOT_DEV"
```

기존 custom entry를 백업한다.

```bash
sudo cp -a /boot/grub/custom.cfg /boot/grub/custom.cfg.bak-$(date +%Y%m%d-%H%M%S)
```

새 entry를 작성한다.

```bash
cat <<EOF | sudo tee /boot/grub/custom.cfg >/dev/null
menuentry 'DPAS host ${KREL} one-shot candidate' {
    insmod gzio
    insmod part_gpt
    insmod ext2
    search --no-floppy --fs-uuid --set=root ${BOOT_UUID}
    linux /boot/vmlinuz-${KREL} root=PARTUUID=${ROOT_PARTUUID} ro rootwait console=tty0 loglevel=7 nvme.poll_queues=20 panic=30
    initrd /boot/initrd.img-${KREL}
}
EOF
```

## 8. GRUB 문법과 줄바꿈 확인

```bash
sudo grub-script-check /boot/grub/custom.cfg
sudo nl -ba /boot/grub/custom.cfg
sed -n '1,12l' /boot/grub/custom.cfg
```

정상 기준:

- `grub-script-check`가 출력 없이 종료한다.
- `linux` 줄과 `initrd` 줄이 서로 다른 줄이다.
- `sed -n 'l'` 출력에서 `linux ... panic=30$` 다음 줄에 `initrd ...$`가 따로 나온다.

잘못된 예:

```grub
linux ... panic=30      initrd /boot/initrd.img-...
```

올바른 예:

```grub
linux ... panic=30
initrd /boot/initrd.img-...
```

## 9. one-shot 부팅 예약

```bash
sudo grub-reboot "DPAS host ${KREL} one-shot candidate"
sudo strings /boot/grub/grubenv | grep next_entry
```

정상 기준:

```text
next_entry=DPAS host <KREL> one-shot candidate
```

## 10. 재부팅

```bash
sudo reboot
```

one-shot 부팅이므로, 실패 후 다시 재부팅하면 기본 Ubuntu 커널로 돌아오는 것이 기대 동작이다.

## 11. 부팅 후 기본 검증

```bash
uname -r
cat /proc/cmdline
sudo strings /boot/grub/grubenv | grep next_entry
cat /sys/module/nvme/parameters/poll_queues
```

정상 기준:

- `uname -r`이 `$KREL`과 같다.
- `/proc/cmdline`에 `BOOT_IMAGE=/boot/vmlinuz-$KREL`이 있다.
- `/proc/cmdline`에 `nvme.poll_queues=20`이 있다.
- `next_entry=`가 비어 있다. 즉 one-shot 예약이 소비됐다.
- `/sys/module/nvme/parameters/poll_queues` 값이 `20`이다.

## 12. mount와 service 검증

```bash
findmnt -no SOURCE,FSTYPE,OPTIONS /
findmnt -no SOURCE,FSTYPE,OPTIONS /boot/efi
systemctl --failed --no-pager
```

정상 기준:

- `/`가 host root device에서 mount되어 있다.
- `/boot/efi`가 vfat으로 mount되어 있고 `iocharset=iso8859-1`가 보인다.
- `systemctl --failed`에 `ufw.service`나 `systemd-modules-load.service` 실패가 없어야 한다.

## 13. module 상태 검증

```bash
modinfo -F vermagic /lib/modules/$(uname -r)/kernel/fs/xfs/xfs.ko
modinfo -F vermagic /lib/modules/$(uname -r)/kernel/net/netfilter/nf_tables.ko
modprobe -n -v xfs
modprobe -n -v nf_tables
grep -E '^(nf_tables|nfnetlink|xfs) ' /proc/modules || true
```

정상 기준:

- `xfs.ko`와 `nf_tables.ko`의 `vermagic`가 `uname -r`과 같다.
- `modprobe -n -v xfs`가 `/lib/modules/$(uname -r)/.../xfs.ko`를 가리킨다.
- 방화벽이 정상이라면 `/proc/modules`에 `nf_tables` 또는 관련 `nft_*` module이 보일 수 있다.

## 14. DPAS sysfs 검증

```bash
cat /sys/block/nvme1n1/device/model
ls -1 /sys/block/nvme1n1/queue | grep -E 'pas|switch|io_poll|logging'
cat /sys/block/nvme1n1/queue/io_poll
cat /sys/block/nvme1n1/queue/dpas_switch_stats
```

정상 기준:

- model이 `INTEL SSDPED1D480GA`다.
- `pas_enabled`, `pas_adaptive_enabled`, `switch_enabled`, `switch_param1~7`, `dpas_switch_stats`, `logging_enabled`, `pas_reset_stats`, `io_poll`이 보인다.
- `io_poll`은 polling test 전제상 `1`이어야 한다.

## 15. kernel 로그 확인

```bash
sudo dmesg -T --level=err,warn | tail -100
journalctl -k -b -p warning..alert --no-pager -n 100
```

확인할 문제:

- `Oops`
- `BUG`
- `Kernel panic`
- `divide error`
- `nf_tables` 관련 protocol unsupported
- `xfs` module load 실패
- `nls_iso8859_1` 관련 `/boot/efi` mount 실패

## 실패 시 복구 기준

- one-shot 예약은 다음 부팅 1회만 적용된다.
- 부팅 실패, emergency mode, SSH 접속 실패가 발생하면 local console/IPMI에서 한 번 더 재부팅해 기본 Ubuntu 커널로 돌아오는지 확인한다.
- 기본 커널로 돌아온 뒤 확인한다.

```bash
uname -r
sudo strings /boot/grub/grubenv | grep next_entry
sudo nl -ba /boot/grub/custom.cfg
journalctl --list-boots --no-pager
```

자주 발생한 문제:

- `bzImage`만 새로 빌드하고 `modules`를 새로 빌드/설치하지 않음.
- `/lib/modules/$KREL`의 `.ko`가 이전 커널 `vermagic`를 가짐.
- initramfs 없이 직접 부팅해 `/boot/efi`의 `nls_iso8859_1` module을 못 읽음.
- GRUB `linux` 줄과 `initrd` 줄이 한 줄로 붙음.
- GRUB entry가 이전 `$KREL`의 `/boot/vmlinuz-*` 또는 `/boot/initrd.img-*`를 가리킴.
