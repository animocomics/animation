#!/bin/sh
# Disposable networkless guest: inspect only whether the official desktop
# starts and creates an X11 window. No credentials or persistent disk.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
mkdir -p /proc /sys /dev
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mkdir -p /dev/pts /dev/shm /tmp /run /var/log /root
mount -t devpts devpts /dev/pts 2>/dev/null || true
mount -t tmpfs tmpfs /dev/shm 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp /tmp/.X11-unix /dev/shm
mkdir -p /tmp/home
chown 65534:65534 /tmp/home
export HOME=/tmp/home DISPLAY=:0 NO_AT_BRIDGE=1 LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
# This test has no NIC or persistent disk; QEMU is the isolation boundary.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

echo NOMREH_OFFICIAL_PROBE_BEGIN > /dev/console
/usr/local/bin/Xvnc :0 -geometry 1100x760 -depth 24 -SecurityTypes None -localhost -NeverShared > /var/log/xvnc.log 2>&1 &
xvnc=$!
ready=0
for n in $(seq 1 100); do
  if [ -S /tmp/.X11-unix/X0 ]; then ready=1; break; fi
  if ! kill -0 "$xvnc" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$ready" -eq 1 ]; then
  su -m -s /bin/sh nobody -c /usr/local/bin/shecan-desktop > /var/log/shecan.log 2>&1 &
  app=$!
  found=0
  for n in $(seq 1 90); do
    if ! kill -0 "$app" 2>/dev/null; then break; fi
    # Require an actual window created on the X server, not just process launch.
    if xwininfo -root -tree 2>/dev/null | grep -i '"[^\"]*shecan[^\"]*"' >/dev/null; then found=1; break; fi
    sleep 1
done
  if [ "$found" -eq 1 ]; then
    echo NOMREH_OFFICIAL_PROBE_WINDOW_OBSERVED yes > /dev/console
    echo NOMREH_OFFICIAL_PROBE_NO_NETWORK yes > /dev/console
    echo NOMREH_OFFICIAL_PROBE_NO_CREDENTIALS yes > /dev/console
    echo NOMREH_OFFICIAL_PROBE_PASS > /dev/console
  else
    echo NOMREH_OFFICIAL_PROBE_ERROR no_matching_window > /dev/console
    if kill -0 "$app" 2>/dev/null; then
      echo NOMREH_OFFICIAL_PROBE_PROCESS alive > /dev/console
    else
      wait "$app"; echo "NOMREH_OFFICIAL_PROBE_PROCESS_EXIT $?" > /dev/console
    fi
    # Error output may include URLs or other private material. Report only
    # a fixed diagnostic classification, never raw application output.
    for pair in \
      'dynamic_linker:Error loading shared library|Error relocating|symbol not found|undefined symbol|GLIBC_' \
      'missing_file:not found|No such file or directory|cannot open' \
      'display:cannot open display|no display|failed to open display|XOpenDisplay' \
      'gtk:GTK|GDK|WebKit' \
      'dbus:dbus|D-Bus' \
      'permissions:permission denied|not permitted|must be root|superuser' \
      'panic:panic|fatal|segmentation fault' \
      'configuration:config|settings|home directory' \
      'generic_error:error|failed|exception'; do
      label=${pair%%:*}; expression=${pair#*:}
      if grep -qiE "$expression" /var/log/shecan.log; then
        echo "NOMREH_OFFICIAL_PROBE_DIAGNOSTIC $label" > /dev/console
      fi
    done
    if [ -e /lib64/ld-linux-x86-64.so.2 ]; then
      echo NOMREH_OFFICIAL_PROBE_GLIBC_LOADER present > /dev/console
    else
      echo NOMREH_OFFICIAL_PROBE_GLIBC_LOADER missing > /dev/console
    fi
    if [ -s /var/log/shecan.log ]; then
      echo NOMREH_OFFICIAL_PROBE_LOG nonempty > /dev/console
    else
      echo NOMREH_OFFICIAL_PROBE_LOG empty > /dev/console
    fi
  fi
  kill "$app" 2>/dev/null || true
else
  echo NOMREH_OFFICIAL_PROBE_ERROR xvnc > /dev/console
fi
kill "$xvnc" 2>/dev/null || true
sync
poweroff -f
while true; do sleep 60; done
