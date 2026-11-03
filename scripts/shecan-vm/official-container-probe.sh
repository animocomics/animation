#!/bin/sh
# Runs only inside the disposable, networkless Docker diagnostic container.
set -u
export DISPLAY=:99 HOME=/tmp/home NO_AT_BRIDGE=1 LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
mkdir -p "$HOME" /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
Xvfb :99 -screen 0 1100x760x24 -nolisten tcp > /tmp/xvfb.log 2>&1 &
xvfb=$!
ready=0
for n in $(seq 1 50); do
  if [ -S /tmp/.X11-unix/X99 ]; then ready=1; break; fi
  if ! kill -0 "$xvfb" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then echo NOMREH_GLIBC_PROBE_ERROR xvfb; exit 1; fi
/usr/local/bin/shecan-desktop >/tmp/official.log 2>&1 &
app=$!
found=0
for n in $(seq 1 60); do
  if ! kill -0 "$app" 2>/dev/null; then break; fi
  if xwininfo -root -tree 2>/dev/null | grep -i '"[^\"]*shecan[^\"]*"' >/dev/null; then found=1; break; fi
  sleep 1
done
if [ "$found" -eq 1 ]; then
  echo NOMREH_GLIBC_PROBE_WINDOW_OBSERVED yes
  echo NOMREH_GLIBC_PROBE_NO_NETWORK yes
  echo NOMREH_GLIBC_PROBE_NO_CREDENTIALS yes
  echo NOMREH_GLIBC_PROBE_PASS
  status=0
else
  echo NOMREH_GLIBC_PROBE_ERROR no_matching_window
  if kill -0 "$app" 2>/dev/null; then
    echo NOMREH_GLIBC_PROBE_PROCESS alive
  else
    wait "$app"; echo "NOMREH_GLIBC_PROBE_PROCESS_EXIT $?"
  fi
  for pair in \
    'dynamic_linker:Error loading shared library|Error relocating|symbol not found|undefined symbol|GLIBC_' \
    'missing_file:not found|No such file or directory|cannot open' \
    'display:cannot open display|no display|failed to open display|XOpenDisplay' \
    'gtk:GTK|GDK|WebKit' 'dbus:dbus|D-Bus' \
    'permissions:permission denied|not permitted|must be root|superuser' \
    'panic:panic|fatal|segmentation fault' 'configuration:config|settings|home directory' \
    'generic_error:error|failed|exception'; do
    label=${pair%%:*}; expression=${pair#*:}
    if grep -qiE "$expression" /tmp/official.log; then echo "NOMREH_GLIBC_PROBE_DIAGNOSTIC $label"; fi
  done
  if [ -s /tmp/official.log ]; then echo NOMREH_GLIBC_PROBE_LOG nonempty; else echo NOMREH_GLIBC_PROBE_LOG empty; fi
  status=1
fi
kill "$app" "$xvfb" 2>/dev/null || true
exit "$status"
