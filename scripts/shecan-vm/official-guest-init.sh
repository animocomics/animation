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
  -SecurityTypes None -AlwaysShared $vnc_localhost \
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
echo NOMREH_OFFICIAL_XVNC_READY > /dev/console

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

REVERSE_PID=''
if grep -q 'nomreh_vnc_reverse=15500' /proc/cmdline; then
  echo NOMREH_OFFICIAL_VNC_REVERSE_REQUESTED > /dev/console
  (
    reverse_attempt=0
    while kill -0 "$XVNC_PID" 2>/dev/null; do
      reverse_attempt=$((reverse_attempt + 1))
      if [ "$reverse_attempt" -le 3 ] || [ $((reverse_attempt % 15)) -eq 0 ]; then
        echo "NOMREH_OFFICIAL_VNC_REVERSE_ATTEMPT_$reverse_attempt" > /dev/console
      fi
      : > /var/log/vnc-reverse.log
      # x11vnc scrapes the genuine X11 desktop and initiates the reverse RFB
      # connection directly. rfbport=0 prevents any additional listener.
      x11vnc -display :0 -rfbport 0 -nopw -shared \
        -no6 -noipv6 -noxdamage -connect_or_exit 10.0.2.2:15500 \
        >> /var/log/vnc-reverse.log 2>&1 &
      reverse_client_pid=$!
      reverse_tcp=0
      reverse_wait=0
      # Bound only a connection that never reaches TCP. Once established, wait
      # without a session timeout so an admin can keep the real desktop open.
      while [ "$reverse_wait" -lt 25 ] && kill -0 "$reverse_client_pid" 2>/dev/null; do
        if awk '$3 ~ /:3C8C$/ && $4 == "01" { found=1 } END { exit found ? 0 : 1 }' /proc/net/tcp; then
          reverse_tcp=1
          echo NOMREH_OFFICIAL_VNC_REVERSE_TCP_ESTABLISHED > /dev/console
          break
        fi
        sleep 1
        reverse_wait=$((reverse_wait + 1))
      done
      if [ "$reverse_tcp" -eq 1 ]; then
        wait "$reverse_client_pid"
        reverse_status=$?
      elif kill -0 "$reverse_client_pid" 2>/dev/null; then
        kill "$reverse_client_pid" 2>/dev/null || true
        sleep 1
        kill -KILL "$reverse_client_pid" 2>/dev/null || true
        wait "$reverse_client_pid" 2>/dev/null || true
        reverse_status=124
      else
        wait "$reverse_client_pid"
        reverse_status=$?
      fi
      reverse_reason=UNKNOWN
      if [ "$reverse_status" -eq 124 ]; then reverse_reason=TIMEOUT; fi
      if grep -qi 'connection refused' /var/log/vnc-reverse.log; then reverse_reason=REFUSED; fi
      if grep -qi 'timed out\|timeout' /var/log/vnc-reverse.log; then reverse_reason=TIMEOUT; fi
      if grep -qi 'not found\|no such file' /var/log/vnc-reverse.log; then reverse_reason=NOT_FOUND; fi
      if grep -qi 'permission denied' /var/log/vnc-reverse.log; then reverse_reason=PERMISSION; fi
      if grep -qi 'could not\|unable\|failed\|error' /var/log/vnc-reverse.log && [ "$reverse_reason" = UNKNOWN ]; then reverse_reason=ERROR; fi
      if [ "$reverse_status" -eq 124 ]; then echo NOMREH_OFFICIAL_VNC_REVERSE_TCP_NOT_ESTABLISHED > /dev/console; fi
      if [ "$reverse_attempt" -le 3 ] || [ $((reverse_attempt % 15)) -eq 0 ]; then
        echo "NOMREH_OFFICIAL_VNC_REVERSE_EXIT_${reverse_status}_${reverse_reason}" > /dev/console
      fi
      sleep 2
    done
    echo NOMREH_OFFICIAL_VNC_REVERSE_LOOP_EXIT > /dev/console
  ) &
  REVERSE_PID=$!
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
timeout 5s xwininfo -root -tree > /var/log/xwininfo.log 2>&1 || true
echo NOMREH_OFFICIAL_X11_INSPECTED > /dev/console

if grep -q 'nomreh_probe=1' /proc/cmdline; then
  echo NOMREH_OFFICIAL_APP_BOOT_PASS > /dev/console
  # Leave enough time for software rendering under TCG and retain only the
  # credential-free initial-process logs if the framebuffer gate needs them.
  sleep 120
  timeout 5s xwininfo -root -tree > /var/log/xwininfo.log 2>&1 || true
  echo NOMREH_OFFICIAL_PROBE_LOG_BEGIN > /dev/console
  head -100 /var/log/xwininfo.log > /dev/console 2>&1 || true
  head -120 /var/log/shecan-desktop.log > /dev/console 2>&1 || true
  head -60 /var/log/xvnc.log > /dev/console 2>&1 || true
  head -80 /var/log/vnc-reverse.log > /dev/console 2>&1 || true
  echo NOMREH_OFFICIAL_PROBE_LOG_END > /dev/console
  kill "$APP_PID" 2>/dev/null || true
  if [ -n "$REVERSE_PID" ]; then kill "$REVERSE_PID" 2>/dev/null || true; fi
  kill "$XVNC_PID" 2>/dev/null || true
  if [ -n "$DBUS_SYSTEM_BUS_PID" ]; then kill "$DBUS_SYSTEM_BUS_PID" 2>/dev/null || true; fi
  sync
  poweroff -f
fi

while kill -0 "$APP_PID" 2>/dev/null; do sleep 5; done
echo NOMREH_OFFICIAL_APP_PROCESS_EXITED > /dev/console
poweroff -f
while true; do sleep 60; done
