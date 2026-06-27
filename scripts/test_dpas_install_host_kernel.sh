#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/dpas_install_host_kernel.sh"

test -x "${SCRIPT}"
bash -n "${SCRIPT}"

help="$("${SCRIPT}" --help)"

grep -q "Install the DPAS host kernel" <<< "${help}"
grep -q "one-shot GRUB" <<< "${help}"
grep -q "does not reboot" <<< "${help}"
grep -q "DPAS_KERNEL_BUILD_DIR" <<< "${help}"

grep -q "dpas_build_host_kernel.sh" "${SCRIPT}"
grep -q "sudo -u.*SUDO_USER" "${SCRIPT}"
grep -q "modules_install" "${SCRIPT}"
grep -q "mkinitramfs" "${SCRIPT}"
grep -q "grub-script-check" "${SCRIPT}"
grep -q "grub-reboot" "${SCRIPT}"
grep -q "next_entry" "${SCRIPT}"
grep -q "custom.cfg.bak" "${SCRIPT}"
grep -q "ROOT_PARTUUID" "${SCRIPT}"
grep -q "BOOT_UUID" "${SCRIPT}"
grep -q "nvme.poll_queues=20" "${SCRIPT}"

if grep -Eq '^[[:space:]]*(sudo[[:space:]]+)?reboot([[:space:]]|$)' "${SCRIPT}"; then
  echo "install script must not reboot automatically" >&2
  exit 1
fi

if grep -Eq 'update-grub|grub-mkconfig[[:space:]]+-o[[:space:]]+/boot/grub/grub.cfg' "${SCRIPT}"; then
  echo "install script must use one-shot custom.cfg, not regenerate all GRUB config" >&2
  exit 1
fi

echo "dpas host kernel install script test passed"
