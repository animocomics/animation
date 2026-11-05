import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FALLBACK_MODEL_OPTIONS, RECOMMENDED_MODELS, SUPPORTS_ACCOUNT_MODEL_DISCOVERY } from "../lib/provider-catalog";
import { isProviderHostname } from "../lib/server/provider-network";

const root = path.resolve(__dirname, "..");

test("Kaya AI is a first-class provider with a verified default model", () => {
  assert.equal(RECOMMENDED_MODELS.kaya, "deepseek/deepseek-v4.1-flash");
  assert.ok(FALLBACK_MODEL_OPTIONS.kaya.includes(RECOMMENDED_MODELS.kaya));
  assert.equal(SUPPORTS_ACCOUNT_MODEL_DISCOVERY.kaya, true);
});

test("Kaya catalogue ids use the owner/model form the gateway requires", () => {
  const ids = FALLBACK_MODEL_OPTIONS.kaya;
  assert.ok(ids.length >= 5);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/, `unexpected Kaya model id: ${id}`);
    assert.doesNotMatch(id, /:batch$/, "batch variants are not interactive chat models");
    assert.doesNotMatch(id, /^~/, "the ~ aliases are floating shortcuts, not pinned ids");
  }
});

test("Kaya stays off the Shecan route because it is served from inside Iran", () => {
  // Kaya must not be forced through the Shecan tunnel: it is reachable directly
  // from an Iranian host, and tunnelling it would add a failure mode.
  assert.equal(isProviderHostname("kayaai.ir"), false);
  assert.equal(isProviderHostname("www.kayaai.ir"), false);
  // The providers that do need the tunnel must stay registered.
  for (const host of ["api.openai.com", "generativelanguage.googleapis.com", "api.deepseek.com"]) {
    assert.equal(isProviderHostname(host), true, `${host} must remain on the Shecan route`);
  }
});

test("every provider surface accepts kaya so the admin can actually save it", () => {
  const surfaces = [
    "lib/types.ts",
    "lib/server/provider-config.ts",
    "lib/server/workspace-store.ts",
    "app/api/provider/route.ts",
    "app/api/provider/test/route.ts",
    "app/api/provider/models/route.ts",
  ];
  for (const file of surfaces) {
    const body = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(body, /"kaya"/, `${file} must accept the kaya provider`);
  }
});

test("Kaya routes PDFs through the in-house image conversion and sizes chat payloads", () => {
  const pdf = fs.readFileSync(path.join(root, "lib", "server", "pdf-vision.ts"), "utf8");
  assert.match(pdf, /"kaya"\]\.includes\(provider\)/, "PDF must be converted before sending to Kaya");
  const grade = fs.readFileSync(path.join(root, "app", "api", "grade", "route.ts"), "utf8");
  assert.match(grade, /"kaya"\]/, "grading upload size must cover Kaya");
});

test("Kaya call path is OpenAI-compatible and fails over only within Kaya", () => {
  const providers = fs.readFileSync(path.join(root, "lib", "server", "providers.ts"), "utf8");
  assert.match(providers, /https:\/\/kayaai\.ir\/api/);
  assert.match(providers, /input\.provider === "kaya"\) return callKaya\(input\)/);
  // Failover must never leave the gateway or touch scoring rules.
  assert.match(providers, /KAYA_FALLBACK_ORDER/);
  assert.match(providers, /KAYA_FAILOVER_STATUSES/);
  assert.match(providers, /مدل جایگزین/, "a substituted model must be disclosed in the reason");
  // Authentication shape required by the provider.
  assert.match(providers, /Authorization: `Bearer \$\{input\.apiKey\}`/);
  // Documented error contracts must map to actionable Persian messages.
  assert.match(providers, /status === 401/);
  assert.match(providers, /status === 402/);
});

test("deploy archive builder refuses secrets and local artifacts", () => {
  const builder = fs.readFileSync(path.join(root, "scripts", "build-deploy-zip.cjs"), "utf8");
  // Secrets and anything environment-specific must be excluded by name.
  assert.match(builder, /"\.env"/);
  assert.match(builder, /startsWith\("\.env"\)/);
  assert.match(builder, /node_modules/);
  assert.match(builder, /nomreh-vm/);
  assert.match(builder, /\.next\/cache\//);
  assert.match(builder, /endsWith\("\.tsbuildinfo"\)/);
  // And by content, so an accidentally committed key cannot ship.
  assert.match(builder, /PRIVATE KEY/);
  assert.match(builder, /sk-llm-/);
  assert.match(builder, /gh\[pousr\]_/);
  // A package without a completed build must not be produced.
  assert.match(builder, /\.next", "BUILD_ID"\)/);
});

test("the admin console is never gated on workspace storage, so it cannot hang on a spinner", () => {
  const shell = fs.readFileSync(path.join(root, "components", "app-shell.tsx"), "utf8");
  // Admin accounts have no workspace document; gating the admin console on it
  // left the page on its loading shell forever when hydration failed or the
  // gate was misread. The gate must short-circuit for admins.
  assert.match(shell, /isAdmin \|\| storageReady \? children/);
});

test("the deploy bundle ships client assets in both places the stack needs", () => {
  const builder = fs.readFileSync(path.join(root, "scripts", "build-deploy-zip.cjs"), "utf8");
  // Next's server refuses to boot without .next/static...
  assert.match(builder, /syncPublicStatic\(APP_ROOT\)/);
  // ...and nginx serves the browser from public/_next, so neither copy may be dropped.
  assert.doesNotMatch(builder, /"\/\.next\/static\/"/);
  assert.match(builder, /client asset\(s\) referenced by the build are missing/);
});

test("socket failures surface the real error code instead of a generic sentence", () => {
  // The old heuristic tested whether the message contained "fetch". Node reports
  // every network failure as literally "fetch failed", so the check always chose
  // the generic text and the operator never learned the cause.
  const files = [
    "app/api/provider/test/route.ts",
    "app/api/provider/models/route.ts",
    "lib/server/provider-models.ts",
    "lib/server/providers.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    if (file.endsWith("provider/route.ts")) continue;
    const mentionsCode = /cause\?\.code|\.code\s*\|\||code\s*=\s*value/.test(source);
    assert.ok(mentionsCode, `${file} must read the socket error code`);
  }
  const testRoute = fs.readFileSync(path.join(root, "app/api/provider/test/route.ts"), "utf8");
  assert.ok(!/!error\.message\.includes\("fetch"\) \? error\.message : "ارتباط/.test(testRoute), "the generic fallback must include the code");
});

test("admin network diagnostics endpoint exists and is admin-gated", () => {
  const source = fs.readFileSync(path.join(root, "app/api/admin/network-diagnostics/route.ts"), "utf8");
  assert.match(source, /requireAdmin/);
  assert.match(source, /probeDns|resolve4/);
  assert.match(source, /probeTcp|createConnection/);
  assert.match(source, /probeTls|tls\.connect/);
  // Must never echo a stored key back to the caller.
  assert.ok(!/apiKey\s*[,:]/.test(source), "diagnostics must not return an API key");
});

test("network diagnostics cannot exceed the reverse proxy timeout", () => {
  // A sequential probe run timed out behind Plesk and returned an HTML 504
  // exactly when the operator needed the result. Every probe must be budgeted
  // and the independent groups must run concurrently.
  const source = fs.readFileSync(path.join(root, "app/api/admin/network-diagnostics/route.ts"), "utf8");
  assert.match(source, /withBudget/, "probes must be time-boxed");
  assert.match(source, /Promise\.all\(/, "probe groups must run concurrently");
  assert.match(source, /BUDGET_MS/);
  // A failed TCP connect must not trigger two more identical timeouts.
  assert.match(source, /skipped: true/);
});
