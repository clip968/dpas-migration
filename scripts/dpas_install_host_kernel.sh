#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install the DPAS host kernel and reserve a one-shot GRUB boot entry.

Usage:
  sudo scripts/dpas_install_host_kernel.sh [--help]

Environment overrides:
  DPAS_KERNEL_SOURCE_DIR  kernel source tree
                          default: ./dpas-kernel
  DPAS_KERNEL_BUILD_DIR   out-of-tree build directory
                          default: ./build/dpas-kernel-host
  DPAS_KERNEL_JOBS        parallel build jobs passed to build script
                          default: build script default
  ROOT_PARTUUID           root filesystem PARTUUID for kernel command line
                          default: auto-detect from /
  BOOT_UUID               filesystem UUID containing kernel/initrd for GRUB
                          default: auto-detect from /boot if mounted, else /

This script calls scripts/dpas_build_host_kernel.sh, installs modules and
/boot artifacts, generates initramfs, writes a custom one-shot GRUB entry, and
runs grub-reboot. It does not reboot automatically.
EOF
}

die() {
  echo "[ERROR] $*" >&2
  exit 1
}

info() {
  echo "[INFO] $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

repo_abs_path() {
  local path="$1"
  case "${path}" in
    /*) printf '%s\n' "${path}" ;;
    *) printf '%s\n' "${REPO_ROOT}/${path}" ;;
  esac
}

kernelrelease() {
  make -s -C "${SOURCE_DIR}" "O=${BUILD_DIR}" kernelrelease
}

check_vermagic() {
  local module_path="$1"
  local label="$2"
  local vermagic

  [ -f "${module_path}" ] || die "missing ${label} module: ${module_path}"
  vermagic="$(modinfo -F vermagic "${module_path}")"
  info "${label} vermagic: ${vermagic}"

  case "${vermagic}" in
    "${KREL}"*) ;;
    *) die "${label} vermagic does not match KREL=${KREL}" ;;
  esac
}

detect_root_partuuid() {
  local root_dev

  root_dev="$(findmnt -no SOURCE /)"
  [ -n "${root_dev}" ] || die "cannot detect root device"

  blkid -s PARTUUID -o value "${root_dev}" 2>/dev/null || true
}

detect_boot_uuid_and_prefix() {
  local root_dev boot_dev

  root_dev="$(findmnt -no SOURCE /)"
  boot_dev="$(findmnt -no SOURCE /boot 2>/dev/null || true)"

  if [ -n "${boot_dev}" ] && [ "${boot_dev}" != "${root_dev}" ]; then
    BOOT_PATH_PREFIX=""
  else
    boot_dev="${root_dev}"
    BOOT_PATH_PREFIX="/boot"
  fi

  blkid -s UUID -o value "${boot_dev}" 2>/dev/null || true
}

run_build_as_original_user() {
  local build_script="${REPO_ROOT}/scripts/dpas_build_host_kernel.sh"
  local -a env_args

  [ -x "${build_script}" ] || die "build script is not executable: ${build_script}"

  env_args=(
    "DPAS_KERNEL_SOURCE_DIR=${SOURCE_DIR}"
    "DPAS_KERNEL_BUILD_DIR=${BUILD_DIR}"
  )
  if [ -n "${DPAS_KERNEL_JOBS:-}" ]; then
    env_args+=("DPAS_KERNEL_JOBS=${DPAS_KERNEL_JOBS}")
  fi

  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    require_cmd sudo
    info "running build as ${SUDO_USER}"
    sudo -u "${SUDO_USER}" env "${env_args[@]}" "${build_script}"
  else
    info "running build as root because SUDO_USER is not set"
    env "${env_args[@]}" "${build_script}"
  fi
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    die "unknown argument: $1"
    ;;
esac

[ "${EUID}" -eq 0 ] || die "run this script with sudo"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

SOURCE_DIR="$(repo_abs_path "${DPAS_KERNEL_SOURCE_DIR:-dpas-kernel}")"
BUILD_DIR="$(repo_abs_path "${DPAS_KERNEL_BUILD_DIR:-build/dpas-kernel-host}")"

require_cmd make
require_cmd install
require_cmd modinfo
require_cmd depmod
require_cmd mkinitramfs
require_cmd grub-script-check
require_cmd grub-reboot
require_cmd findmnt
require_cmd blkid

[ -f "${SOURCE_DIR}/Makefile" ] || die "kernel Makefile not found: ${SOURCE_DIR}/Makefile"
[ -f "${BUILD_DIR}/.config" ] || die "kernel build config not found: ${BUILD_DIR}/.config"

info "repo   : ${REPO_ROOT}"
info "source : ${SOURCE_DIR}"
info "build  : ${BUILD_DIR}"

run_build_as_original_user

KREL="$(kernelrelease)"
[ -n "${KREL}" ] || die "kernelrelease is empty"
info "KREL   : ${KREL}"

BZIMAGE="${BUILD_DIR}/arch/x86/boot/bzImage"
SYSTEM_MAP="${BUILD_DIR}/System.map"
CONFIG="${BUILD_DIR}/.config"

[ -f "${BZIMAGE}" ] || die "missing bzImage: ${BZIMAGE}"
[ -f "${SYSTEM_MAP}" ] || die "missing System.map: ${SYSTEM_MAP}"
[ -f "${CONFIG}" ] || die "missing config: ${CONFIG}"

info "installing modules"
make -C "${SOURCE_DIR}" "O=${BUILD_DIR}" modules_install

info "installing /boot artifacts"
install -m 0644 "${BZIMAGE}" "/boot/vmlinuz-${KREL}"
install -m 0644 "${SYSTEM_MAP}" "/boot/System.map-${KREL}"
install -m 0644 "${CONFIG}" "/boot/config-${KREL}"

info "running depmod"
depmod "${KREL}"

info "generating initramfs"
mkinitramfs -o "/boot/initrd.img-${KREL}" "${KREL}"

[ -f "/boot/vmlinuz-${KREL}" ] || die "missing installed kernel: /boot/vmlinuz-${KREL}"
[ -f "/boot/System.map-${KREL}" ] || die "missing installed System.map: /boot/System.map-${KREL}"
[ -f "/boot/config-${KREL}" ] || die "missing installed config: /boot/config-${KREL}"
[ -f "/boot/initrd.img-${KREL}" ] || die "missing initramfs: /boot/initrd.img-${KREL}"

check_vermagic "/lib/modules/${KREL}/kernel/fs/xfs/xfs.ko" "xfs.ko"
check_vermagic "/lib/modules/${KREL}/kernel/net/netfilter/nf_tables.ko" "nf_tables.ko"

ROOT_PARTUUID="${ROOT_PARTUUID:-$(detect_root_partuuid)}"
[ -n "${ROOT_PARTUUID}" ] || die "cannot detect ROOT_PARTUUID; set ROOT_PARTUUID manually"

BOOT_PATH_PREFIX="/boot"
BOOT_UUID="${BOOT_UUID:-$(detect_boot_uuid_and_prefix)}"
[ -n "${BOOT_UUID}" ] || die "cannot detect BOOT_UUID; set BOOT_UUID manually"

KERNEL_GRUB_PATH="${BOOT_PATH_PREFIX}/vmlinuz-${KREL}"
INITRD_GRUB_PATH="${BOOT_PATH_PREFIX}/initrd.img-${KREL}"
ENTRY_NAME="DPAS host ${KREL} one-shot candidate"
CUSTOM_CFG="/boot/grub/custom.cfg"

info "ROOT_PARTUUID=${ROOT_PARTUUID}"
info "BOOT_UUID=${BOOT_UUID}"
info "GRUB kernel path=${KERNEL_GRUB_PATH}"
info "GRUB initrd path=${INITRD_GRUB_PATH}"

if [ -f "${CUSTOM_CFG}" ]; then
  backup="/boot/grub/custom.cfg.bak-$(date +%Y%m%d-%H%M%S)"
  info "backing up ${CUSTOM_CFG} to ${backup}"
  cp -a "${CUSTOM_CFG}" "${backup}"
else
  info "${CUSTOM_CFG} does not exist; creating it"
fi

info "writing one-shot GRUB entry"
cat >"${CUSTOM_CFG}" <<EOF
menuentry '${ENTRY_NAME}' {
    insmod gzio
    insmod part_gpt
    insmod ext2
    search --no-floppy --fs-uuid --set=root ${BOOT_UUID}
    linux ${KERNEL_GRUB_PATH} root=PARTUUID=${ROOT_PARTUUID} ro rootwait console=tty0 loglevel=7 nvme.poll_queues=20 panic=30
    initrd ${INITRD_GRUB_PATH}
}
EOF

grub-script-check "${CUSTOM_CFG}"

info "reserving one-shot GRUB entry"
grub-reboot "${ENTRY_NAME}"

info "GRUB next_entry:"
strings /boot/grub/grubenv | grep next_entry || true

echo "[OK] DPAS host kernel is installed and reserved for one-shot boot."
echo "[OK] KREL=${KREL}"
echo "[OK] Reboot was not executed. Run 'sudo reboot' when you are ready."
