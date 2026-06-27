#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/dpas_build_host_kernel.sh"

test -x "${SCRIPT}"
bash -n "${SCRIPT}"

help="$("${SCRIPT}" --help)"

grep -q "Build the DPAS host kernel image and modules" <<< "${help}"
grep -q "DPAS_KERNEL_JOBS" <<< "${help}"
grep -q "DPAS_KERNEL_BUILD_DIR" <<< "${help}"
grep -q "does not install" <<< "${help}"

grep -q "bzImage modules" "${SCRIPT}"
grep -q "kernelrelease" "${SCRIPT}"
grep -q "vermagic" "${SCRIPT}"
grep -q "xfs.ko" "${SCRIPT}"
grep -q "nf_tables.ko" "${SCRIPT}"

if grep -Eq '^[[:space:]]*(sudo[[:space:]]+)?make .*modules_install' "${SCRIPT}"; then
  echo "build script must not install modules" >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*(sudo[[:space:]]+)?(install|cp) .* /boot/' "${SCRIPT}"; then
  echo "build script must not copy files into /boot" >&2
  exit 1
fi

if grep -Eq 'grub-reboot|/boot/grub|mkinitramfs|depmod' "${SCRIPT}"; then
  echo "build script must not modify bootloader or initramfs state" >&2
  exit 1
fi

echo "dpas host kernel build script test passed"
