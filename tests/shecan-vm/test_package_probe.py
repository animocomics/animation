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
verify_spec = importlib.util.spec_from_file_location('verify_probe', MODULE.with_name('verify-probe-packages.py'))
validator = importlib.util.module_from_spec(verify_spec)
verify_spec.loader.exec_module(validator)


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

    def test_rejects_oversized_expanded_base(self):
        original = package.MAX_BASE_EXPANDED
        try:
            package.MAX_BASE_EXPANDED = 10
            with self.assertRaisesRegex(ValueError, 'Base archive expands'):
                package.pack(self.runtime, self.output, part_size=1000)
        finally:
            package.MAX_BASE_EXPANDED = original

    def test_independent_validator_detects_tampering(self):
        package.pack(self.runtime, self.output, part_size=1000)
        verified = validator.verify(self.output)
        self.assertEqual(verified['initramfs']['sha256'], hashlib.sha256(self.init.read_bytes()).hexdigest())
        self.assertEqual(len(verified['base']['files']), 4)
        part = self.output / verified['initramfs']['parts'][0]['archive']
        with part.open('ab') as out:
            out.write(b'tamper')
        with self.assertRaises(ValueError):
            validator.verify(self.output)

    def test_independent_validator_rejects_traversal_even_with_matching_hash(self):
        package.pack(self.runtime, self.output, part_size=1000)
        manifest_path = self.output / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        base = self.output / manifest['base']['archive']
        with zipfile.ZipFile(base, 'a') as archive:
            archive.writestr('nomreh-vm/gui/../../outside', b'unsafe')
        manifest['base']['bytes'] = base.stat().st_size
        manifest['base']['sha256'] = hashlib.sha256(base.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            validator.verify(self.output)

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
