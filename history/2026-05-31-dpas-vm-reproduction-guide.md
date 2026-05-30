# DPAS VM 테스트 환경 재현 가이드

이 문서는 새 서버에서 `dpas-kernel` 최신 `main` 커밋을 직접 `bzImage`로 부팅하는 libvirt/KVM VM을 다시 만들기 위한 절차다. 목표는 기존 DPAS VM 테스트 환경 재현이며, 5.18 `kernel/` 트리는 사용하지 않는다.

## 최종 목표 상태

- 기준 repo: `dpas-kernel`
- 기준 커밋: `19009d1c0fcfeef5ae52f670af6d8c054dbceb82`
- 커널 버전: `7.1.0-rc4-dpas-vm-g19009d1c0fcf`
- build dir: `build/dpas-kernel-vm`
- kernel image: `build/dpas-kernel-vm/arch/x86/boot/bzImage`
- libvirt domain: `dpas-kernel-7-1-0-rc4`
- machine: q35
- memory: 4GiB
- vCPU: 4
- CPU: host-passthrough
- root disk: virtio-blk, guest `/dev/vda1`
- cloud-init seed: virtio-blk, guest `/dev/vdb`
- scratch disk: QEMU emulated NVMe, guest `/dev/nvme0n1`
- scratch mount: `/mnt/nvme-test`

필수 kernel cmdline:

```text
root=/dev/vda1 rw rootwait rootfstype=ext4 console=ttyS0,115200n8 earlyprintk=serial,ttyS0,115200 loglevel=7 systemd.show_status=true net.ifnames=0 biosdevname=0 virtio_blk.poll_queues=1 nvme.poll_queues=1
```

## Host 패키지

Ubuntu `resolute`에서는 `qemu-kvm`이 virtual package라 직접 설치가 실패했다. HWE QEMU와 non-HWE QEMU를 섞으면 `ubuntu-virt` / `ubuntu-virt-hwe` 충돌도 난다. 이 환경에서는 non-HWE QEMU로 맞췄다.

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential gcc make bc m4 flex bison libfl-dev \
  libelf-dev libzstd-dev libssl-dev libdw-dev dwarves pahole \
  gawk kmod cpio rsync git pkg-config \
  qemu-system-x86 qemu-utils \
  libvirt-daemon-system libvirt-clients virtinst \
  cloud-image-utils genisoimage mtools \
  bridge-utils dnsmasq-base \
  fio nvme-cli openssh-client
```

주의할 점:

- `mtools`는 `cloud-localds -f vfat`이 내부적으로 쓰는 `mcopy`를 제공한다.
- `libdw-dev`가 없으면 커널 빌드 중 `dwarf.h` 관련 에러가 난다.
- `gawk`가 없으면 커널 빌드 스크립트에서 실패할 수 있다.

## Repo 준비

```bash
cd /home/urop1/dpas-migration
git clone git@github.com:clip968/dpas-kernel.git
git -C dpas-kernel fetch origin main
git -C dpas-kernel checkout main
git -C dpas-kernel pull --ff-only origin main
git -C dpas-kernel log -1 --oneline
```

성공 기준:

```text
19009d1c0 fixed lhp 구현
```

소스 코드는 수정하지 않는다. 이 작업에서 수정한 것은 build config와 VM 환경뿐이다.

## 커널 build config

host Ubuntu config를 기반으로 VM용 `.config`를 만든다.

```bash
mkdir -p build/dpas-kernel-vm
cp /boot/config-$(uname -r) build/dpas-kernel-vm/.config
```

직접 `bzImage` 부팅이고 initramfs를 쓰지 않으므로 root disk, ext4, console, NVMe는 built-in이어야 한다.

```bash
dpas-kernel/scripts/config --file build/dpas-kernel-vm/.config \
  --set-str LOCALVERSION "-dpas-vm" \
  --enable LOCALVERSION_AUTO \
  --enable VIRTIO_BLK \
  --enable VIRTIO_NET \
  --enable VIRTIO_PCI \
  --enable EXT4_FS \
  --enable BLK_DEV_NVME \
  --enable DEVTMPFS \
  --enable DEVTMPFS_MOUNT \
  --enable SERIAL_8250 \
  --enable SERIAL_8250_CONSOLE \
  --enable FAT_FS \
  --enable VFAT_FS \
  --enable NLS_ISO8859_1 \
  --set-str SYSTEM_TRUSTED_KEYS "" \
  --set-str SYSTEM_REVOCATION_KEYS ""

make -C dpas-kernel O=../build/dpas-kernel-vm olddefconfig
```

중요한 값:

```text
CONFIG_LOCALVERSION="-dpas-vm"
CONFIG_LOCALVERSION_AUTO=y
CONFIG_VIRTIO_BLK=y
CONFIG_VIRTIO_NET=y
CONFIG_VIRTIO_PCI=y
CONFIG_EXT4_FS=y
CONFIG_BLK_DEV_NVME=y
CONFIG_DEVTMPFS=y
CONFIG_DEVTMPFS_MOUNT=y
CONFIG_SERIAL_8250=y
CONFIG_SERIAL_8250_CONSOLE=y
CONFIG_FAT_FS=y
CONFIG_VFAT_FS=y
CONFIG_NLS_ISO8859_1=y
CONFIG_SYSTEM_TRUSTED_KEYS=""
CONFIG_SYSTEM_REVOCATION_KEYS=""
```

`CONFIG_NLS_ISO8859_1=y`가 빠지면 Debian cloud image가 `/dev/vda15` VFAT EFI 파티션을 mount하려고 할 때 다음과 비슷하게 실패하고 emergency mode로 빠질 수 있다.

```text
FAT-fs (vda15): IO charset iso8859-1 not found
```

Ubuntu host config에는 Canonical 인증서 파일 경로가 들어 있을 수 있다. `debian/canonical-certs.pem`, `debian/canonical-revoked-certs.pem` 같은 파일은 이 repo build tree에 없으므로 VM용 build config에서는 위처럼 빈 문자열로 비운다.

## 커널 빌드

```bash
make -C dpas-kernel O=../build/dpas-kernel-vm -j20 bzImage
```

성공 기준:

```bash
ls -lh build/dpas-kernel-vm/arch/x86/boot/bzImage
make -C dpas-kernel O=../build/dpas-kernel-vm kernelrelease
```

예상 kernelrelease:

```text
7.1.0-rc4-dpas-vm-g19009d1c0fcf
```

## libvirt/KVM 권한

현재 사용자에게 system libvirt socket과 KVM 접근 권한이 필요하다.

```bash
sudo setfacl -m u:urop1:rw /var/run/libvirt/libvirt-sock /dev/kvm
virsh --connect qemu:///system list --all
```

VM 이미지가 `/home/urop1/dpas-migration/build/libvirt-vm` 아래에 있으므로 libvirt QEMU 프로세스가 해당 경로를 지나갈 수 있어야 한다.

```bash
sudo setfacl -m u:libvirt-qemu:x \
  /home/urop1 \
  /home/urop1/dpas-migration \
  /home/urop1/dpas-migration/build

mkdir -p /home/urop1/dpas-migration/build/libvirt-vm
sudo setfacl -m u:libvirt-qemu:rwx /home/urop1/dpas-migration/build/libvirt-vm
```

이미지 파일을 새로 만들 때마다 다음을 다시 적용한다.

```bash
sudo setfacl -R -m u:libvirt-qemu:rwX /home/urop1/dpas-migration/build/libvirt-vm
```

## Debian cloud image와 디스크 생성

기존 서버의 qcow2를 복사하지 않고 Debian cloud image를 새로 받았다. 커널 코드는 직접 부팅하는 `bzImage`가 기준이므로, 이 smoke 환경에서는 userspace를 새 cloud image로 구성해도 된다.

```bash
cd /home/urop1/dpas-migration
mkdir -p build/libvirt-vm
wget -O build/libvirt-vm/debian-13-genericcloud-amd64.qcow2 \
  https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2

qemu-img create -f qcow2 -F qcow2 \
  -b /home/urop1/dpas-migration/build/libvirt-vm/debian-13-genericcloud-amd64.qcow2 \
  /home/urop1/dpas-migration/build/libvirt-vm/dpas-root-vfat.qcow2 \
  20G

qemu-img create -f qcow2 \
  /home/urop1/dpas-migration/build/libvirt-vm/dpas-nvme-scratch.qcow2 \
  4G
```

## cloud-init seed

직접 부팅에서는 seed를 ISO로 만들면 안 된다. 현재 config에서 `CONFIG_ISO9660_FS=m`라 initramfs 없이 ISO seed를 읽지 못했다. 그 결과 hostname이 `localhost`로 남고 SSH key도 주입되지 않았다.

성공한 방식은 VFAT seed다. `CONFIG_FAT_FS=y`, `CONFIG_VFAT_FS=y`, `CONFIG_NLS_ISO8859_1=y`가 built-in이라 VM이 initramfs 없이도 seed를 읽는다.

`build/libvirt-vm/user-data`:

```yaml
#cloud-config
hostname: dpas-kernel-vm
manage_etc_hosts: true
disable_root: false
ssh_pwauth: false
users:
  - default
  - name: root
    lock_passwd: true
    ssh_authorized_keys:
      - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvQimG5etHw9ZsYUlzv7zl/umPKS/gKOvx7KqurwjfO clip968@gmail.com
write_files:
  - path: /etc/ssh/sshd_config.d/99-dpas-root.conf
    permissions: "0644"
    content: |
      PermitRootLogin prohibit-password
      PasswordAuthentication no
package_update: true
packages:
  - fio
  - nvme-cli
runcmd:
  - mkdir -p /mnt/nvme-test
  - [ bash, -lc, 'if [ -b /dev/nvme0n1 ]; then if ! blkid /dev/nvme0n1 >/dev/null 2>&1; then mkfs.ext4 -F /dev/nvme0n1; fi; mount /dev/nvme0n1 /mnt/nvme-test || true; chmod 1777 /mnt/nvme-test; fi' ]
  - systemctl restart ssh || systemctl restart sshd || true
```

`build/libvirt-vm/meta-data`:

```yaml
instance-id: dpas-kernel-7-1-0-rc4
local-hostname: dpas-kernel-vm
```

`build/libvirt-vm/network-config`:

```yaml
version: 2
ethernets:
  eth0:
    dhcp4: true
```

`net.ifnames=0 biosdevname=0` 때문에 guest NIC 이름은 `eth0`로 맞춘다.

VFAT seed 생성:

```bash
cloud-localds -f vfat \
  -N build/libvirt-vm/network-config \
  build/libvirt-vm/dpas-seed-vfat.img \
  build/libvirt-vm/user-data \
  build/libvirt-vm/meta-data
```

`cloud-localds -f vfat`가 `missing 'mcopy'`로 실패하면 `mtools`를 설치한다.

## VM XML

`build/libvirt-vm/dpas-kernel-7-1-0-rc4.xml`:

```xml
<domain type='kvm'>
  <name>dpas-kernel-7-1-0-rc4</name>
  <memory unit='MiB'>4096</memory>
  <currentMemory unit='MiB'>4096</currentMemory>
  <vcpu placement='static'>4</vcpu>
  <os>
    <type arch='x86_64' machine='q35'>hvm</type>
    <kernel>/home/urop1/dpas-migration/build/dpas-kernel-vm/arch/x86/boot/bzImage</kernel>
    <cmdline>root=/dev/vda1 rw rootwait rootfstype=ext4 console=ttyS0,115200n8 earlyprintk=serial,ttyS0,115200 loglevel=7 systemd.show_status=true net.ifnames=0 biosdevname=0 virtio_blk.poll_queues=1 nvme.poll_queues=1</cmdline>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough' check='none' migratable='off'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff>
  <on_reboot>restart</on_reboot>
  <on_crash>destroy</on_crash>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/home/urop1/dpas-migration/build/libvirt-vm/dpas-root-vfat.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/home/urop1/dpas-migration/build/libvirt-vm/dpas-nvme-scratch.qcow2'/>
      <target dev='nvme0n1' bus='nvme'/>
      <serial>dpasnvme001</serial>
    </disk>
    <disk type='file' device='disk'>
      <driver name='qemu' type='raw'/>
      <source file='/home/urop1/dpas-migration/build/libvirt-vm/dpas-seed-vfat.img'/>
      <target dev='vdb' bus='virtio'/>
      <readonly/>
    </disk>
    <controller type='pci' model='pcie-root'/>
    <interface type='network'>
      <source network='default'/>
      <model type='virtio'/>
    </interface>
    <serial type='pty'>
      <target type='isa-serial' port='0'>
        <model name='isa-serial'/>
      </target>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
    <rng model='virtio'>
      <backend model='random'>/dev/urandom</backend>
    </rng>
    <memballoon model='none'/>
  </devices>
</domain>
```

정의 및 시작:

```bash
sudo setfacl -R -m u:libvirt-qemu:rwX /home/urop1/dpas-migration/build/libvirt-vm

virsh --connect qemu:///system define \
  /home/urop1/dpas-migration/build/libvirt-vm/dpas-kernel-7-1-0-rc4.xml

virsh --connect qemu:///system start dpas-kernel-7-1-0-rc4
```

같은 이름의 domain이 이미 있으면 기존 UUID 때문에 define이 충돌할 수 있다. 이때는 기존 domain을 지우는 대신 다음 중 하나를 택한다.

- 기존 domain을 계속 쓸 거면 `virsh dumpxml`에서 UUID를 확인해 XML에 `<uuid>...</uuid>`를 넣고 define한다.
- 완전히 새로 만들 거면 기존 domain을 명시적으로 undefine한다. 단, 디스크 삭제 옵션은 쓰지 않는다.

## 부팅 확인

IP 확인:

```bash
virsh --connect qemu:///system net-dhcp-leases default
```

정상 예:

```text
192.168.122.57/24   dpas-kernel-vm
```

lease가 비어 있으면 serial console을 본다.

```bash
virsh --connect qemu:///system console dpas-kernel-7-1-0-rc4 --safe
```

빠져나오기는 `Ctrl-]`다.

문제별 힌트:

- `localhost login:`으로 나오고 DHCP hostname도 비어 있으면 cloud-init seed가 안 읽힌 것이다. ISO seed를 썼는지 확인하고 VFAT seed로 바꾼다.
- `FAT-fs (vda15): IO charset iso8859-1 not found`가 나오면 `CONFIG_NLS_ISO8859_1=y`가 빠진 것이다.
- SSH에서 host key warning이 나오면 같은 IP를 fresh VM이 재사용한 것이다. 임시 known_hosts 파일을 따로 쓰면 된다.

SSH:

```bash
ssh -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/tmp/dpas-vm-known-hosts \
  -i /home/urop1/.ssh/id_ed25519 \
  root@192.168.122.57
```

## 최종 검증

cloud-init 완료 대기:

```bash
ssh -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/tmp/dpas-vm-known-hosts \
  -i /home/urop1/.ssh/id_ed25519 \
  root@192.168.122.57 \
  'cloud-init status --wait'
```

요청된 상태 확인:

```bash
ssh -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/tmp/dpas-vm-known-hosts \
  -i /home/urop1/.ssh/id_ed25519 \
  root@192.168.122.57 \
  'set -eu
   uname -r
   cat /proc/cmdline
   cat /sys/block/vda/queue/io_poll
   cat /sys/block/nvme0n1/queue/io_poll
   cat /sys/module/nvme/parameters/poll_queues
   lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS
   findmnt /mnt/nvme-test
   fio --version'
```

이번 성공 결과:

```text
uname -r: 7.1.0-rc4-dpas-vm-g19009d1c0fcf
/sys/block/vda/queue/io_poll: 1
/sys/block/nvme0n1/queue/io_poll: 1
/sys/module/nvme/parameters/poll_queues: 1
/mnt/nvme-test: /dev/nvme0n1 ext4 rw,relatime
fio: fio-3.39
```

## fio smoke test 준비 상태

아직 이 단계에서는 실제 workload를 돌리지 않았다. 사용자 지시대로 부팅, SSH, NVMe scratch, poll queue 상태까지만 확인했다.

다음에 smoke test를 돌릴 때의 기본 형태:

```bash
fio --name=dpas-pvsync2-smoke \
  --directory=/mnt/nvme-test \
  --filename=dpas-fio-testfile \
  --rw=randread \
  --bs=4k \
  --iodepth=1 \
  --ioengine=pvsync2 \
  --direct=1 \
  --hipri=1 \
  --size=1G \
  --runtime=30 \
  --time_based \
  --group_reporting
```

워크로드 파라미터는 테스트 목적에 따라 사용자 결정을 받고 조정한다.

## 시행착오 요약

1. `qemu-kvm` 설치 실패
   - 원인: Ubuntu `resolute`에서 virtual package.
   - 해결: `qemu-system-x86`을 명시적으로 설치.

2. HWE/non-HWE QEMU dependency 충돌
   - 원인: `qemu-system-x86-hwe`와 non-HWE `qemu-utils`가 `ubuntu-virt-hwe` / `ubuntu-virt` 충돌을 일으킴.
   - 해결: non-HWE `qemu-system-x86 qemu-utils`로 통일.

3. 커널 build dependency 누락
   - 원인: `libdw-dev`, `gawk` 누락.
   - 해결: host package 목록에 추가.

4. Canonical cert 경로 build 실패
   - 원인: host Ubuntu config가 `debian/canonical-*.pem`을 참조하지만 repo에 파일이 없음.
   - 해결: VM build config에서 `CONFIG_SYSTEM_TRUSTED_KEYS=""`, `CONFIG_SYSTEM_REVOCATION_KEYS=""`.

5. 첫 부팅 emergency mode
   - 원인: Debian cloud image의 VFAT EFI 파티션 mount에 필요한 `iso8859-1` NLS가 built-in이 아니었음.
   - 해결: `CONFIG_NLS_ISO8859_1=y`.

6. DHCP lease 없음
   - 원인 후보: cloud-init network config 미적용, `net.ifnames=0`로 NIC가 `eth0`가 됨.
   - 해결: cloud-init `network-config`에 `eth0 dhcp4: true`를 명시.

7. SSH key 미주입
   - 원인: cloud-init seed를 ISO로 만들었지만 `CONFIG_ISO9660_FS=m`라 initramfs 없는 직접 부팅에서 seed를 읽지 못함.
   - 해결: VFAT seed 사용. `cloud-localds -f vfat`에는 `mtools`의 `mcopy`가 필요.

8. 같은 IP의 SSH host key warning
   - 원인: fresh VM들이 libvirt DHCP에서 같은 IP를 재사용.
   - 해결: `/tmp/dpas-vm-known-hosts-*` 같은 임시 known_hosts 파일을 사용.

