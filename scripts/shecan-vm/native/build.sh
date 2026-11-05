#!/usr/bin/env bash
set -euo pipefail

# Rebuild the two small Windows compatibility modules. The genuine Shecan
# executable and WebView2 runtime are never patched by this script.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ZIG=${ZIG:-zig}
CACHE=${ZIG_GLOBAL_CACHE_DIR:-"$ROOT/.zig-cache"}
LOCAL_CACHE=${ZIG_LOCAL_CACHE_DIR:-"$ROOT/.zig-cache-local"}
mkdir -p "$ROOT/bin" "$CACHE" "$LOCAL_CACHE"
export ZIG_GLOBAL_CACHE_DIR="$CACHE" ZIG_LOCAL_CACHE_DIR="$LOCAL_CACHE"

"$ZIG" cc -shared "$ROOT/webview2-shim.c" \
  -o "$ROOT/bin/EmbeddedBrowserWebView.dll" \
  -target x86_64-windows-gnu -O2 -lole32
"$ZIG" cc -shared "$ROOT/winbrand.c" \
  -o "$ROOT/bin/winbrand.dll" \
  -target x86_64-windows-gnu -O2 -Wl,--export-all-symbols

sha256sum "$ROOT/bin/EmbeddedBrowserWebView.dll" "$ROOT/bin/winbrand.dll"
