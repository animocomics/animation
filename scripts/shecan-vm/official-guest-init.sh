#!/bin/sh
# PID 1 for the official Shecan desktop guest. No credentials are embedded.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

mkdir -p /proc /sys /dev
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mkdir -p /dev/pts /dev/shm /tmp /run /var/log /root/.config /root/.cache /run/user/0
mount -t devpts devpts /dev/pts 2>/dev/null || true
mount -t tmpfs tmpfs /dev/shm 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp /tmp/.X11-unix /dev/shm
chmod 0700 /run/user/0
hostname nomreh-shecan

echo NOMREH_OFFICIAL_GUEST_BEGIN > /dev/console
for module in failover net_failover virtio_net; do
  if ! insmod "/lib/modules/$module.ko" 2>/dev/null; then
    echo "NOMREH_OFFICIAL_GUEST_ERROR module_$module" > /dev/console
    poweroff -f
    while true; do sleep 60; done
  fi
done

network_ready=0
for attempt in $(seq 1 100); do
  if [ -e "/sys/class/net/eth0" ]; then network_ready=1; break; fi
  sleep 0.1
done
if [ "$network_ready" -ne 1 ]; then
  echo NOMREH_OFFICIAL_GUEST_ERROR NO_ETH0 > /dev/console
  poweroff -f
  while true; do sleep 60; done
fi
ifconfig eth0 10.0.2.15 netmask 255.255.255.0 up
route add default gw 10.0.2.2
rm -f /etc/resolv.conf
printf 'nameserver 10.0.2.3\n' > /etc/resolv.conf
echo NOMREH_OFFICIAL_GUEST_NETWORK_CONFIGURED > /dev/console

vnc_localhost='-localhost'
if grep -q 'nomreh_vnc=hostfwd' /proc/cmdline; then vnc_localhost=''; fi
/usr/local/bin/Xvnc :0 -geometry 1200x800 -depth 24 \
  -SecurityTypes None -NeverShared $vnc_localhost \
  > /var/log/xvnc.log 2>&1 &
XVNC_PID=$!
xvnc_ready=0
for attempt in $(seq 1 100); do
  if [ -S /tmp/.X11-unix/X0 ]; then xvnc_ready=1; break; fi
  if ! kill -0 "$XVNC_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$xvnc_ready" -ne 1 ]; then
  echo NOMREH_OFFICIAL_GUEST_ERROR XVNC > /dev/console
  poweroff -f
  while true; do sleep 60; done
fi

mkdir -p /run/dbus
if ! dbus-daemon --system --fork --address=unix:path=/run/dbus/system_bus_socket --print-pid=1 > /run/dbus-system.pid; then
  echo NOMREH_OFFICIAL_GUEST_ERROR DBUS_SYSTEM > /dev/console
  poweroff -f
  while true; do sleep 60; done
fi
DBUS_SYSTEM_BUS_PID=$(cat /run/dbus-system.pid)
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
export DISPLAY=:0
export GDK_BACKEND=x11
export XDG_RUNTIME_DIR=/run/user/0
export XDG_CONFIG_HOME=/root/.config
export XDG_CACHE_HOME=/root/.cache
export NO_AT_BRIDGE=1
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export LP_NUM_THREADS=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GOTRACEBACK=single

twm > /var/log/twm.log 2>&1 &
WM_PID=$!
sleep 1
if ! kill -0 "$WM_PID" 2>/dev/null; then
  echo NOMREH_OFFICIAL_GUEST_ERROR WINDOW_MANAGER > /dev/console
  head -40 /var/log/twm.log > /dev/console 2>&1 || true
  poweroff -f
  while true; do sleep 60; done
fi

if grep -q 'nomreh_proxy=1' /proc/cmdline; then
  tinyproxy -d -c /etc/tinyproxy-nomreh.conf > /var/log/tinyproxy-nomreh.log 2>&1 &
  TINYPROXY_PID=$!
  broker_ready=0
  for attempt in $(seq 1 100); do
    if awk '$2 ~ /:22B8$/ && $4 == "0A" { found=1 } END { exit found ? 0 : 1 }' /proc/net/tcp; then
      broker_ready=1
      break
    fi
    if ! kill -0 "$TINYPROXY_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [ "$broker_ready" -ne 1 ]; then
    echo NOMREH_OFFICIAL_GUEST_ERROR TINYPROXY > /dev/console
    if grep -q 'nomreh_probe=1' /proc/cmdline; then
      tail -40 /var/log/tinyproxy-nomreh.log > /dev/console 2>&1 || true
    fi
    poweroff -f
    while true; do sleep 60; done
  fi
  echo NOMREH_OFFICIAL_AI_BROKER_LISTENING > /dev/console
fi

dbus-run-session -- /usr/local/bin/shecan-desktop > /var/log/shecan-desktop.log 2>&1 &
APP_PID=$!
echo NOMREH_OFFICIAL_APP_PROCESS_STARTED > /dev/console
sleep 15
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo NOMREH_OFFICIAL_APP_ERROR PROCESS_EXITED > /dev/console
  if grep -q 'nomreh_probe=1' /proc/cmdline; then
    head -120 /var/log/shecan-desktop.log > /dev/console 2>&1 || true
  fi
  poweroff -f
  while true; do sleep 60; done
fi
echo NOMREH_OFFICIAL_APP_PROCESS_ALIVE > /dev/console
xwininfo -root -tree > /var/log/xwininfo.log 2>&1 || true

if grep -q 'nomreh_probe=1' /proc/cmdline; then
  echo NOMREH_OFFICIAL_APP_BOOT_PASS > /dev/console
  # Leave enough time for software rendering under TCG and retain only the
  # credential-free initial-process logs if the framebuffer gate needs them.
  sleep 120
  xwininfo -root -tree > /var/log/xwininfo.log 2>&1 || true
  echo NOMREH_OFFICIAL_PROBE_LOG_BEGIN > /dev/console
  head -100 /var/log/xwininfo.log > /dev/console 2>&1 || true
  head -120 /var/log/shecan-desktop.log > /dev/console 2>&1 || true
  head -60 /var/log/xvnc.log > /dev/console 2>&1 || true
  echo NOMREH_OFFICIAL_PROBE_LOG_END > /dev/console
  kill "$APP_PID" 2>/dev/null || true
  kill "$WM_PID" 2>/dev/null || true
  kill "$XVNC_PID" 2>/dev/null || true
  if [ -n "$DBUS_SYSTEM_BUS_PID" ]; then kill "$DBUS_SYSTEM_BUS_PID" 2>/dev/null || true; fi
  sync
  poweroff -f
fi

while kill -0 "$APP_PID" 2>/dev/null; do sleep 5; done
echo NOMREH_OFFICIAL_APP_PROCESS_EXITED > /dev/console
poweroff -f
while true; do sleep 60; done
