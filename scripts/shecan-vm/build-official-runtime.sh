#!/usr/bin/env bash
# Build and boot the official Shecan desktop in an isolated rootless QEMU guest.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build-official-runtime.sh <source-root> <output-archive>" >&2
  exit 2
fi
SOURCE_ROOT=$(cd "$1" && pwd)
ARCHIVE=$2
RPM_URL='https://dl.shecan.ir/download/linux/amd64?version=v3.0.30&format=rpm'
RPM_SHA256=${SHECAN_RPM_SHA256:?SHECAN_RPM_SHA256 must pin the official RPM}
ALPINE_INITRAMFS_URL='https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/netboot-3.24.2/initramfs-virt'
ALPINE_INITRAMFS_SHA256=${ALPINE_INITRAMFS_SHA256:?ALPINE_INITRAMFS_SHA256 must pin the Alpine initramfs}
XVNC_URL=https://github.com/unpins/xvnc/releases/download/v1.16.2-1/xvnc-1.16.2-1-x86_64-linux.zst
XVNC_SHA256=1193f75a5a2a27aec1a5636dfe47a5f326b34ed0b00724cf94aa719afe55fdea
WORK=$(mktemp -d)
RUNNER_PID=''
VNC_PID=''
trap 'if [[ -n "$RUNNER_PID" ]]; then kill "$RUNNER_PID" 2>/dev/null || true; fi; if [[ -n "$VNC_PID" ]]; then kill "$VNC_PID" 2>/dev/null || true; fi; rm -rf "$WORK" 2>/dev/null || true' EXIT
mkdir -p "$WORK/rootfs" "$WORK/full"
bash "$SOURCE_ROOT/scripts/shecan-vm/build-debian-rootfs.sh" "$WORK/rootfs"
mkdir -p "$WORK/rootfs/usr/local/bin" "$WORK/rootfs/etc"

if ! bash "$SOURCE_ROOT/scripts/shecan-vm/build-probe.sh" "$SOURCE_ROOT" "$WORK/base.zip" > "$WORK/base-build.log" 2>&1; then
  cat "$WORK/base-build.log" >&2
  exit 1
fi
unzip -q "$WORK/base.zip" -d "$WORK/full"
mv "$WORK/full/nomreh-vm/probe" "$WORK/full/nomreh-vm/official"
rm -f "$WORK/full/nomreh-vm/official/guest/initramfs-probe" "$WORK/full/nomreh-vm/official/run-probe.sh"
while IFS= read -r -d '' binary; do
  if readelf -h "$binary" >/dev/null 2>&1; then strip --strip-unneeded "$binary"; fi
done < <(find "$WORK/full/nomreh-vm/official/qemu/bin" "$WORK/full/nomreh-vm/official/qemu/lib" -type f -print0)
QEMU_SHARE="$WORK/full/nomreh-vm/official/qemu/share/qemu"
rm -f "$QEMU_SHARE"/edk2-* "$QEMU_SHARE"/openbios-* "$QEMU_SHARE/slof.bin" "$QEMU_SHARE/skiboot.lid"
rm -rf "$WORK/full/nomreh-vm/official/qemu/share/doc"

curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
  --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36' \
  --cookie "$WORK/shecan-rpm.cookies" --cookie-jar "$WORK/shecan-rpm.cookies" \
  --output "$WORK/shecan.rpm" "$RPM_URL"
printf '%s  %s\n' "$RPM_SHA256" "$WORK/shecan.rpm" | sha256sum --check --quiet
mkdir -p "$WORK/rpm-extracted" "$WORK/linux-root"
7z x -y -o"$WORK/rpm-extracted" "$WORK/shecan.rpm" > "$WORK/rpm-extract.log"
cpio_file=$(find "$WORK/rpm-extracted" -type f -name '*.cpio' | head -n 1)
test -n "$cpio_file"
7z x -y -o"$WORK/linux-root" "$cpio_file" > "$WORK/rpm-cpio-extract.log"
find "$WORK/linux-root" -type f -name '*.desktop' -exec sh -c \
  'for file; do echo "OFFICIAL_DESKTOP_ENTRY $file"; grep -E "^(Name|Exec|Icon|Terminal|Type)=" "$file" || true; done' sh {} +
for binary in shecan-desktop shecan-nextdns shecan-game shecan-updater; do
  test -x "$WORK/linux-root/usr/local/bin/$binary"
  install -m 0755 "$WORK/linux-root/usr/local/bin/$binary" "$WORK/rootfs/usr/local/bin/$binary"
done
test "$(stat -c %s "$WORK/rootfs/usr/local/bin/shecan-desktop")" = 29377512
file "$WORK/rootfs/usr/local/bin/shecan-desktop"
sha256sum "$WORK/rootfs/usr/local/bin"/shecan-*

curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
  --output "$WORK/alpine-initramfs" "$ALPINE_INITRAMFS_URL"
printf '%s  %s\n' "$ALPINE_INITRAMFS_SHA256" "$WORK/alpine-initramfs" | sha256sum --check --quiet
python3 "$SOURCE_ROOT/scripts/shecan-vm/extract-alpine-modules.py" \
  "$WORK/alpine-initramfs" "$WORK/rootfs" failover net_failover virtio_net

curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
  --output "$WORK/xvnc.zst" "$XVNC_URL"
printf '%s  %s\n' "$XVNC_SHA256" "$WORK/xvnc.zst" | sha256sum --check --quiet
zstd -q -d "$WORK/xvnc.zst" -o "$WORK/rootfs/usr/local/bin/Xvnc"
chmod 0755 "$WORK/rootfs/usr/local/bin/Xvnc"
install -m 0644 "$SOURCE_ROOT/scripts/shecan-vm/tinyproxy-nomreh.conf" "$WORK/rootfs/etc/tinyproxy-nomreh.conf"

test -f "$WORK/rootfs/etc/passwd"
grep -E '^root:[^:]*:0:0:' "$WORK/rootfs/etc/passwd" >/dev/null
chmod 0755 "$WORK/rootfs/usr/local/bin"/shecan-* "$WORK/rootfs/usr/local/bin/Xvnc"
docker run --rm --platform linux/amd64 -v "$WORK/rootfs:/out" debian:12-slim \
  chroot /out /bin/bash -euo pipefail -c '
    ldd /usr/local/bin/shecan-desktop
    if ldd /usr/local/bin/shecan-desktop | grep -q "not found"; then exit 1; fi
    test -x /usr/bin/dbus-run-session
    test -x /usr/bin/tinyproxy
    test -x /usr/bin/tigervncconfig
  '

du -sh "$WORK/full/nomreh-vm/official/qemu" "$WORK/full/nomreh-vm/official/glibc" "$WORK/rootfs"
python3 "$SOURCE_ROOT/scripts/shecan-vm/rootfs-initramfs.py" \
  "$WORK/rootfs" "$SOURCE_ROOT/scripts/shecan-vm/official-guest-init.sh" \
  "$WORK/full/nomreh-vm/official/guest/initramfs-official"
INITRAMFS_BYTES=$(stat -c %s "$WORK/full/nomreh-vm/official/guest/initramfs-official")
if ((INITRAMFS_BYTES > 200 * 1024 * 1024)); then
  echo "Official guest initramfs exceeds the 200 MiB pre-boot budget: $INITRAMFS_BYTES" >&2
  exit 1
fi
install -m 0755 "$SOURCE_ROOT/scripts/shecan-vm/run-official.sh" "$WORK/full/nomreh-vm/official/run-official.sh"
RUNTIME="$WORK/full/nomreh-vm/official"
python3 - "$RUNTIME" "$RPM_SHA256" <<'PY'
import hashlib, json, os, sys
root, rpm_hash = sys.argv[1:]
files = {}
for relative in [
    'glibc/lib/x86_64-linux-gnu/ld-2.27.so',
    'qemu/bin/qemu-system-x86_64',
    'guest/vmlinuz-virt',
    'guest/initramfs-official',
    'run-official.sh',
]:
    with open(os.path.join(root, relative), 'rb') as source:
        files[relative] = hashlib.sha256(source.read()).hexdigest()
with open(os.path.join(root, 'runtime-manifest.json'), 'w') as output:
    json.dump({'format': 1, 'officialRpmSha256': rpm_hash, 'files': files}, output, indent=2, sort_keys=True)
    output.write('\n')
PY
cat > "$RUNTIME/THIRD_PARTY.md" <<EOF
# Official Shecan guest provenance

The versioned official RPM is included without credentials, account data, update
links, or Nomreh API keys. No host service or host DNS configuration is used.

- Official Shecan v3.0.30 Linux RPM: $RPM_URL
- Official RPM SHA-256: $RPM_SHA256
- Alpine matching netboot initramfs: $ALPINE_INITRAMFS_URL
- Alpine initramfs SHA-256: $ALPINE_INITRAMFS_SHA256
- Xvnc: $XVNC_URL
- Xvnc SHA-256: $XVNC_SHA256
- QEMU/glibc/kernel: inherited from the validated harmless probe builder.
- Debian 12 (bookworm) glibc userland with distribution WebKitGTK, DBus and Tinyproxy.
EOF

NOMREH_VM_PROBE=1 NOMREH_VNC_PORT=15900 NOMREH_PROXY_PORT=18888 \
  NOMREH_VM_MEMORY=2048M NOMREH_VM_TIMEOUT=300 \
  "$RUNTIME/run-official.sh" > "$WORK/official-guest.log" 2>&1 &
RUNNER_PID=$!
app_ready=0
for ((attempt = 0; attempt < 300; attempt++)); do
  if grep -q 'NOMREH_OFFICIAL_APP_PROCESS_ALIVE' "$WORK/official-guest.log"; then app_ready=1; break; fi
  if grep -q 'NOMREH_OFFICIAL_APP_ERROR' "$WORK/official-guest.log"; then break; fi
  if ! kill -0 "$RUNNER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if ((app_ready != 1)); then
  echo 'Official guest did not reach its live application marker.' >&2
  cat "$WORK/official-guest.log"
  exit 1
fi
# Require the actual reverse-VNC path used by the Plesk console, not only the
# host-forward path that timed out on that shared host. The guest must initiate
# a loopback connection to this listener and render the genuine official app.
set +e
echo NOMREH_VNC_SMOKE_LAUNCHING
VNC_SMOKE_REVERSE=1 VNC_SMOKE_TRACE=1 VNC_READ_TIMEOUT_MS=5000 VNC_SMOKE_ATTEMPTS=60 \
  python3 "$SOURCE_ROOT/scripts/shecan-vm/vnc-smoke.py" 15500 "$WORK/official-framebuffer.ppm" > "$WORK/vnc-smoke.log" 2>&1 &
VNC_PID=$!
set -e
echo "NOMREH_VNC_SMOKE_STARTED pid=$VNC_PID"
vnc_status=1
for ((attempt = 0; attempt < 180; attempt++)); do
  if ! kill -0 "$VNC_PID" 2>/dev/null; then
    set +e
    wait "$VNC_PID"
    vnc_status=$?
    set -e
    break
  fi
  if ! kill -0 "$RUNNER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if ((vnc_status != 0)) && [[ -n "$VNC_PID" ]]; then kill "$VNC_PID" 2>/dev/null || true; fi
VNC_PID=''
cat "$WORK/vnc-smoke.log"
if ((vnc_status != 0)); then
  echo 'Official guest did not produce a real rendered VNC framebuffer.' >&2
  cat "$WORK/official-guest.log"
  exit 1
fi
kill "$RUNNER_PID" 2>/dev/null || true
set +e
wait "$RUNNER_PID" 2>/dev/null
set -e
RUNNER_PID=''
cat "$WORK/official-guest.log"
grep -F 'NOMREH_OFFICIAL_APP_PROCESS_ALIVE' "$WORK/official-guest.log"
grep -F 'NOMREH_OFFICIAL_AI_BROKER_LISTENING' "$WORK/official-guest.log"
grep -F 'NOMREH_OFFICIAL_APP_BOOT_PASS' "$WORK/official-guest.log"
grep -F 'NOMREH_VNC_FRAMEBUFFER_PASS' "$WORK/vnc-smoke.log"

rm -f "$ARCHIVE"
(cd "$WORK/full" && zip -q -9 -r "$ARCHIVE" nomreh-vm)
ARCHIVE_BYTES=$(stat -c %s "$ARCHIVE")
printf 'Official VM archive bytes=%s\n' "$ARCHIVE_BYTES"
du -sh "$RUNTIME" "$RUNTIME/qemu" "$RUNTIME/glibc" "$RUNTIME/guest"
sha256sum "$ARCHIVE"
if ((ARCHIVE_BYTES > 220 * 1024 * 1024)); then
  echo "Official VM archive exceeds the 220 MB upload safety limit: $ARCHIVE_BYTES" >&2
  exit 1
fi
