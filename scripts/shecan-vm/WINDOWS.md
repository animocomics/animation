# Genuine Shecan Windows application over Wine

This path runs the user-supplied `shecan (2).exe` as the **Windows** application. It does not substitute the Linux RPM, recreate the login form, or patch the Shecan executable.

- Installer: `shecan (2).exe`, 19,580,936 bytes, SHA-256 `362f73e9603a49d7c323feab7f747b6c97feaad1dfc4d649df18cef0ccdc54e7`.
- Installed application: `shecan-desktop.exe` v0.2.15, SHA-256 `6b3e75c103a4db93bbd26b81c09e065ce0a13bb792ce0fa97daa2d59464284db`.
- Runtime: Wine 9.22, WebView2 133.0.3065.92 and Mesa WGL 26.1.8. The genuine WebView2 executable remains unchanged.
- `native/webview2-shim.c` only supplies browser arguments that Wails' read-only options object cannot set, and enables a loopback DevTools endpoint. It forwards environment creation to the genuine `EmbeddedBrowserWebView-real.dll`.
- `native/winbrand.c` supplies Wine's missing `BrandingFormatString`; its source is based on Wine's LGPL winbrand implementation.

## Live, interactive display

`live-preview.mjs` serves the real WebView2 pixels through CDP screencast and forwards validated mouse/keyboard input to that same Windows process. The page contains a canvas, **not an HTML recreation of Shecan**. CDP remains on `127.0.0.1:9222`; the viewer accepts no arbitrary JavaScript evaluation requests and never logs typed text.

Use `SHECAN_PREVIEW_HOST=127.0.0.1` behind Nomreh's authenticated admin proxy. A public `0.0.0.0` bind is only for the isolated Arena live preview.

`windows-supervisor.mjs` owns Xvfb, Wine and the viewer. It checks actual CDP/viewer readiness, restarts failed processes with bounded backoff, and writes a non-secret status file. It does not mark the application ready merely because a PID exists.

## Validation

Set `SHECAN_WINDOWS_RUNTIME_DIR` to the assembled runtime and start the supervisor:

```bash
node scripts/shecan-vm/windows-supervisor.mjs
```

Then run the non-destructive smoke check:

```bash
node scripts/shecan-vm/preview-smoke.mjs
```

The smoke check refuses to replace a non-empty username field. It clicks through the viewer, enters the reserved value `test@example.invalid`, verifies the value in the real WebView2 DOM, and clears it. `--leave` retains the value solely as visible proof of interaction.

Validated on the isolated Linux display:

1. `SHECAN_PREVIEW_SMOKE_OK form=1 filled=true cleared=false frame=true`.
2. Terminating the Wine application produced a new application PID and returned `phase=ready` with `restarts=1`; the same smoke check passed afterward.
3. The independent Windows WGL test reported OpenGL 4.6, Mesa 26.1.8, llvmpipe (LLVM 23.1.1).

## Native module rebuilds and hashes

`native/build.sh` rebuilds the small compatibility DLLs with Zig; it does not download or execute package scripts. Current binaries:

- `native/bin/EmbeddedBrowserWebView.dll`: `ce22d7df01565b4846d6a9e29dceb7b15862bf92fe71e2902567a10b573a3f0e`.
- `native/bin/winbrand.dll`: `d6d71a8f664913f6342238b511340e023209690d397b71dc518b0dfb420d318c`.

Mesa WGL came from `@gjsify/gl-runtime-win32-x64@0.64.19` (npm tarball 23,626,978 bytes, SHA-256 `b448df8e4eb46082e512ded3985997c79537f21acecfdd4209c3f2c1ac696a7d`). Its `mesa-dist-win.json` pins Mesa 26.1.8 and the included DLL hashes were verified before use.
