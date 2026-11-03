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

if ! dbus-daemon --session --fork --print-address=1 --print-pid=1 > /run/dbus-session-info; then
  echo NOMREH_OFFICIAL_GUEST_ERROR DBUS > /dev/console
  poweroff -f
  while true; do sleep 60; done
fi
DBUS_SESSION_BUS_ADDRESS=$(sed -n '1p' /run/dbus-session-info)
DBUS_SESSION_BUS_PID=$(sed -n '2p' /run/dbus-session-info)
export DBUS_SESSION_BUS_ADDRESS
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/0
export XDG_CONFIG_HOME=/root/.config
export XDG_CACHE_HOME=/root/.cache
export NO_AT_BRIDGE=1
export LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1

if grep -q 'nomreh_proxy=1' /proc/cmdline; then
  if ! tinyproxy -c /etc/tinyproxy-nomreh.conf; then
    echo NOMREH_OFFICIAL_GUEST_ERROR TINYPROXY > /dev/console
    poweroff -f
    while true; do sleep 60; done
  fi
  echo NOMREH_OFFICIAL_AI_BROKER_LISTENING > /dev/console
fi

/usr/local/bin/shecan-desktop > /var/log/shecan-desktop.log 2>&1 &
APP_PID=$!
echo NOMREH_OFFICIAL_APP_PROCESS_STARTED > /dev/console
sleep 15
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo NOMREH_OFFICIAL_APP_ERROR PROCESS_EXITED > /dev/console
  if grep -q 'nomreh_probe=1' /proc/cmdline; then
    tail -40 /var/log/shecan-desktop.log > /dev/console 2>&1 || true
  fi
  poweroff -f
  while true; do sleep 60; done
fi
echo NOMREH_OFFICIAL_APP_PROCESS_ALIVE > /dev/console

if grep -q 'nomreh_probe=1' /proc/cmdline; then
  echo NOMREH_OFFICIAL_APP_BOOT_PASS > /dev/console
  # Leave enough time for the host-side real RFB framebuffer gate.
  sleep 60
  kill "$APP_PID" 2>/dev/null || true
  kill "$XVNC_PID" 2>/dev/null || true
  if [ -n "$DBUS_SESSION_BUS_PID" ]; then kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true; fi
  sync
  poweroff -f
fi

while kill -0 "$APP_PID" 2>/dev/null; do sleep 5; done
echo NOMREH_OFFICIAL_APP_PROCESS_EXITED > /dev/console
poweroff -f
while true; do sleep 60; done
