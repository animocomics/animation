#!/bin/sh
# Runner-only test: one Unix socket in a private directory, no NIC or disk.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${NOMREH_DISPLAY_SOCKET:?Private socket path required}"
LOADER="$ROOT/glibc/lib/x86_64-linux-gnu/ld-2.27.so"
QEMU="$ROOT/qemu/bin/qemu-system-x86_64"
LIBRARIES="$ROOT/glibc/lib/x86_64-linux-gnu:$ROOT/qemu/lib"
unset LD_LIBRARY_PATH LD_PRELOAD http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
exec timeout -k 5 240 "$LOADER" --library-path "$LIBRARIES" "$QEMU" \
  -L "$ROOT/qemu/share/qemu" -machine pc,accel=tcg -cpu max -smp 1 -m 2048M \
  -kernel "$ROOT/guest/vmlinuz-virt" -initrd "$ROOT/guest/initramfs-gui" \
  -append "console=ttyS0 rdinit=/init rootfstype=ramfs panic=1 quiet" \
  -nic none -display none -serial stdio -monitor none -no-reboot \
  -device virtio-serial-pci \
  -chardev "socket,id=display,path=$NOMREH_DISPLAY_SOCKET,server=on,wait=off" \
  -device virtserialport,chardev=display,name=nomreh.display
