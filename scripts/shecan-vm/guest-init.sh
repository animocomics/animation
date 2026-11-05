#!/bin/sh
# PID 1 for the harmless, networkless graphical VM probe.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p /proc /sys /dev
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mkdir -p /dev/pts /dev/shm /tmp /run /var/log
mount -t devpts devpts /dev/pts 2>/dev/null || true
mount -t tmpfs tmpfs /dev/shm 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp /tmp/.X11-unix /dev/shm
hostname nomreh-guest

echo NOMREH_GUI_PROBE_BEGIN > /dev/console
/usr/local/bin/Xvnc :0 -geometry 1100x760 -depth 24 \
  -SecurityTypes None -localhost -NeverShared \
  > /var/log/xvnc.log 2>&1 &
XVNC_PID=$!

ready=0
for attempt in $(seq 1 100); do
  if [ -S /tmp/.X11-unix/X0 ]; then ready=1; break; fi
  if ! kill -0 "$XVNC_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo NOMREH_GUI_PROBE_ERROR XVNC > /dev/console
  tail -30 /var/log/xvnc.log > /dev/console 2>&1 || true
  poweroff -f
  while true; do sleep 60; done
fi

export DISPLAY=:0
export NO_AT_BRIDGE=1
export LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
# This networkless static-HTML probe needs no WebKit sandbox. QEMU remains the boundary.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

/usr/local/bin/nomreh-gui-probe > /dev/console 2>&1
STATUS=$?
echo "NOMREH_GUI_PROBE_PROCESS_STATUS $STATUS" > /dev/console
kill "$XVNC_PID" 2>/dev/null || true
sync
poweroff -f
while true; do sleep 60; done
