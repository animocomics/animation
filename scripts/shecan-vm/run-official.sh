#!/bin/sh
# Boot the official Shecan guest with rootless QEMU user networking.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOADER="$ROOT/glibc/lib/x86_64-linux-gnu/ld-2.27.so"
QEMU="$ROOT/qemu/bin/qemu-system-x86_64"
LIBRARIES="$ROOT/glibc/lib/x86_64-linux-gnu:$ROOT/qemu/lib"
KERNEL="$ROOT/guest/vmlinuz-virt"
INITRAMFS="$ROOT/guest/initramfs-official"
MEMORY=${NOMREH_VM_MEMORY:-2048M}
VNC_PORT=${NOMREH_VNC_PORT:-}
PROXY_PORT=${NOMREH_PROXY_PORT:-}
SERIAL=${NOMREH_VM_SERIAL:-stdio}
PROBE=${NOMREH_VM_PROBE:-0}
TIMEOUT=${NOMREH_VM_TIMEOUT:-240}

for required in "$LOADER" "$QEMU" "$KERNEL" "$INITRAMFS"; do
  if [ ! -f "$required" ]; then
    echo "NOMREH_OFFICIAL_GUEST_ERROR missing_runtime_file"
    exit 1
  fi
done
unset LD_LIBRARY_PATH LD_PRELOAD http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY

NIC='user,model=virtio-net-pci'
APPEND='console=ttyS0 rdinit=/init panic=1 quiet'
if [ -n "$VNC_PORT" ]; then
  NIC="$NIC,hostfwd=tcp:127.0.0.1:$VNC_PORT-:5900"
  APPEND="$APPEND nomreh_vnc=hostfwd"
fi
if [ -n "$PROXY_PORT" ]; then
  NIC="$NIC,hostfwd=tcp:127.0.0.1:$PROXY_PORT-:8888"
  APPEND="$APPEND nomreh_proxy=1"
fi
if [ "$PROBE" = 1 ]; then APPEND="$APPEND nomreh_probe=1"; fi

set -- "$LOADER" --library-path "$LIBRARIES" "$QEMU" \
  -L "$ROOT/qemu/share/qemu" \
  -machine pc,accel=tcg \
  -cpu max \
  -smp 1 \
  -m "$MEMORY" \
  -kernel "$KERNEL" \
  -initrd "$INITRAMFS" \
  -append "$APPEND" \
  -nic "$NIC" \
  -display none \
  -serial "$SERIAL" \
  -monitor none \
  -no-reboot
if [ "$PROBE" = 1 ]; then
  exec timeout -k 5 "$TIMEOUT" "$@"
fi
exec "$@"
