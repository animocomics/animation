#!/usr/bin/env python3
"""Build a tiny newc initramfs containing only the harmless static probe.

The newc writer is adapted from takumin/qemu-bin's MIT-licensed test helper.
No network modules, disks, accounts, Shecan binaries, or credentials are added.
"""

import gzip
import stat
import sys

TRAILER = "TRAILER!!!"


def entry(inode, name, mode, body=b"", device=(0, 0)):
    encoded = name.encode() + b"\0"
    fields = [inode, mode, 0, 0, 1, 0, len(body), 0, 0, device[0], device[1], len(encoded), 0]
    header = b"070701" + b"".join(b"%08x" % field for field in fields)
    result = header + encoded
    result += b"\0" * (-len(result) % 4)
    result += body
    result += b"\0" * (-len(result) % 4)
    return result


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: initramfs.py <static-init> <output>")
    with open(sys.argv[1], "rb") as source:
        init = source.read()
    entries = [
        ("dev", stat.S_IFDIR | 0o755, b"", (0, 0)),
        ("dev/console", stat.S_IFCHR | 0o600, b"", (5, 1)),
        ("proc", stat.S_IFDIR | 0o755, b"", (0, 0)),
        ("sys", stat.S_IFDIR | 0o755, b"", (0, 0)),
        ("init", stat.S_IFREG | 0o755, init, (0, 0)),
    ]
    archive = b"".join(entry(index + 1, *item) for index, item in enumerate(entries))
    archive += entry(0, TRAILER, 0)
    with open(sys.argv[2], "wb") as output:
        output.write(gzip.compress(archive, compresslevel=9, mtime=0))


if __name__ == "__main__":
    main()
