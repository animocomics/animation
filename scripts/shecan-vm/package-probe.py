#!/usr/bin/env python3
"""Create size-bounded, hash-verifiable *local diagnostic* VM packages.

This tool does not upload, extract on a host, start a VM, or remove source data.
The compressed initramfs is split without decompressing it. A future host
installer must independently recheck subscription quota and every hash before
assembly; these packages are not permission to deploy.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import zipfile

MAX_ARCHIVE = 90 * 1024 * 1024
DEFAULT_PART = 75 * 1024 * 1024
PREFIX = 'nomreh-vm/gui'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(file):
    hasher = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def pack(runtime, destination, part_size=DEFAULT_PART):
    runtime = Path(runtime).resolve(strict=True)
    destination = Path(destination)
    if destination.exists() and (destination.is_symlink() or not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('Destination must be a new or empty directory')
    if runtime == destination.resolve() or runtime in destination.resolve().parents:
        raise ValueError('Destination must be outside the runtime')
    if not 1 <= part_size <= 85 * 1024 * 1024:
        raise ValueError('Unsafe part size')
    source = runtime / 'guest' / 'initramfs-gui'
    if source.is_symlink() or not source.is_file() or not source.resolve(strict=True).is_relative_to(runtime):
        raise ValueError('Expected regular initramfs file')
    required = ['run-gui.sh', 'guest/vmlinuz-virt', 'qemu/bin/qemu-system-x86_64', 'glibc/lib/x86_64-linux-gnu/ld-2.27.so']
    for name in required:
        if not (runtime / name).is_file() or not (runtime / name).resolve(strict=True).is_relative_to(runtime):
            raise ValueError('Incomplete runtime')
    allowed_roots = {'run-gui.sh', 'guest', 'qemu', 'glibc', 'THIRD_PARTY.md'}
    if any(item.name not in allowed_roots for item in runtime.iterdir()):
        raise ValueError('Unexpected runtime entry')
    destination.mkdir(parents=True, exist_ok=True)

    base = destination / 'nomreh-deploy-gui-probe-base.zip'
    with zipfile.ZipFile(base, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True, strict_timestamps=False) as archive:
        for entry in sorted(runtime.rglob('*')):
            if entry == source or entry.is_dir() and not entry.is_symlink():
                continue
            name = f'{PREFIX}/{entry.relative_to(runtime).as_posix()}'
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(entry)
                if os.path.isabs(target) or not entry.resolve(strict=True).is_relative_to(runtime):
                    raise ValueError('Unsafe runtime symlink')
                zip_info = zipfile.ZipInfo(name)
                zip_info.create_system = 3
                zip_info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(zip_info, target)
            elif stat.S_ISREG(info.st_mode):
                archive.write(entry, name)
            else:
                raise ValueError('Unexpected runtime file type')
    if base.stat().st_size > MAX_ARCHIVE:
        raise ValueError('Base archive exceeds the upload limit')
    with zipfile.ZipFile(base) as archive:
        if archive.testzip() is not None:
            raise ValueError('Base archive verification failed')

    parts = []
    total_hash = hashlib.sha256()
    with source.open('rb') as stream:
        for index in range(1000):
            data = stream.read(part_size)
            if not data:
                break
            total_hash.update(data)
            part_name = f'initramfs-gui.part-{index:03}'
            zip_name = f'nomreh-deploy-gui-probe-part-{index:03}.zip'
            target = destination / zip_name
            with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_STORED) as archive:
                archive.writestr(f'{PREFIX}/guest/{part_name}', data)
            if target.stat().st_size > MAX_ARCHIVE:
                raise ValueError('Part archive exceeds the upload limit')
            with zipfile.ZipFile(target) as archive:
                content = archive.read(f'{PREFIX}/guest/{part_name}')
                if digest(content) != digest(data):
                    raise ValueError('Part archive verification failed')
            parts.append({'archive': zip_name, 'archive_sha256': file_hash(target), 'file': part_name, 'bytes': len(data), 'sha256': digest(data)})
        else:
            raise ValueError('Too many parts')
    if not parts:
        raise ValueError('Empty initramfs')
    if sum(part['bytes'] for part in parts) != source.stat().st_size or total_hash.hexdigest() != file_hash(source):
        raise ValueError('Initramfs changed during packaging')
    manifest = {
        'format': 'nomreh-local-gui-probe-v1',
        'base': {'archive': base.name, 'bytes': base.stat().st_size, 'sha256': file_hash(base)},
        'initramfs': {'bytes': source.stat().st_size, 'sha256': total_hash.hexdigest(), 'parts': parts},
    }
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runtime')
    parser.add_argument('destination')
    args = parser.parse_args()
    manifest = pack(args.runtime, args.destination)
    print('Local packaging only; nothing was uploaded or deployed.')
    print('Base archive bytes:', manifest['base']['bytes'])
    print('Initramfs bytes:', manifest['initramfs']['bytes'])
    print('Part archives:', len(manifest['initramfs']['parts']))
    print('All archive SHA-256 values are recorded in manifest.json.')


if __name__ == '__main__':
    main()
