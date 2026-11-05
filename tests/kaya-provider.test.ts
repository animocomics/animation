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
