# Genuine Shecan Windows application over Wine

This path runs the user-supplied `shecan (2).exe` as the **Windows** application. It does not substitute the Linux RPM, recreate the login form, or patch the Shecan executable.

- Installer: `shecan (2).exe`, 19,580,936 bytes, SHA-256 `362f73e9603a49d7c323feab7f747b6c97feaad1dfc4d649df18cef0ccdc54e7`.
- Installed application: `shecan-desktop.exe` v0.2.15, SHA-256 `6b3e75c103a4db93bbd26b81c09e065ce0a13bb792ce0fa97daa2d59464284db`.
- Runtime: Wine 9.22, WebView2 133.0.3065.92 and Mesa WGL 26.1.8. The genuine WebView2 executable remains unchanged.
- `native/webview2-shim.c` only supplies browser arguments that Wails' read-only options object cannot set, and enables a loopback DevTools endpoint. It forwards environment creation to the genuine `EmbeddedBrowserWebView-real.dll`.
- `native/winbrand.c` supplies Wine's missing `BrandingFormatString`; its source is based on Wine's LGPL winbrand implementation.

## Live, interactive display

`live-preview.mjs` serves the real WebView2 pixels through CDP screencast and forwards validated mouse/keyboard input to that same Windows process. The page contains a canvas, **not an HTML recreation of Shecan**. CDP remains on `127.0.0.1:9222`; the viewer accepts no arbitrary JavaScript evaluation requests and never logs typed text.

Use `SHECAN_PREVIEW_HOST=127.0.0.1` behind Nomreh's authenticated admin proxy. A public `0.0.0.0` bind is only for the isolated Arena live preview. The viewer's `/frame` endpoint returns only the latest JPEG. `/input` accepts the same bounded mouse/keyboard messages over HTTP only from loopback; neither endpoint exposes CDP evaluation.

`windows-supervisor.mjs` owns Xvfb, Wine and the viewer. It checks actual CDP/viewer readiness, restarts failed processes with bounded backoff, and writes a non-secret status file. It does not mark the application ready merely because a PID exists.

## Nomreh admin integration

- `lib/server/shecan-windows-runtime.ts` verifies a format-2 manifest, including the exact installer hash and ten required runtime/application files. Readiness requires live Wine and viewer PIDs plus a fresh supervisor status.
- `components/shecan-windows-screen.tsx` draws the genuine screencast inside the existing admin console. It first uses the authenticated same-origin WebSocket `/api/admin/shecan-runtime/windows`, then falls back to polling `windows-frame` and ordered `windows-input` requests when a proxy does not forward upgrades.
- The WebSocket and HTTP paths require the same admin session and origin checks. HTTP input is limited to 4KB and a bounded client-side queue. No browser code connects to the server's loopback address.
- `next-server.cjs` and the existing runtime API select the Windows supervisor when its manifest is installed. Existing manual-link, V2Ray and provider settings remain separate.
- A visible Windows login is **not** AI activation. `brokerReady` and `activationReady` remain false until a real AI broker and activation check exist, so provider traffic cannot fail open through a display-only runtime.

## Portable runtime finalization

`finalize-windows-runtime.mjs` copies the small `xkbcomp`/`libxkbfile` pair into `xkb/` and changes only the Xvfb helper path from `/usr/bin` to the runtime-relative `xkb/bin`. It preserves the upstream Xvfb beside the patched binary and writes the ten-file hash manifest. This avoids any root account, system-wide symlink, or host XKB installation on the production host.

During runtime assembly, provide the already-built xkbcomp and run:

```bash
SHECAN_XKB_COMP_SOURCE=/path/to/xkbcomp node scripts/shecan-vm/finalize-windows-runtime.mjs
```

The current patched Xvfb SHA-256 is `bfbf982aa7436ae4fcf49964be261ef7fcecd68874ed88849263670bdee16233`. Finalization is idempotent and refuses an ambiguous binary patch.

## Validation

Set `SHECAN_WINDOWS_RUNTIME_DIR` to the assembled runtime and start the supervisor:

```bash
node scripts/shecan-vm/windows-supervisor.mjs
```

Then run the non-destructive smoke check:

```bash
node scripts/shecan-vm/preview-smoke.mjs
```

The smoke check refuses to replace an unrelated non-empty username field. It clicks through the viewer, enters the reserved value `test@example.invalid`, verifies the value in the real WebView2 DOM, and clears it. If a previous `--leave` run retained that reserved value, the next run clears it before typing, making repeated runs safe. `--leave` retains the value solely as visible proof of interaction.

For an authenticated end-to-end admin check, start the custom Next server against a separate temporary `NOMREH_DATA_DIR`, then run:

```bash
NOMREH_DATA_DIR=/path/to/temporary-data NOMREH_WINDOWS_ADMIN_ORIGIN=http://127.0.0.1:3000 npx tsx scripts/shecan-vm/admin-windows-smoke.ts
```

That check creates and deletes a temporary admin session without printing it, verifies `/admin` and the runtime API, rejects anonymous access, and exercises both WebSocket and HTTP frame/input paths against the genuine WebView2 form.

Validated on the isolated Linux display:

1. Two consecutive retained-value runs reported `SHECAN_PREVIEW_SMOKE_OK form=1 filled=true cleared=false frame=true`.
2. Terminating the Wine application produced a new application PID and returned `phase=ready` with `restarts=1`; the same smoke check passed afterward.
3. Restarting only the viewer produced a new viewer PID while preserving the application PID; `/healthz` and `/frame` returned healthy again.
4. The authenticated admin check reported `SHECAN_ADMIN_WINDOWS_SMOKE_OK form=1 filled=true websocket=true http=true authorized=true anonymous_rejected=true`.
5. After temporary downloads/build directories were removed, cold start and a deliberate application restart both returned to ready and two consecutive smoke checks passed. The remaining runtime measured 2,078,273,581 bytes; no `/usr/bin/xkbcomp` dependency is used.
6. The independent Windows WGL test reported OpenGL 4.6, Mesa 26.1.8, llvmpipe (LLVM 23.1.1).

## Native module rebuilds and hashes

`native/build.sh` rebuilds the small compatibility DLLs with Zig; it does not download or execute package scripts. Current binaries:

- `native/bin/EmbeddedBrowserWebView.dll`: `ce22d7df01565b4846d6a9e29dceb7b15862bf92fe71e2902567a10b573a3f0e`.
- `native/bin/winbrand.dll`: `d6d71a8f664913f6342238b511340e023209690d397b71dc518b0dfb420d318c`.

Mesa WGL came from `@gjsify/gl-runtime-win32-x64@0.64.19` (npm tarball 23,626,978 bytes, SHA-256 `b448df8e4eb46082e512ded3985997c79537f21acecfdd4209c3f2c1ac696a7d`). Its `mesa-dist-win.json` pins Mesa 26.1.8 and the included DLL hashes were verified before use.
