#!/usr/bin/env bash
# Local-only, credential-free diagnostic. Never uploads or deploys to Plesk.
set -euo pipefail
if [[ $# -ne 1 ]]; then echo 'usage: build-official-glibc-vm.sh <source-root>' >&2; exit 2; fi
SOURCE_ROOT=$(cd "$1" && pwd)
WORK=$(mktemp -d)
CONTAINER=''
cleanup() {
  if [[ -n "$CONTAINER" ]]; then docker rm "$CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/context" "$WORK/rpm" "$WORK/pkg" "$WORK/rootfs" "$WORK/full"

curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  --user-agent 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36' \
  --cookie "$WORK/cookies" --cookie-jar "$WORK/cookies" \
  --output "$WORK/package.rpm" 'https://dl.shecan.ir/download/linux/amd64?version=v3.0.30&format=rpm'
printf '%s  %s\n' 59a300035e25a9dbe0b4e26f44333883bcb26b9e7ab1af5bac88310095f122b2 "$WORK/package.rpm" | sha256sum --check
7z x -y -o"$WORK/rpm" "$WORK/package.rpm" >/dev/null
payload=$(find "$WORK/rpm" -type f -name '*.cpio' -print -quit)
[[ -n "$payload" ]] || { echo 'Official RPM payload not found.' >&2; exit 1; }
7z x -y -o"$WORK/pkg" "$payload" >/dev/null
for binary in shecan-desktop shecan-game shecan-nextdns shecan-updater; do
  source_file="$WORK/pkg/usr/local/bin/$binary"
  [[ -f "$source_file" && ! -L "$source_file" ]] || { echo "Missing official executable: $binary" >&2; exit 1; }
  install -m 0755 "$source_file" "$WORK/context/$binary"
done
XVNC_URL=https://github.com/unpins/xvnc/releases/download/v1.16.2-1/xvnc-1.16.2-1-x86_64-linux.zst
curl --fail --location --silent --show-error --retry 5 --retry-all-errors --output "$WORK/xvnc.zst" "$XVNC_URL"
printf '%s  %s\n' 1193f75a5a2a27aec1a5636dfe47a5f326b34ed0b00724cf94aa719afe55fdea "$WORK/xvnc.zst" | sha256sum --check
zstd -q -d "$WORK/xvnc.zst" -o "$WORK/context/Xvnc"
chmod 0755 "$WORK/context/Xvnc"
cat > "$WORK/context/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y --no-install-recommends libwebkit2gtk-4.1-0 libgtk-3-0 libx11-6 xvfb x11-utils dbus-x11 fonts-noto-core ca-certificates busybox-static socat && rm -rf /var/lib/apt/lists/* /usr/share/man/* /var/cache/apt/archives/*
COPY shecan-desktop shecan-game shecan-nextdns shecan-updater Xvnc /usr/local/bin/
DOCKERFILE
docker build -q -t nomreh-official-glibc-vm-probe "$WORK/context"
CONTAINER=$(docker create --network none nomreh-official-glibc-vm-probe /bin/true)
docker export "$CONTAINER" | tar -xf - -C "$WORK/rootfs"
rootfs_kib=$(du -sk "$WORK/rootfs" | cut -f1)
printf 'Uncompressed VM rootfs KiB=%s\n' "$rootfs_kib"
# Do not attempt an obviously unsafe boot if the in-memory filesystem leaves
# too little of the 2 GiB local runner VM budget for kernel and processes.
if ((rootfs_kib > 1200 * 1024)); then echo 'Rootfs exceeds local-only VM memory safety threshold.' >&2; exit 1; fi

if ! bash "$SOURCE_ROOT/scripts/shecan-vm/build-probe.sh" "$SOURCE_ROOT" "$WORK/base.zip" > "$WORK/base-build.log" 2>&1; then
  cat "$WORK/base-build.log" >&2; exit 1
fi
unzip -q "$WORK/base.zip" -d "$WORK/full"
mv "$WORK/full/nomreh-vm/probe" "$WORK/full/nomreh-vm/gui"
rm -f "$WORK/full/nomreh-vm/gui/guest/initramfs-probe" "$WORK/full/nomreh-vm/gui/run-probe.sh"
# Strip only disposable QEMU copies; preserve bundled notices and firmware.
while IFS= read -r -d '' binary; do
  if readelf -h "$binary" >/dev/null 2>&1; then strip --strip-unneeded "$binary"; fi
done < <(find "$WORK/full/nomreh-vm/gui/qemu/bin" "$WORK/full/nomreh-vm/gui/qemu/lib" -type f -print0)
cat > "$WORK/full/nomreh-vm/gui/THIRD_PARTY.md" <<'PROVENANCE'
# Local offline official desktop diagnostic

This disposable image includes the official Shecan Linux desktop and support
executables, Ubuntu runtime packages, Xvnc, QEMU, glibc and the Alpine kernel.
The guest has no NIC or persistent disk; no credentials are included. License
notices shipped in QEMU and Ubuntu packages are retained in this diagnostic.
This is not a host deployment package.
PROVENANCE
INIT_SCRIPT="$SOURCE_ROOT/scripts/shecan-vm/guest-init-glibc-probe.sh"
if [[ "${NOMREH_LOCAL_DISPLAY_PROBE:-0}" == 1 ]]; then
  INIT_SCRIPT="$SOURCE_ROOT/scripts/shecan-vm/guest-init-display-probe.sh"
fi
python3 "$SOURCE_ROOT/scripts/shecan-vm/rootfs-initramfs.py" \
  "$WORK/rootfs" "$INIT_SCRIPT" \
  "$WORK/full/nomreh-vm/gui/guest/initramfs-gui"
install -m 0755 "$SOURCE_ROOT/scripts/shecan-vm/run-gui.sh" "$WORK/full/nomreh-vm/gui/run-gui.sh"
if [[ "${NOMREH_LOCAL_DISPLAY_PROBE:-0}" == 1 ]]; then
  : "${NOMREH_LOCAL_NOVNC_DIR:?Local noVNC checkout is required}"
  install -m 0755 "$SOURCE_ROOT/scripts/shecan-vm/run-display-probe.sh" "$WORK/full/nomreh-vm/gui/run-display-probe.sh"
  if [[ -n "${NOMREH_DISPLAY_CACHE_DIR:-}" ]]; then
    mkdir -p "$NOMREH_DISPLAY_CACHE_DIR"
    cp -a "$WORK/full/nomreh-vm/gui/." "$NOMREH_DISPLAY_CACHE_DIR/"
  fi
  node "$SOURCE_ROOT/scripts/shecan-vm/display-probe.cjs" "$WORK/full/nomreh-vm/gui" "$NOMREH_LOCAL_NOVNC_DIR"
  echo 'Local display diagnostic only; nothing was uploaded or deployed.'
  exit 0
fi
set +e
"$WORK/full/nomreh-vm/gui/run-gui.sh" > "$WORK/guest.log" 2>&1
result=$?
set -e
cat "$WORK/guest.log"
if ((result != 0)); then echo "Local VM returned status $result" >&2; exit "$result"; fi
for marker in 'NOMREH_OFFICIAL_PROBE_WINDOW_OBSERVED yes' 'NOMREH_OFFICIAL_PROBE_NO_NETWORK yes' 'NOMREH_OFFICIAL_PROBE_NO_CREDENTIALS yes' 'NOMREH_OFFICIAL_PROBE_PASS'; do
  grep -Fx "$marker" <(tr -d '\r' < "$WORK/guest.log") >/dev/null
done
python3 "$SOURCE_ROOT/scripts/shecan-vm/package-probe.py" "$WORK/full/nomreh-vm/gui" "$WORK/local-packages"
echo 'Local glibc VM and package verification complete; no archive was uploaded or deployed.'
