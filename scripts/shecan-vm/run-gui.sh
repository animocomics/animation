#!/bin/sh
# Boot the harmless WebKitGTK/Xvnc guest with no disk and no network interface.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOADER="$ROOT/glibc/lib/x86_64-linux-gnu/ld-2.27.so"
QEMU="$ROOT/qemu/bin/qemu-system-x86_64"
LIBRARIES="$ROOT/glibc/lib/x86_64-linux-gnu:$ROOT/qemu/lib"
KERNEL="$ROOT/guest/vmlinuz-virt"
INITRAMFS="$ROOT/guest/initramfs-gui"

for required in "$LOADER" "$QEMU" "$KERNEL" "$INITRAMFS"; do
  if [ ! -f "$required" ]; then
    echo "NOMREH_GUI_PROBE_ERROR missing_runtime_file"
    exit 1
  fi
done
unset LD_LIBRARY_PATH LD_PRELOAD http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

# The probe rootfs exceeded the default tmpfs half-RAM limit at 1 GiB.
# These are local-probe limits, not a claim that the Plesk host can run it.
timeout -k 5 240 "$LOADER" --library-path "$LIBRARIES" "$QEMU" \
  -L "$ROOT/qemu/share/qemu" \
  -machine pc,accel=tcg \
  -cpu max \
  -smp 1 \
  -m 2048M \
  -kernel "$KERNEL" \
  -initrd "$INITRAMFS" \
  -append "console=ttyS0 rdinit=/init rootfstype=ramfs panic=1 quiet" \
  -nic none \
  -display none \
  -serial stdio \
  -monitor none \
  -no-reboot
