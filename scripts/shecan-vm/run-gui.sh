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

timeout -k 5 120 "$LOADER" --library-path "$LIBRARIES" "$QEMU" \
  -L "$ROOT/qemu/share/qemu" \
  -machine pc,accel=tcg \
  -cpu max \
  -smp 1 \
  -m 512M \
  -kernel "$KERNEL" \
  -initrd "$INITRAMFS" \
  -append "console=ttyS0 rdinit=/init panic=1 quiet" \
  -nic none \
  -display none \
  -serial stdio \
  -monitor none \
  -no-reboot
