#!/usr/bin/env bash
# Build and locally boot a harmless rootless QEMU probe for the Plesk host.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build-probe.sh <source-root> <output-archive>" >&2
  exit 2
fi

SOURCE_ROOT=$(cd "$1" && pwd)
ARCHIVE=$2
QEMU_URL=https://github.com/takumin/qemu-bin/releases/download/v2026.10.22/qemu-x86_64-linux-gnu.tar.gz
QEMU_SHA256=57524261a242b4816f3790e5118a312bae9ccf7d23eee8a53c1b8a9a3001ddd7
KERNEL_URL=https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/netboot-3.24.2/vmlinuz-virt
KERNEL_SHA256=40f620bc8c93d952e57dd8dfc0f94fca1759d192a4fc4a260705d50ca378559c
WORK=$(mktemp -d)
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT
mkdir -p "$WORK/downloads" "$WORK/qemu" "$WORK/glibc" "$WORK/staging/nomreh-vm/probe/qemu" "$WORK/staging/nomreh-vm/probe/guest"

curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
  --output "$WORK/downloads/qemu.tar.gz" "$QEMU_URL"
printf '%s  %s\n' "$QEMU_SHA256" "$WORK/downloads/qemu.tar.gz" | sha256sum --check --quiet
tar -xzf "$WORK/downloads/qemu.tar.gz" -C "$WORK/qemu"

curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
  --output "$WORK/downloads/vmlinuz-virt" "$KERNEL_URL"
printf '%s  %s\n' "$KERNEL_SHA256" "$WORK/downloads/vmlinuz-virt" | sha256sum --check --quiet

# Ubuntu 18.04 supplies glibc 2.27 in a domain-local directory. Nothing is
# installed into the Plesk host and its system loader is never replaced.
docker run --rm --platform linux/amd64 \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$WORK/glibc:/out" \
  ubuntu:18.04@sha256:152dc042452c496007f07ca9127571cb9c29697f42acbfad72324b2bb2e43c98 \
  bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    cd /tmp
    apt-get download libc6 libgcc1 >/dev/null
    for package in /tmp/libc6_*.deb /tmp/libgcc1_*.deb; do dpkg-deb -x "$package" /out; done
    test -f /out/lib/x86_64-linux-gnu/ld-2.27.so
    chown -R "$HOST_UID:$HOST_GID" /out
    chmod -R a+rX /out
  '

cc -static -Os -s -Wall -Wextra -Werror \
  -o "$WORK/probe-init" "$SOURCE_ROOT/scripts/shecan-vm/probe-init.c"
python3 "$SOURCE_ROOT/scripts/shecan-vm/initramfs.py" "$WORK/probe-init" "$WORK/staging/nomreh-vm/probe/guest/initramfs-probe"
cp "$WORK/downloads/vmlinuz-virt" "$WORK/staging/nomreh-vm/probe/guest/vmlinuz-virt"

# Keep only the system emulator and its runtime, not unrelated QEMU utilities.
cp -a "$WORK/qemu/bin/qemu-system-x86_64" "$WORK/staging/nomreh-vm/probe/qemu/"
mkdir -p "$WORK/staging/nomreh-vm/probe/qemu/bin"
mv "$WORK/staging/nomreh-vm/probe/qemu/qemu-system-x86_64" "$WORK/staging/nomreh-vm/probe/qemu/bin/"
cp -a "$WORK/qemu/lib" "$WORK/staging/nomreh-vm/probe/qemu/"
rm -rf "$WORK/staging/nomreh-vm/probe/qemu/lib/qemu/plugins"
mkdir -p "$WORK/staging/nomreh-vm/probe/qemu/share"
cp -a "$WORK/qemu/share/qemu" "$WORK/staging/nomreh-vm/probe/qemu/share/"
if [[ -d "$WORK/qemu/share/doc" ]]; then
  cp -a "$WORK/qemu/share/doc" "$WORK/staging/nomreh-vm/probe/qemu/share/"
fi
mkdir -p "$WORK/staging/nomreh-vm/probe/glibc"
cp -a "$WORK/glibc/." "$WORK/staging/nomreh-vm/probe/glibc/"
install -m 0755 "$SOURCE_ROOT/scripts/shecan-vm/run-probe.sh" "$WORK/staging/nomreh-vm/probe/run-probe.sh"

cat > "$WORK/staging/nomreh-vm/probe/THIRD_PARTY.md" <<EOF
# Harmless VM probe provenance

No Shecan executable, account, update link, credential, or AI key is included.

- QEMU runtime: $QEMU_URL
- QEMU archive SHA-256: $QEMU_SHA256
- Alpine virt kernel: $KERNEL_URL
- Alpine kernel SHA-256: $KERNEL_SHA256
- glibc/libgcc: Ubuntu 18.04 packages downloaded by APT and extracted locally.
- Probe init source: scripts/shecan-vm/probe-init.c in this private repository.

QEMU and the kernel are GPL-licensed; glibc is LGPL-licensed. The bundled
QEMU share/doc directory retains the license notices supplied by the runtime.
EOF

RUNTIME="$WORK/staging/nomreh-vm/probe"
"$RUNTIME/run-probe.sh" > "$WORK/local-probe.log" 2>&1 &
PROBE_PID=$!
for ((attempt = 0; attempt < 135; attempt++)); do
  if ! kill -0 "$PROBE_PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$PROBE_PID" 2>/dev/null; then
  kill "$PROBE_PID" 2>/dev/null || true
  echo "Local harmless VM probe timed out." >&2
  tail -80 "$WORK/local-probe.log" >&2
  exit 1
fi
set +e
wait "$PROBE_PID"
PROBE_STATUS=$?
set -e
cat "$WORK/local-probe.log"
if ((PROBE_STATUS != 0)); then
  echo "Local harmless VM probe exited with status $PROBE_STATUS." >&2
  exit "$PROBE_STATUS"
fi
grep -F 'NOMREH_VM_PROBE_NO_NETWORK yes' "$WORK/local-probe.log"
grep -F 'NOMREH_VM_PROBE_SHECAN_INCLUDED no' "$WORK/local-probe.log"
grep -F 'NOMREH_VM_PROBE_PASS' "$WORK/local-probe.log"

rm -f "$ARCHIVE"
(cd "$WORK/staging" && zip -q -9 -r "$ARCHIVE" nomreh-vm)
ARCHIVE_BYTES=$(stat -c %s "$ARCHIVE")
if ((ARCHIVE_BYTES > 90 * 1024 * 1024)); then
  echo "Probe archive exceeds the 90 MB upload safety limit: $ARCHIVE_BYTES" >&2
  exit 1
fi
printf 'Harmless VM probe archive bytes=%s\n' "$ARCHIVE_BYTES"
du -sh "$RUNTIME" "$RUNTIME/qemu" "$RUNTIME/glibc" "$RUNTIME/guest"
sha256sum "$ARCHIVE"
