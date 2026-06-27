#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Build the DPAS host kernel image and modules.

Usage:
  scripts/dpas_build_host_kernel.sh [--help]

Environment overrides:
  DPAS_KERNEL_SOURCE_DIR  kernel source tree
                          default: ./dpas-kernel
  DPAS_KERNEL_BUILD_DIR   out-of-tree build directory
                          default: ./build/dpas-kernel-host
  DPAS_KERNEL_JOBS        parallel build jobs
                          default: nproc

This script does not install modules, copy files into /boot, generate an
initramfs, edit GRUB, or schedule a reboot. Run the install/boot steps only
after this script reports that bzImage and module vermagic match KREL.
EOF
}

die() {
  echo "[ERROR] $*" >&2
  exit 1
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

  [ -f "${module_path}" ] || die "missing ${label} module: ${module_path}"

  local vermagic
  vermagic="$(modinfo -F vermagic "${module_path}")"
  echo "[INFO] ${label} vermagic: ${vermagic}"

  case "${vermagic}" in
    "${KREL}"*) ;;
    *) die "${label} vermagic does not match KREL=${KREL}" ;;
  esac
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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

SOURCE_DIR="$(repo_abs_path "${DPAS_KERNEL_SOURCE_DIR:-dpas-kernel}")"
BUILD_DIR="$(repo_abs_path "${DPAS_KERNEL_BUILD_DIR:-build/dpas-kernel-host}")"
JOBS="${DPAS_KERNEL_JOBS:-$(nproc)}"

require_cmd make
require_cmd file
require_cmd modinfo

[ -f "${SOURCE_DIR}/Makefile" ] || die "kernel Makefile not found: ${SOURCE_DIR}/Makefile"
[ -f "${BUILD_DIR}/.config" ] || die "kernel build config not found: ${BUILD_DIR}/.config"

echo "[INFO] repo   : ${REPO_ROOT}"
echo "[INFO] source : ${SOURCE_DIR}"
echo "[INFO] build  : ${BUILD_DIR}"
echo "[INFO] jobs   : ${JOBS}"

if command -v git >/dev/null 2>&1 && git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[INFO] git    : $(git -C "${SOURCE_DIR}" log -1 --oneline --decorate)"
fi

echo "[INFO] updating config with olddefconfig"
make -C "${SOURCE_DIR}" "O=${BUILD_DIR}" olddefconfig

KREL="$(kernelrelease)"
[ -n "${KREL}" ] || die "kernelrelease is empty"
echo "[INFO] KREL   : ${KREL}"

echo "[INFO] building bzImage modules"
make -C "${SOURCE_DIR}" "O=${BUILD_DIR}" -j"${JOBS}" bzImage modules

KREL_AFTER="$(kernelrelease)"
[ "${KREL_AFTER}" = "${KREL}" ] || die "kernelrelease changed during build: before=${KREL} after=${KREL_AFTER}"

BZIMAGE="${BUILD_DIR}/arch/x86/boot/bzImage"
SYSTEM_MAP="${BUILD_DIR}/System.map"
CONFIG="${BUILD_DIR}/.config"

[ -f "${BZIMAGE}" ] || die "missing bzImage: ${BZIMAGE}"
[ -f "${SYSTEM_MAP}" ] || die "missing System.map: ${SYSTEM_MAP}"
[ -f "${CONFIG}" ] || die "missing config: ${CONFIG}"

echo "[INFO] bzImage: $(file "${BZIMAGE}")"
file "${BZIMAGE}" | grep -q "version ${KREL}" || die "bzImage version does not match KREL=${KREL}"

check_vermagic "${BUILD_DIR}/fs/xfs/xfs.ko" "xfs.ko"
check_vermagic "${BUILD_DIR}/net/netfilter/nf_tables.ko" "nf_tables.ko"

echo "[OK] DPAS host kernel build is ready for install steps."
echo "[OK] KREL=${KREL}"
echo "[OK] bzImage=${BZIMAGE}"
echo "[OK] modules are built for ${KREL}"
