import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.SHECAN_WINDOWS_RUNTIME_DIR || path.join(process.cwd(), 'nomreh-vm', 'windows'));
const xkbSource = path.resolve(process.env.SHECAN_XKB_COMP_SOURCE || path.join(root, 'xkb-build', 'bin', 'xkbcomp'));
const xkbLibrarySource = path.resolve(process.env.SHECAN_XKB_LIB_SOURCE || path.join(path.dirname(xkbSource), '..', 'lib', 'libxkbfile.so.1'));
const xvfbRelative = 'x-server-aws/package/lib/aws-2/poppler-0.26-xvfb/bin/Xvfb';
const requiredFiles = [
  'wine-src/wine/bin/wine64',
  'wine-src/wine/lib/wine/x86_64-windows/ws2_32.dll',
  'windows-ai/bun.exe',
  'x-server-aws/package/lib/aws-2/poppler-0.26-xvfb/bin/Xvfb',
  'xkb/bin/xkbcomp',
  'xkb/lib/libxkbfile.so.1',
  'prefix/drive_c/Program Files/shecan/shecan-desktop/shecan-desktop.exe',
  'prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/msedgewebview2.exe',
  'prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/EBWebView/x64/EmbeddedBrowserWebView.dll',
  'prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/EBWebView/x64/EmbeddedBrowserWebView-real.dll',
  'prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/opengl32.dll',
  'prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/libgallium_wgl.dll',
];

function regularFile(target) {
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe runtime file: ${target}`);
}

function sha256(target) {
  const descriptor = fs.openSync(target, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

const rootInfo = fs.lstatSync(root);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Unsafe Windows runtime root');
for (const target of [xkbSource, xkbLibrarySource, path.join(root, xvfbRelative)]) regularFile(target);
fs.mkdirSync(path.join(root, 'xkb', 'bin'), { recursive: true });
fs.mkdirSync(path.join(root, 'xkb', 'lib'), { recursive: true });
for (const [source, relative] of [[xkbSource, 'xkb/bin/xkbcomp'], [xkbLibrarySource, 'xkb/lib/libxkbfile.so.1']]) {
  const target = path.join(root, relative);
  if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
  fs.chmodSync(target, relative.endsWith('xkbcomp') ? 0o755 : 0o644);
  regularFile(target);
}

const xvfbPath = path.join(root, xvfbRelative);
const original = Buffer.from('/usr/bin\0');
const replacement = Buffer.from('xkb/bin\0\0');
const binary = fs.readFileSync(xvfbPath);
const originalOffset = binary.indexOf(original);
const patchedOffset = binary.indexOf(Buffer.from('xkb/bin\0'));
if (originalOffset >= 0) {
  if (originalOffset !== binary.lastIndexOf(original) || patchedOffset >= 0 || replacement.length !== original.length) {
    throw new Error('Xvfb XKB path patch is ambiguous');
  }
  const backup = `${xvfbPath}-upstream`;
  if (!fs.existsSync(backup)) fs.copyFileSync(xvfbPath, backup);
  binary.fill(0, originalOffset, originalOffset + original.length);
  replacement.copy(binary, originalOffset);
  const temporary = `${xvfbPath}.tmp`;
  fs.writeFileSync(temporary, binary, { mode: fs.statSync(xvfbPath).mode });
  fs.renameSync(temporary, xvfbPath);
} else if (patchedOffset < 0) {
  throw new Error('Xvfb XKB path was not found');
}

const manifest = {
  format: 2,
  windowsInstallerSha256: '362f73e9603a49d7c323feab7f747b6c97feaad1dfc4d649df18cef0ccdc54e7',
  files: Object.fromEntries(requiredFiles.map((relative) => {
    const target = path.join(root, relative);
    regularFile(target);
    return [relative, sha256(target)];
  })),
};
const manifestPath = path.join(root, 'runtime-manifest.json');
const temporaryManifest = `${manifestPath}.tmp`;
fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
fs.renameSync(temporaryManifest, manifestPath);
console.log(`WINDOWS_RUNTIME_FINALIZED files=${requiredFiles.length} xvfb=xkb/bin sha256=${sha256(xvfbPath)}`);
