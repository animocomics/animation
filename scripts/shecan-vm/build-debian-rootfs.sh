#!/usr/bin/env bash
# Build a minimal glibc userland for the unmodified official Shecan desktop.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: build-debian-rootfs.sh <empty-rootfs>" >&2
  exit 2
fi
ROOTFS=$(cd "$1" && pwd)

docker run --rm --platform linux/amd64 \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$ROOTFS:/out" \
  debian:12-slim \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends debootstrap
    debootstrap --variant=minbase --arch=amd64 bookworm /out http://deb.debian.org/debian
    cp /etc/resolv.conf /out/etc/resolv.conf
    printf "#!/bin/sh\nexit 101\n" > /out/usr/sbin/policy-rc.d
    chmod 0755 /out/usr/sbin/policy-rc.d
    chroot /out /bin/bash -euo pipefail -c "
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends \
        busybox-static net-tools kmod iproute2 ca-certificates openresolv \
        libwebkit2gtk-4.1-0 libgtk-3-0 dbus dbus-x11 tinyproxy \
        fonts-noto-core libgl1-mesa-dri libegl-mesa0
      dbus-uuidgen --ensure=/etc/machine-id
      apt-get clean
    "
    rm -f /out/usr/sbin/policy-rc.d
    ln -sf /bin/busybox /out/sbin/poweroff
    rm -rf /out/var/lib/apt/lists/* /out/var/cache/apt/* \
      /out/usr/share/doc/* /out/usr/share/man/* /out/usr/share/locale/*
    test -x /out/usr/bin/dbus-run-session
    test -x /out/usr/sbin/tinyproxy
    chown -R "$HOST_UID:$HOST_GID" /out
    chmod -R a+rX /out
  '
