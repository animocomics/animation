#!/usr/bin/env python3
"""Append a local test /init overlay to an initramfs without repacking rootfs.

Only for the disposable, networkless runner diagnostic, never host deployment.
Linux initramfs permits concatenated cpio streams. The last /init wins.
"""
import importlib.util
import lzma
from pathlib import Path
import stat
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: append-init-overlay.py <initramfs> <init-script>')
source = Path(__file__).with_name('rootfs-initramfs.py')
spec = importlib.util.spec_from_file_location('rootfs_initramfs', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
archive = Path(sys.argv[1])
script = Path(sys.argv[2])
if archive.is_symlink() or not archive.is_file() or script.is_symlink() or not script.is_file():
    raise SystemExit('Expected regular files')
body = script.read_bytes()
if not body.startswith(b'#!/bin/sh\n') or len(body) > 100_000:
    raise SystemExit('Unexpected init script')
cpio = module.entry(1, 'init', stat.S_IFREG | 0o755, body) + module.entry(0, module.TRAILER, 0)
with archive.open('ab') as target:
    target.write(lzma.compress(cpio, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32))
print('Appended local diagnostic init overlay; no host files were touched.')
