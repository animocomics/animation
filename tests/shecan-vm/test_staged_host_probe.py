import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
module = ROOT / 'scripts/shecan-vm/package-probe.py'
spec = importlib.util.spec_from_file_location('staged_package_probe', module)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
spec = importlib.util.spec_from_file_location('staged_verify_probe', module.with_name('verify-probe-packages.py'))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class StagedHostProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = self.root / 'vhosts/subscription/nomreh.arounidea.com'
        self.app.mkdir(parents=True)
        self.runtime = self.root / 'runtime'
        for name in ['run-gui.sh', 'guest/vmlinuz-virt', 'qemu/bin/qemu-system-x86_64', 'glibc/lib/x86_64-linux-gnu/ld-2.27.so']:
            p = self.runtime / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'bounded test file')
            if name == 'run-gui.sh': p.chmod(0o755)
        (self.runtime / 'qemu/lib').mkdir(parents=True)
        (self.runtime / 'qemu/lib/example').symlink_to('../bin/qemu-system-x86_64')
        self.init = self.runtime / 'guest/initramfs-gui'
        self.init.write_bytes(bytes(range(251)) * 10)
        self.output = self.root / 'packages'
        package.pack(self.runtime, self.output, part_size=1000)
        self.manifest = validator.verify(self.output)
        self.manifest_path = self.root / 'verified.json'
        self.manifest_path.write_text(json.dumps(self.manifest))

    def tearDown(self): self.temp.cleanup()

    def stage(self, phase, high=False):
        code = """const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[2]));
try{const run=require(process.argv[1]);const result=run.installStage(m,process.argv[3],process.argv[4],process.argv[5]==='high'?()=>4*1024*1024*1024:undefined);console.log(JSON.stringify(result));}catch(e){console.error(e.message);process.exit(1)}"""
        return subprocess.run(['node', '-e', code, str(ROOT / 'scripts/shecan-vm/staged-host-probe.cjs'), str(self.manifest_path), phase, str(self.app), 'high' if high else 'normal'], text=True, capture_output=True)

    def upload(self, name): shutil.copy2(self.output / name, self.app / name)

    def test_full_staged_flow_and_verified_cleanup(self):
        b, parts = self.manifest['base'], self.manifest['initramfs']['parts']
        self.assertEqual(self.stage('preflight-base-upload').returncode, 0)
        self.upload(b['archive'])
        result = self.stage('extract-base')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.app / b['archive']).exists())
        for index, part in enumerate(parts):
            self.assertEqual(self.stage(f'preflight-part-upload-{index:03}').returncode, 0)
            self.upload(part['archive'])
            result = self.stage(f'extract-part-{index:03}')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((self.app / part['archive']).exists())
        result = self.stage('assemble')
        self.assertEqual(result.returncode, 0, result.stderr)
        guest = self.app / 'nomreh-vm/gui/guest'
        self.assertEqual((guest / 'initramfs-gui').read_bytes(), self.init.read_bytes())
        self.assertFalse(list(guest.glob('initramfs-gui.part-*')))
        self.assertNotEqual(self.stage('assemble').returncode, 0)

    def test_encoded_console_command_runs_and_fails_closed(self):
        helper = ROOT / 'scripts/shecan-vm/build-host-stage-command.cjs'
        js = "const x=require(process.argv[1]),fs=require('fs');console.log(JSON.stringify(x.buildHostStageCommand(process.argv[2],JSON.parse(fs.readFileSync(process.argv[3])),'0123456789abcdef01234567')))"
        def command(phase):
            result = subprocess.run(['node', '-e', js, str(helper), phase, str(self.manifest_path)], text=True, capture_output=True, check=True)
            return json.loads(result.stdout)
        built = command('preflight-base-upload')
        result = subprocess.run(built['command'].removeprefix('exec -- '), cwd=self.app, shell=True, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(built['prefix'] + '_PASS ', result.stdout)
        result = subprocess.run(command('extract-base')['command'].removeprefix('exec -- '), cwd=self.app, shell=True, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(built['prefix'] + '_FAIL ', result.stdout)
        self.assertFalse((self.app / 'nomreh-vm').exists())

    def test_quota_hash_and_existing_targets_fail_closed(self):
        b = self.manifest['base']
        self.assertIn('QUOTA_HEADROOM_INSUFFICIENT', self.stage('preflight-base-upload', high=True).stderr)
        self.upload(b['archive'])
        with (self.app / b['archive']).open('ab') as f: f.write(b'tampered')
        self.assertNotEqual(self.stage('extract-base').returncode, 0)
        self.assertTrue((self.app / b['archive']).exists())
        self.assertFalse((self.app / 'nomreh-vm').exists())
        (self.app / b['archive']).unlink()
        (self.app / 'nomreh-vm').mkdir()
        (self.app / 'nomreh-vm/gui').symlink_to(self.root / 'missing')
        self.assertNotEqual(self.stage('preflight-base-upload').returncode, 0)


if __name__ == '__main__': unittest.main()
