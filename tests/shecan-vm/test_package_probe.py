import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[2] / 'scripts/shecan-vm/package-probe.py'
spec = importlib.util.spec_from_file_location('package_probe', MODULE)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'runtime'
        for name in ['run-gui.sh', 'guest/vmlinuz-virt', 'qemu/bin/qemu-system-x86_64', 'glibc/lib/x86_64-linux-gnu/ld-2.27.so']:
            path = self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'bounded test file')
        os.utime(self.runtime / 'run-gui.sh', (0, 0))
        self.init = self.runtime / 'guest/initramfs-gui'
        self.init.write_bytes(bytes(range(251)) * 10)
        self.output = self.root / 'output'

    def tearDown(self):
        self.temp.cleanup()

    def test_parts_reassemble_and_hashes_match(self):
        manifest = package.pack(self.runtime, self.output, part_size=1000)
        self.assertEqual(json.loads((self.output / 'manifest.json').read_text()), manifest)
        self.assertEqual(len(manifest['initramfs']['parts']), 3)
        combined = bytearray()
        for part in manifest['initramfs']['parts']:
            archive_file = self.output / part['archive']
            self.assertEqual(hashlib.sha256(archive_file.read_bytes()).hexdigest(), part['archive_sha256'])
            with zipfile.ZipFile(archive_file) as archive:
                data = archive.read(f"nomreh-vm/gui/guest/{part['file']}")
            self.assertEqual(hashlib.sha256(data).hexdigest(), part['sha256'])
            combined.extend(data)
        self.assertEqual(bytes(combined), self.init.read_bytes())
        self.assertEqual(hashlib.sha256(combined).hexdigest(), manifest['initramfs']['sha256'])
        with zipfile.ZipFile(self.output / manifest['base']['archive']) as archive:
            self.assertNotIn('nomreh-vm/gui/guest/initramfs-gui', archive.namelist())
            self.assertIn('nomreh-vm/gui/run-gui.sh', archive.namelist())

    def test_refuses_nonempty_output_unexpected_entries_and_escaping_symlink(self):
        self.output.mkdir()
        (self.output / 'existing').write_text('preserve')
        with self.assertRaises(ValueError):
            package.pack(self.runtime, self.output, 1000)
        self.assertEqual((self.output / 'existing').read_text(), 'preserve')
        (self.runtime / 'unexpected').write_text('no')
        with self.assertRaises(ValueError):
            package.pack(self.runtime, self.root / 'new-output', 1000)
        (self.runtime / 'unexpected').unlink()
        (self.runtime / 'qemu/escape').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            package.pack(self.runtime, self.root / 'new-output-2', 1000)


if __name__ == '__main__':
    unittest.main()
