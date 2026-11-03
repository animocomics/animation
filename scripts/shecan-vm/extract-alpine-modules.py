#!/usr/bin/env python3
"""Extract only named uncompressed .ko files from Alpine's netboot initramfs.

The newc reader is adapted from takumin/qemu-bin's MIT-licensed test helper.
"""

import gzip
import os
import stat
import sys

TRAILER = "TRAILER!!!"


def read_cpio(data):
    offset = 0
    while True:
        header = data[offset:offset + 110]
        if header[:6] != b"070701":
            raise ValueError(f"bad cpio magic at {offset}")
        fields = [int(header[6 + index * 8:14 + index * 8], 16) for index in range(13)]
        mode, size, namesize = fields[1], fields[6], fields[11]
        name = data[offset + 110:offset + 110 + namesize - 1].decode()
        offset = (offset + 110 + namesize + 3) & ~3
        body = data[offset:offset + size]
        offset = (offset + size + 3) & ~3
        if name == TRAILER:
            return
        yield name, mode, body


def main():
    if len(sys.argv) < 4:
        raise SystemExit("usage: extract-alpine-modules.py <alpine-initramfs> <rootfs> <module>...")
    alpine, rootfs, *modules = sys.argv[1:]
    rootfs = os.path.abspath(rootfs)
    destination = os.path.join(rootfs, "lib", "modules")
    os.makedirs(destination, exist_ok=True)
    found = {}
    with gzip.open(alpine, "rb") as source:
        for name, mode, body in read_cpio(source.read()):
            base = name.rsplit("/", 1)[-1]
            if stat.S_ISREG(mode) and base.endswith(".ko") and base[:-3] in modules:
                found[base[:-3]] = body
    missing = sorted(set(modules) - set(found))
    if missing:
        raise SystemExit(f"modules not found in {alpine}: {' '.join(missing)}")
    for module in modules:
        path = os.path.join(destination, f"{module}.ko")
        with open(path, "wb") as output:
            output.write(found[module])
        os.chmod(path, 0o644)
        print(f"module={module} bytes={len(found[module])}")


if __name__ == "__main__":
    main()
