import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function measuredKiB(target: string): number {
  const result = spawnSync("du", ["-sk", "--", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim().split(/\s+/, 1)[0]);
}

test("Plesk disk report totals every domain in only the current subscription and shows the 4 GiB budget", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "nomreh-subscription-space-"));
  try {
    const vhosts = path.join(temporary, "vhosts");
    const subscription = path.join(vhosts, "example.test");
    const app = path.join(subscription, "nomreh.example.test");
    mkdirSync(path.join(app, "scripts"), { recursive: true });
    mkdirSync(path.join(subscription, "other.example.test"), { recursive: true });
    mkdirSync(path.join(subscription, "nomreh-data"), { recursive: true });
    mkdirSync(path.join(vhosts, "unrelated-customer.test"), { recursive: true });
    writeFileSync(path.join(app, "app.bin"), Buffer.alloc(2048, 1));
    writeFileSync(path.join(subscription, "other.example.test", "site.bin"), Buffer.alloc(4096, 2));
    writeFileSync(path.join(subscription, "nomreh-data", "data.bin"), Buffer.alloc(1024, 3));
    writeFileSync(path.join(vhosts, "unrelated-customer.test", "excluded.bin"), Buffer.alloc(131072, 4));
    const script = path.join(app, "scripts", "plesk-space.cjs");
    copyFileSync(path.resolve(__dirname, "../scripts/plesk-space.cjs"), script);
    const result = spawnSync(process.execPath, [script], { cwd: app, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const match = result.stdout.match(/All domains in current subscription total:\s+([0-9.]+) MiB/);
    assert.ok(match, result.stdout);
    assert.equal(Number(match[1]), Number((measuredKiB(subscription) / 1024).toFixed(1)));
    assert.match(result.stdout, /4 GiB current-subscription budget remaining:/);
    assert.doesNotMatch(result.stdout, /budget EXCEEDED/);
    assert.match(result.stdout, /Report complete\. No files were changed or deleted\./);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
