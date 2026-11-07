import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";

/**
 * The reachability script is what the operator runs to find out whether a service
 * answers from the host. It is only useful if its verdicts are trustworthy, so the
 * properties below are pinned: it must be runnable with no network (the sandbox has
 * none to these hosts), it must never turn a network failure into a silent pass, and
 * it must keep the one request it sends per target — no loops, because the host
 * allows 200 requests per 20 minutes for everything.
 */

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "nomreh-reachability.cjs");

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: root, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code || 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test("the reachability script parses and runs on the current runtime", async () => {
  // No npm, no tsx: Plesk's console may only have `node`. Plain CommonJS is the
  // requirement, and a syntax error here would only surface on the customer's host.
  const { code, stdout, stderr } = await run(["--json"]);
  assert.notEqual(code, null);
  const payload = stdout.trim() || (stderr.includes("[") ? stderr.slice(stderr.indexOf("[")) : "");
  assert.ok(payload.includes("["), `expected JSON output, got: ${stdout.slice(0, 200)} ${stderr.slice(0, 200)}`);
  const parsed = JSON.parse(payload.slice(payload.indexOf("["))) as Array<{
    host: string;
    verdict: { ok: boolean; layer: string };
    dns: boolean;
    tcp: boolean;
    tls: boolean;
    http: number;
  }>;
  assert.ok(parsed.length >= 5, "every target must be reported");
  for (const entry of parsed) {
    assert.ok(entry.host, "each result names its host");
    assert.ok(["DNS", "TCP", "TLS", "CERT", "HTTP"].includes(entry.verdict.layer), `unexpected layer: ${entry.verdict.layer}`);
    // A verdict of "ok" must be backed by an actual HTTP status from the service.
    if (entry.verdict.ok) {
      assert.ok(entry.http > 0, `${entry.host} was reported OK without an HTTP answer`);
      assert.equal(entry.dns && entry.tcp && entry.tls, true, `${entry.host} was reported OK while a lower layer failed`);
    }
  }
});

test("the check never reports success for a host that did not answer", async () => {
  const { stdout } = await run(["--json"]);
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{
    host: string;
    verdict: { ok: boolean };
    http: number;
    tls: boolean;
  }>;
  for (const entry of parsed) {
    if (!entry.tls || entry.http <= 0) {
      assert.equal(entry.verdict.ok, false, `${entry.host} has no HTTP answer but was reported healthy`);
    }
  }
});

test("the script sends one request per target and defines no timer", async () => {
  const fs = await import("node:fs");
  const body = fs.readFileSync(script, "utf8");
  // A watcher here would burn the host's shared egress allowance and get the whole
  // server blocked — that already happened once with a retry loop.
  assert.doesNotMatch(body, /setInterval/, "no polling loop");
  assert.doesNotMatch(body, /for\s*\(.*attempt/, "no retry loop");
  // One GET per target, issued once.
  const gets = body.match(/https\.request\(/g) || [];
  assert.equal(gets.length, 1, "exactly one HTTP request implementation");
});

test("the gapgpt-only mode targets the API host, not the marketing site", async () => {
  const fs = await import("node:fs");
  const body = fs.readFileSync(script, "utf8");
  // Reaching gapgpt.app says nothing about api.gapgpt.app; the filter must cover the
  // API host or the operator learns the wrong thing.
  assert.match(body, /api\.gapgpt\.app/);
  assert.match(body, /only === "ai-gapgpt"\) return target\.host\.includes\("gapgpt"\)/);
});
