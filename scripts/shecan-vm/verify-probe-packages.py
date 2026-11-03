#!/usr/bin/env python3
"""Offline validation of bounded diagnostic packages; never contacts Plesk."""
import hashlib
import json
import posixpath
from pathlib import Path
import re
import stat
import sys
import zipfile

MAX_ZIP = 90 * 1024 * 1024
MAX_BASE = 150 * 1024 * 1024
PREFIX = 'nomreh-vm/gui/'


def sha_file(path):
    hasher = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def verify(directory):
    directory = Path(directory).resolve(strict=True)
    manifest_file = directory / 'manifest.json'
    if manifest_file.is_symlink() or not manifest_file.is_file():
        raise ValueError('Missing manifest')
    manifest = json.loads(manifest_file.read_text(encoding='utf8'))
    if manifest.get('format') != 'nomreh-local-gui-probe-v1':
        raise ValueError('Unexpected manifest format')
    base = manifest['base']
    parts = manifest['initramfs']['parts']
    if base['archive'] != 'nomreh-deploy-gui-probe-base.zip' or not 1 <= len(parts) <= 10:
        raise ValueError('Unexpected archive names or part count')
    entries = []
    links = set()
    base_path = directory / base['archive']
    if base_path.is_symlink() or not base_path.is_file() or base_path.stat().st_size != base['bytes'] or base['bytes'] > MAX_ZIP or sha_file(base_path) != base['sha256']:
        raise ValueError('Base archive failed verification')
    with zipfile.ZipFile(base_path) as archive:
        seen = set()
        total = 0
        for item in archive.infolist():
            name = item.filename
            if not name.startswith(PREFIX) or name.endswith('/') or name in seen or '\\' in name:
                raise ValueError('Unexpected base archive path')
            relative = name[len(PREFIX):]
            if not relative or any(segment in ('', '.', '..') for segment in relative.split('/')):
                raise ValueError('Unsafe base path')
            if relative == 'guest/initramfs-gui' or re.fullmatch(r'guest/initramfs-gui[.]part-[0-9]{3}', relative):
                raise ValueError('Base contains an initramfs or part')
            seen.add(name)
            total += item.file_size
            if total > MAX_BASE or item.file_size > MAX_BASE:
                raise ValueError('Base expands beyond its safety budget')
            mode = item.external_attr >> 16
            with archive.open(item) as contents:
                hasher = hashlib.sha256()
                data = bytearray() if stat.S_ISLNK(mode) else None
                for block in iter(lambda: contents.read(1024 * 1024), b''):
                    hasher.update(block)
                    if data is not None:
                        data.extend(block)
                        if len(data) > 4096:
                            raise ValueError('Oversized symlink target')
            if stat.S_ISLNK(mode):
                target = data.decode('utf8')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
                if target.startswith('/') or resolved == '..' or resolved.startswith('../'):
                    raise ValueError('Unsafe symlink')
                links.add(relative)
                entries.append({'path': relative, 'type': 'symlink', 'target': target})
            elif stat.S_ISREG(mode):
                entries.append({'path': relative, 'type': 'file', 'bytes': item.file_size, 'sha256': hasher.hexdigest(), 'executable': bool(mode & 0o111)})
            else:
                raise ValueError('Unexpected base file type')
        for item in entries:
            parent = posixpath.dirname(item['path'])
            while parent:
                if parent in links:
                    raise ValueError('Archive entry underneath a symlink')
                parent = posixpath.dirname(parent)
        if archive.testzip() is not None:
            raise ValueError('Base CRC check failed')
    required = {'run-gui.sh', 'guest/vmlinuz-virt', 'qemu/bin/qemu-system-x86_64', 'glibc/lib/x86_64-linux-gnu/ld-2.27.so'}
    if not required.issubset({item['path'] for item in entries if item['type'] == 'file'}):
        raise ValueError('Base runtime is incomplete')

    total_hash = hashlib.sha256()
    total_bytes = 0
    for index, part in enumerate(parts):
        zip_name = f'nomreh-deploy-gui-probe-part-{index:03}.zip'
        part_name = f'initramfs-gui.part-{index:03}'
        if part['archive'] != zip_name or part['file'] != part_name or not isinstance(part['bytes'], int) or part['bytes'] <= 0:
            raise ValueError('Unexpected part manifest')
        file = directory / zip_name
        if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_ZIP or sha_file(file) != part['archive_sha256']:
            raise ValueError('Part archive hash mismatch')
        with zipfile.ZipFile(file) as archive:
            if archive.namelist() != [f'{PREFIX}guest/{part_name}']:
                raise ValueError('Unexpected part content')
            item = archive.infolist()[0]
            if item.file_size != part['bytes'] or item.file_size > MAX_ZIP:
                raise ValueError('Unexpected part size')
            hasher = hashlib.sha256()
            with archive.open(item) as contents:
                for block in iter(lambda: contents.read(1024 * 1024), b''):
                    hasher.update(block)
                    total_hash.update(block)
                    total_bytes += len(block)
            if hasher.hexdigest() != part['sha256']:
                raise ValueError('Part payload hash mismatch')
        part['archive_bytes'] = file.stat().st_size
    if total_bytes != manifest['initramfs']['bytes'] or total_hash.hexdigest() != manifest['initramfs']['sha256']:
        raise ValueError('Combined initramfs failed verification')
    base['uncompressed_bytes'] = total
    base['files'] = entries
    return manifest


def main():
    if len(sys.argv) != 3:
        raise SystemExit('usage: verify-probe-packages.py <package-dir> <host-manifest-output>')
    result = verify(sys.argv[1])
    output = Path(sys.argv[2])
    if output.exists() or output.is_symlink():
        raise ValueError('Refusing to overwrite manifest')
    output.write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf8')
    print('Offline verification passed: archive paths, sizes, hashes, symlinks and complete initramfs.')
    print(f"Base payload bytes: {result['base']['uncompressed_bytes']}; entries: {len(result['base']['files'])}; parts: {len(result['initramfs']['parts'])}.")
    print('No Plesk files were accessed or changed.')


if __name__ == '__main__':
    main()
