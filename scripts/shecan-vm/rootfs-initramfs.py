#!/usr/bin/env python3
"""Pack an Alpine rootfs and a scoped /init as a reproducible gzip initramfs."""

import gzip
import os
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
    if len(sys.argv) != 4:
        raise SystemExit("usage: rootfs-initramfs.py <rootfs> <init> <output>")
    rootfs, init_path, output_path = sys.argv[1:]
    rootfs = os.path.abspath(rootfs)
    entries = []

    def add(path, relative):
        info = os.lstat(path)
        mode = stat.S_IFMT(info.st_mode) | (info.st_mode & 0o7777)
        if relative in {"init", "dev"} or relative.startswith("dev/"):
            return
        if stat.S_ISLNK(info.st_mode):
            entries.append((relative, mode, os.readlink(path).encode(), (0, 0)))
            return
        if stat.S_ISDIR(info.st_mode):
            entries.append((relative, mode, b"", (0, 0)))
            if relative not in {"proc", "sys", "dev"}:
                for child in sorted(os.listdir(path)):
                    add(os.path.join(path, child), f"{relative}/{child}")
            return
        if stat.S_ISREG(info.st_mode):
            with open(path, "rb") as source:
                entries.append((relative, mode, source.read(), (0, 0)))

    for name in sorted(os.listdir(rootfs)):
        add(os.path.join(rootfs, name), name)
    with open(init_path, "rb") as source:
        init_body = source.read()
    entries.extend([
        ("dev", stat.S_IFDIR | 0o755, b"", (0, 0)),
        ("dev/console", stat.S_IFCHR | 0o600, b"", (5, 1)),
        ("init", stat.S_IFREG | 0o755, init_body, (0, 0)),
    ])
    archive = b"".join(entry(index + 1, *item) for index, item in enumerate(entries))
    archive += entry(0, TRAILER, 0)
    with open(output_path, "wb") as output:
        output.write(gzip.compress(archive, compresslevel=9, mtime=0))
    print(f"initramfs entries={len(entries) + 1} uncompressed_bytes={len(archive)} compressed_bytes={os.path.getsize(output_path)}")


if __name__ == "__main__":
    main()
