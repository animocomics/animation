#!/usr/bin/env bash
# Build a networkless GUI guest. The optional official-app probe is local-only.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build-gui-probe.sh <source-root> <output-archive>" >&2
  exit 2
fi
SOURCE_ROOT=$(cd "$1" && pwd)
ARCHIVE=$2
OFFICIAL_PROBE=${NOMREH_OFFICIAL_APP_PROBE:-0}
if [[ "$OFFICIAL_PROBE" != 0 && "$OFFICIAL_PROBE" != 1 ]]; then
  echo 'Invalid probe mode.' >&2
  exit 2
fi
XVNC_URL=https://github.com/unpins/xvnc/releases/download/v1.16.2-1/xvnc-1.16.2-1-x86_64-linux.zst
XVNC_SHA256=1193f75a5a2a27aec1a5636dfe47a5f326b34ed0b00724cf94aa719afe55fdea
WORK=$(mktemp -d)
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT
mkdir -p "$WORK/rootfs/usr/local/bin" "$WORK/full"

# Reuse the exact QEMU/glibc/kernel bundle whose networkless boot is gated.
if ! bash "$SOURCE_ROOT/scripts/shecan-vm/build-probe.sh" "$SOURCE_ROOT" "$WORK/base.zip" > "$WORK/base-build.log" 2>&1; then
  cat "$WORK/base-build.log" >&2
  exit 1
fi
unzip -q "$WORK/base.zip" -d "$WORK/full"
mv "$WORK/full/nomreh-vm/probe" "$WORK/full/nomreh-vm/gui"
rm -f "$WORK/full/nomreh-vm/gui/guest/initramfs-probe" "$WORK/full/nomreh-vm/gui/run-probe.sh"
echo 'QEMU/glibc size before stripping:'
du -sh "$WORK/full/nomreh-vm/gui/qemu" "$WORK/full/nomreh-vm/gui/glibc"
while IFS= read -r -d '' binary; do
  if readelf -h "$binary" >/dev/null 2>&1; then
    strip --strip-unneeded "$binary"
  fi
done < <(find "$WORK/full/nomreh-vm/gui/qemu/bin" "$WORK/full/nomreh-vm/gui/qemu/lib" -type f -print0)
# This x86-64 guest boots a Linux kernel directly through SeaBIOS. Firmware
# for other architectures and UEFI is unused; the local boot below is a gate.
QEMU_SHARE="$WORK/full/nomreh-vm/gui/qemu/share/qemu"
rm -f "$QEMU_SHARE"/edk2-* "$QEMU_SHARE"/openbios-* \
  "$QEMU_SHARE/slof.bin" "$QEMU_SHARE/skiboot.lid"
rm -rf "$WORK/full/nomreh-vm/gui/qemu/share/doc"
echo 'QEMU/glibc size after stripping and scoped firmware removal:'
du -sh "$WORK/full/nomreh-vm/gui/qemu" "$WORK/full/nomreh-vm/gui/glibc"
echo 'Largest QEMU files:'
du -ah "$WORK/full/nomreh-vm/gui/qemu" | sort -h | tail -25

# Install only runtime packages into the guest rootfs. Build headers and the
# compiler stay in the disposable container and are never packed or deployed.
docker run --rm --platform linux/amd64 \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$WORK/rootfs:/out" \
  -v "$SOURCE_ROOT/scripts/shecan-vm:/src:ro" \
  alpine:3.24.2 \
  sh -euo pipefail -c '
    export DISPLAY=
    apk add --no-cache build-base pkgconf gtk+3.0-dev webkit2gtk-4.1-dev >/dev/null
    mkdir -p /out/usr/local/bin
    cc -Os -Wall -Wextra -Werror -o /out/usr/local/bin/nomreh-gui-probe \
      /src/gui-probe.c $(pkg-config --cflags --libs webkit2gtk-4.1)
    apk add --no-cache --root /out --initdb \
      --repository https://dl-cdn.alpinelinux.org/alpine/v3.24/main \
      --repository https://dl-cdn.alpinelinux.org/alpine/v3.24/community \
      --keys-dir /etc/apk/keys \
      busybox musl gcompat libc6-compat ca-certificates \
      webkit2gtk-4.1 gtk+3.0 dbus tinyproxy font-noto-arabic xwininfo >/dev/null
    rm -rf /out/var/cache/apk/* /out/usr/share/man
    # Keep Mesa/LLVM: Alpine libGL/libEGL link to libgallium directly even
    # when WebKit compositing and DMABUF are disabled.
    chown -R "$HOST_UID:$HOST_GID" /out
    chmod -R a+rX /out
    chmod 0755 /out/usr/local/bin/nomreh-gui-probe
  '

curl --fail --location --silent --show-error --retry 5 --retry-all-errors \
  --output "$WORK/xvnc.zst" "$XVNC_URL"
printf '%s  %s\n' "$XVNC_SHA256" "$WORK/xvnc.zst" | sha256sum --check --quiet
zstd -q -d "$WORK/xvnc.zst" -o "$WORK/rootfs/usr/local/bin/Xvnc"
chmod 0755 "$WORK/rootfs/usr/local/bin/Xvnc"
file "$WORK/rootfs/usr/local/bin/Xvnc"
readelf -l "$WORK/rootfs/usr/local/bin/Xvnc" | grep -A1 interpreter || echo 'Xvnc has no external program interpreter.'

if [[ "$OFFICIAL_PROBE" == 1 ]]; then
  # The package is obtained directly over HTTPS from the official release
  # endpoint. Record hashes; no unpinned package is uploaded to Plesk.
  curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
    --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36' \
    --cookie "$WORK/official.cookies" --cookie-jar "$WORK/official.cookies" \
    --output "$WORK/shecan.rpm" \
    'https://dl.shecan.ir/download/linux/amd64?version=v3.0.30&format=rpm'
  file "$WORK/shecan.rpm"
  # Pin the exact official release observed in the credential-free inspection.
  printf '%s  %s\n' 59a300035e25a9dbe0b4e26f44333883bcb26b9e7ab1af5bac88310095f122b2 "$WORK/shecan.rpm" | sha256sum --check
  mkdir -p "$WORK/rpm" "$WORK/official-root"
  7z x -y -o"$WORK/rpm" "$WORK/shecan.rpm" >/dev/null
  cpio_file=$(find "$WORK/rpm" -type f -name '*.cpio' -print -quit)
  [[ -n "$cpio_file" ]] || { echo 'Official RPM payload not found.' >&2; exit 1; }
  7z x -y -o"$WORK/official-root" "$cpio_file" >/dev/null
  for executable in shecan-desktop shecan-game shecan-nextdns shecan-updater; do
    source_file="$WORK/official-root/usr/local/bin/$executable"
    [[ -f "$source_file" && ! -L "$source_file" ]] || { echo "Missing official executable: $executable" >&2; exit 1; }
    sha256sum "$source_file"
    install -m 0755 "$source_file" "$WORK/rootfs/usr/local/bin/$executable"
  done
  INIT_SCRIPT="$SOURCE_ROOT/scripts/shecan-vm/guest-init-official-probe.sh"
else
  INIT_SCRIPT="$SOURCE_ROOT/scripts/shecan-vm/guest-init.sh"
fi

du -sh "$WORK/rootfs"
echo 'Largest guest rootfs files:'
du -ah "$WORK/rootfs" | sort -h | tail -30
python3 "$SOURCE_ROOT/scripts/shecan-vm/rootfs-initramfs.py" \
  "$WORK/rootfs" "$INIT_SCRIPT" \
  "$WORK/full/nomreh-vm/gui/guest/initramfs-gui"
install -m 0755 "$SOURCE_ROOT/scripts/shecan-vm/run-gui.sh" "$WORK/full/nomreh-vm/gui/run-gui.sh"
if [[ "$OFFICIAL_PROBE" == 0 ]]; then
cat > "$WORK/full/nomreh-vm/gui/THIRD_PARTY.md" <<EOF
# Harmless graphical VM probe provenance

No Shecan executable, account, update link, credential, or AI key is included.
The guest has no virtual NIC and WebKit loads only inline static HTML.

- QEMU/glibc/kernel: inherited from the validated harmless probe builder.
- Alpine rootfs packages: Alpine v3.24 main/community, installed by APK.
- Xvnc: $XVNC_URL
- Xvnc SHA-256: $XVNC_SHA256
- GUI probe and init sources: scripts/shecan-vm in this private repository.
EOF
fi

RUNTIME="$WORK/full/nomreh-vm/gui"
set +e
"$RUNTIME/run-gui.sh" > "$WORK/gui-probe.log" 2>&1
PROBE_STATUS=$?
set -e
cat "$WORK/gui-probe.log"
if ((PROBE_STATUS != 0)); then
  echo "Local graphical VM probe exited with status $PROBE_STATUS." >&2
  exit "$PROBE_STATUS"
fi
if [[ "$OFFICIAL_PROBE" == 1 ]]; then
  grep -Fx 'NOMREH_OFFICIAL_PROBE_WINDOW_OBSERVED yes' <(tr -d '\r' < "$WORK/gui-probe.log")
  grep -Fx 'NOMREH_OFFICIAL_PROBE_NO_NETWORK yes' <(tr -d '\r' < "$WORK/gui-probe.log")
  grep -Fx 'NOMREH_OFFICIAL_PROBE_NO_CREDENTIALS yes' <(tr -d '\r' < "$WORK/gui-probe.log")
  grep -Fx 'NOMREH_OFFICIAL_PROBE_PASS' <(tr -d '\r' < "$WORK/gui-probe.log")
  echo 'Local official-app probe only: no archive was prepared, uploaded, or deployed.'
  exit 0
fi
grep -F 'NOMREH_GUI_PROBE_WEBKIT_LOAD_FINISHED' "$WORK/gui-probe.log"
grep -F 'NOMREH_GUI_PROBE_NO_NETWORK yes' "$WORK/gui-probe.log"
grep -F 'NOMREH_GUI_PROBE_SHECAN_INCLUDED no' "$WORK/gui-probe.log"
grep -F 'NOMREH_GUI_PROBE_PASS' "$WORK/gui-probe.log"

rm -f "$ARCHIVE"
(cd "$WORK/full" && zip -q -9 -r "$ARCHIVE" nomreh-vm)
ARCHIVE_BYTES=$(stat -c %s "$ARCHIVE")
printf 'Graphical VM archive bytes=%s\n' "$ARCHIVE_BYTES"
du -sh "$RUNTIME" "$RUNTIME/qemu" "$RUNTIME/glibc" "$RUNTIME/guest"
sha256sum "$ARCHIVE"
if ((ARCHIVE_BYTES > 90 * 1024 * 1024)); then
  echo "Graphical VM archive exceeds the 90 MB upload safety limit: $ARCHIVE_BYTES" >&2
  exit 1
fi
