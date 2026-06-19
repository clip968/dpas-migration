# Host OS DPAS 커널 1회 부팅 가이드

이 문서는 `dpas-kernel`을 host OS에 설치하고, 다음 부팅 1회만 새 DPAS 커널로 부팅하기 위한 절차다.

## 핵심 원칙

- 이 절차는 `/boot`, `/lib/modules`, GRUB 설정만 다룬다. NVMe 테스트 디스크를 format하거나 mount하지 않는다.
- GRUB는 부팅할 커널을 고르는 bootloader다.
- initramfs는 부팅 초기에 module을 로드하기 위한 임시 파일시스템이다. host 부팅에서는 반드시 `initrd` 줄을 넣는다.
- one-shot 부팅은 `grub-reboot`로 다음 부팅 1회만 특정 entry를 선택하는 방식이다.

## 1. 빌드 산출물과 버전 확인

```bash
cd /home/urop1/dpas-migration

KREL=$(make -s -C dpas-kernel O=../build/dpas-kernel-host kernelrelease)
echo "$KREL"
test -n "$KREL" || { echo "KREL is empty"; exit 1; }

ls -lh \
  build/dpas-kernel-host/arch/x86/boot/bzImage \
  build/dpas-kernel-host/System.map \
  build/dpas-kernel-host/.config
```

`KREL`은 kernel release, 즉 `/boot/vmlinuz-$KREL`과 `/lib/modules/$KREL`에 쓰이는 버전 문자열이다.

## 2. host root와 boot 식별자 확인

```bash
ROOT_DEV=$(findmnt -no SOURCE /)
BOOT_DEV=$(findmnt -no SOURCE /boot 2>/dev/null || true)
if [ -z "$BOOT_DEV" ]; then
  BOOT_DEV="$ROOT_DEV"
fi

ROOT_PARTUUID=$(sudo blkid -s PARTUUID -o value "$ROOT_DEV")
BOOT_UUID=$(sudo blkid -s UUID -o value "$BOOT_DEV")

echo "ROOT_DEV=$ROOT_DEV"
echo "BOOT_DEV=$BOOT_DEV"
echo "ROOT_PARTUUID=$ROOT_PARTUUID"
echo "BOOT_UUID=$BOOT_UUID"
```

현재 host에서 확인된 값은 다음과 같았다.

- `ROOT_DEV=/dev/sdc2`
- `BOOT_DEV=/dev/sdc2`
- `ROOT_PARTUUID=b1db2aa1-2042-4f43-b6f9-b8d916802e8e`
- `BOOT_UUID=cb519fe9-d069-48d2-99d1-260e60a7963e`

## 3. module, kernel image, initramfs 설치

```bash
sudo make -C dpas-kernel O=../build/dpas-kernel-host modules_install

sudo install -m 0644 build/dpas-kernel-host/arch/x86/boot/bzImage /boot/vmlinuz-$KREL
sudo install -m 0644 build/dpas-kernel-host/System.map /boot/System.map-$KREL
sudo install -m 0644 build/dpas-kernel-host/.config /boot/config-$KREL

sudo depmod "$KREL"
sudo mkinitramfs -o /boot/initrd.img-$KREL "$KREL"

ls -lh /boot/vmlinuz-$KREL /boot/System.map-$KREL /boot/config-$KREL /boot/initrd.img-$KREL
```

`modules_install`은 `/lib/modules/$KREL/` 아래에 새 커널용 module을 설치한다.

## 4. GRUB custom entry 작성

기존 파일을 먼저 백업한다.

```bash
sudo cp -a /boot/grub/custom.cfg /boot/grub/custom.cfg.bak-$(date +%Y%m%d-%H%M%S)
```

그 다음 새 entry를 쓴다.

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

중요: `linux` 줄과 `initrd` 줄은 반드시 서로 다른 줄이어야 한다.

잘못된 예:

```grub
linux ... panic=30      initrd /boot/initrd.img-...
```

올바른 예:

```grub
linux ... panic=30
initrd /boot/initrd.img-...
```

## 5. GRUB entry 검증과 one-shot 예약

```bash
sudo grub-script-check /boot/grub/custom.cfg
sudo nl -ba /boot/grub/custom.cfg
```

`nl -ba` 출력에서 `linux`와 `initrd`가 다른 줄인지 확인한다.

```bash
sudo grub-reboot "DPAS host ${KREL} one-shot candidate"
sudo strings /boot/grub/grubenv | grep next_entry
```

`next_entry=DPAS host ... one-shot candidate`가 보이면 다음 부팅 1회 예약이 된 상태다.

## 6. 재부팅 후 확인

```bash
uname -r
cat /proc/cmdline
findmnt -no SOURCE,FSTYPE,OPTIONS /
findmnt -no SOURCE,FSTYPE,OPTIONS /boot/efi
systemctl --failed --no-pager
cat /sys/module/nvme/parameters/poll_queues
ls -1 /sys/block/nvme1n1/queue | grep -E 'pas|ehp|switch|io_poll'
```

정상 기준:

- `uname -r`이 `$KREL`과 같다.
- `/proc/cmdline`에 `nvme.poll_queues=20`이 있다.
- `/`와 `/boot/efi`가 `rw`로 mount되어 있다.
- `systemctl --failed`가 `0 loaded units listed.`를 출력한다.
- `/sys/module/nvme/parameters/poll_queues` 값이 `20`이다.
- `/sys/block/nvme1n1/queue/` 아래 `pas_enabled`, `pas_adaptive_enabled`, `switch_enabled`, `switch_param*`가 보인다.

## 7. 실패 시 복구 기준

- one-shot 예약은 다음 부팅 1회만 적용된다. 실패 후 다시 재부팅하면 기본 Ubuntu 커널로 돌아오는 것이 기대 동작이다.
- 검은 화면이 나오면 먼저 한 번 더 재부팅해 기본 커널로 복귀되는지 확인한다.
- 기본 커널로 복귀한 뒤 확인할 것:

```bash
uname -r
sudo nl -ba /boot/grub/custom.cfg
sudo strings /boot/grub/grubenv | grep next_entry
journalctl --list-boots --no-pager
```

자주 발생한 문제:

- `linux` 줄과 `initrd` 줄이 붙음: initramfs가 로드되지 않아 부팅 실패 가능성이 크다.
- initramfs 없이 `bzImage`만 직접 부팅: `/boot/efi`의 vfat/NLS module을 못 읽어 emergency mode에 들어갈 수 있다.
- `nvme.poll_queues=20` 누락: 부팅은 될 수 있지만 host Optane polling/PAS 테스트 조건이 달라진다.
