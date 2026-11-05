#!/bin/sh
# Run one networkless, diskless, credential-free VM and require its explicit PASS.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOADER="$ROOT/glibc/lib/x86_64-linux-gnu/ld-2.27.so"
QEMU="$ROOT/qemu/bin/qemu-system-x86_64"
LIBRARIES="$ROOT/glibc/lib/x86_64-linux-gnu:$ROOT/qemu/lib"
KERNEL="$ROOT/guest/vmlinuz-virt"
INITRAMFS="$ROOT/guest/initramfs-probe"

for required in "$LOADER" "$QEMU" "$KERNEL" "$INITRAMFS"; do
  if [ ! -f "$required" ]; then
    echo "NOMREH_VM_PROBE_ERROR missing_runtime_file"
    exit 1
  fi
done

# Do not inherit or modify the host's dynamic-loader, network, DNS, or proxy configuration.
unset LD_LIBRARY_PATH LD_PRELOAD http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

timeout -k 5 120 "$LOADER" --library-path "$LIBRARIES" "$QEMU" \
  -L "$ROOT/qemu/share/qemu" \
  -machine pc,accel=tcg \
  -cpu max \
  -smp 1 \
  -m 128M \
  -kernel "$KERNEL" \
  -initrd "$INITRAMFS" \
  -append "console=ttyS0 rdinit=/init panic=1" \
  -nic none \
  -display none \
  -serial stdio \
  -monitor none \
  -no-reboot
