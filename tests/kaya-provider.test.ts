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
  // The selected model must never be swapped silently.
  assert.ok(!/KAYA_FALLBACK_ORDER/.test(providers), "no automatic model fallback list");
  assert.ok(!/KayaRetryableError/.test(providers), "no failover retry path");
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

test("diagnosis is reachable without a shell", () => {
  // The operator may only have the panel's npm console, so every check must be
  // available as a dependency-free npm script and inside the admin panel.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.diagnose, "npm run diagnose must exist");
  assert.match(pkg.scripts.diagnose, /nomreh-diagnose\.cjs/);

  const script = fs.readFileSync(path.join(root, "scripts/nomreh-diagnose.cjs"), "utf8");
  // Local helpers under scripts/lib are our own code and ship in the same zip;
  // what must not appear is a third-party package that is not installed on a host
  // with only node_modules for the app.
  assert.ok(!/require\(["'](?!node:|\.)/.test(script), "the diagnosis script must have no third-party dependency");
  assert.match(script, /resolv\.conf/);
  assert.match(script, /NOMREH_DIAGNOSE_OK/);
  // It must never read or print a credential.
  assert.ok(!/apiKey|api_key|NOMREH_SECRET/.test(script), "diagnosis must not touch secrets");

  // The same inspection must be available in the panel.
  const hostInspect = fs.readFileSync(path.join(root, "lib/server/host-network-inspect.ts"), "utf8");
  assert.match(hostInspect, /execFile/, "host inspection must use execFile, never a shell");
  assert.ok(!/exec\s*\(|shell:\s*true/.test(hostInspect), "no shell interpolation");
});

test("host inspection does not mistake our own runtime for a foreign VPN", () => {
  // The app's own Shecan runtime lives under nomreh-vm/ and its process paths
  // contain words like "official", which previously produced a false
  // "a VPN is running" verdict on a host with no VPN at all.
  const inspector = fs.readFileSync(path.join(root, "lib/server/host-network-inspect.ts"), "utf8");
  assert.match(inspector, /OWN_PATHS/, "our own installation paths must be excluded");
  assert.match(inspector, /nomreh-vm/, "nomreh-vm must be in the exclusion list");
  // Process matching must look at the command name, not the whole command line.
  assert.match(inspector, /split\(\/\\s\+\/\)\[1\]/, "match the command name only");

  const script = fs.readFileSync(path.join(root, "scripts/nomreh-diagnose.cjs"), "utf8");
  assert.match(script, /OWN_PATHS/);
  assert.ok(!/\|shecan\|/.test(script), "a bare 'shecan' substring must not flag our own runtime");
});

test("outbound provider traffic is capped well under the host's block threshold", async () => {
  // Radcom blocks a subscription after 200 outbound requests to one address in
  // 20 minutes; a relay poll briefly produced 3612 and cost the server its egress.
  const limit = await import("../lib/server/provider-rate-limit");
  assert.ok(limit.PROVIDER_BUDGET.maxPerWindow < 200, "the cap must sit below the hosting threshold");
  assert.equal(limit.PROVIDER_BUDGET.maxPerWindow, 120);
  assert.ok(limit.PROVIDER_BUDGET.maxConcurrency <= 2);

  // The gate must be reachable from the single choke point every provider call uses.
  const network = fs.readFileSync(path.join(root, "lib/server/provider-network.ts"), "utf8");
  assert.match(network, /withProviderBudget/, "providerFetch must pass through the budget gate");
  assert.match(network, /await withProviderBudget\(hostname, \(\) => fetch\(url, init\)\)/, "the request must be a plain direct fetch inside the budget gate");
  // Prose is allowed to name what was removed; executable lines are not.
  const code = network.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/ProxyAgent|dispatcher|localAddress|new Resolver/.test(code), "no transport may be reintroduced");

  // Exhausting the window must throw a typed, non-retryable error.
  const host = "budget-test.invalid";
  const results: string[] = [];
  for (let index = 0; index < 125; index += 1) {
    try {
      await limit.withProviderBudget(host, async () => "ok");
    } catch (error) {
      results.push((error as { code?: string }).code || "unknown");
    }
  }
  assert.ok(results.includes("PROVIDER_RATE_LIMITED"), "the window must close");
});

test("the same submission cannot be graded twice at once", () => {
  const grade = fs.readFileSync(path.join(root, "app/api/grade/route.ts"), "utf8");
  assert.match(grade, /gradingInFlight/, "an in-flight guard must exist");
  assert.match(grade, /status: 429/, "a duplicate run must be rejected, not queued");
});

test("the outbound counter is visible without pressing a button", () => {
  // The operator asked where the limit was; it existed but only rendered after
  // running the full diagnostics. It must now load on mount and refresh itself.
  const panel = fs.readFileSync(path.join(root, "components/api-connection.tsx"), "utf8");
  assert.match(panel, /\/api\/admin\/outbound-usage/, "the cheap counter endpoint must be polled");
  assert.match(panel, /setInterval/, "the counter must refresh itself");
  assert.match(panel, /outbound-usage-card/, "the counter must be rendered in the panel");

  const route = fs.readFileSync(path.join(root, "app/api/admin/outbound-usage/route.ts"), "utf8");
  assert.match(route, /requireAdmin/, "the counter is admin-only");
  assert.ok(!/fetch\(/.test(route), "the counter must not perform network probes");
});

test("the delta updater is bounded and never touches user data", () => {
  const script = fs.readFileSync(path.join(root, "scripts/nomreh-delta-update.cjs"), "utf8");
  assert.match(script, /MAX_FILES/);
  assert.match(script, /MAX_BYTES/);
  assert.match(script, /PROTECTED/);
  assert.match(script, /nomreh\\\.db/, "the database must be protected");
  assert.match(script, /provider-secret/, "the provider secret must be protected");
  // No git, no tarball: only the contents API, one request per changed file.
  assert.ok(!/git clone|git fetch|codeload|\/tarball/.test(script), "never pull a tarball or use git");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.delta, "npm run delta must exist");
});

test("no bypass transport can come back without a failing test", () => {
  // The whole point of this branch: there is one route out of this server. A
  // future change that re-adds a tunnel, a DNS override or a guest VM must fail
  // here instead of quietly making a blocked destination look like a bug.
  const forbidden = [
    "lib/server/shecan-runtime.ts",
    "lib/server/shecan-windows-runtime.ts",
    "lib/server/v2ray-runtime.ts",
    "lib/server/v2ray-config.ts",
    "scripts/shecan-vm",
    "components/v2ray-connection.tsx",
    "components/official-shecan-console.tsx",
    "app/api/admin/v2ray",
    "app/api/admin/shecan-runtime",
  ];
  for (const path of forbidden) {
    assert.equal(fs.existsSync(`${root}/${path}`), false, `${path} must stay deleted`);
  }
  const gateway = fs.readFileSync(path.join(root, "lib/server/provider-network.ts"), "utf8");
  assert.ok(!/shecan|v2ray|xray|socks|tunnel|proxy/i.test(gateway.replace(/\/\*[\s\S]*?\*\//g, "")), "the provider gateway must not mention a transport");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
  for (const name of Object.keys(pkg.scripts)) assert.ok(!/shecan|v2ray|vnc/i.test(name), `script ${name} must be gone`);
  for (const name of Object.keys(pkg.dependencies)) assert.ok(!/novnc|^ws$/.test(name), `dependency ${name} must be gone`);
});

test("the Kaya watcher is rate-safe and needs no key", () => {
  // The path opens on someone else's schedule, so a human retrying by hand burns the
  // host's 200-per-20-min budget. The watcher must be slow, key-free and stoppable.
  const script = fs.readFileSync(path.join(root, "scripts", "kaya-reachability-watch.cjs"), "utf8");
  assert.match(script, /INTERVAL_MS = 10 \* 60 \* 1000/, "one probe per 10 minutes at most");
  assert.ok(!/apiKey|Authorization|Bearer/.test(script), "the probe must send no credential");
  assert.match(script, /kaya-watch-disabled/, "it must be stoppable without the panel");
  assert.match(script, /kaya-status\.json/, "it must record its result for the panel");
  // 10-minute spacing means at most 2 probes inside any 20-minute window.
  const perWindow = (20 * 60 * 1000) / (10 * 60 * 1000);
  assert.ok(perWindow <= 2, "well inside the hosting egress budget");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts["kaya:watch"] && pkg.scripts["kaya:check"]);
});

test("the Kaya deep test is runnable from the panel console", () => {
  // The operator's console is Plesk's npm box: everything is prefixed with `npm`,
  // there is no shell, and the runtime is Node 17. The transport probes were all
  // green, so the remaining question is whether the request Nomreh builds is
  // accepted. That test has to survive all three of those constraints.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["kaya:test"] || "", /nomreh-kaya-test\.cjs/);
  assert.match(pkg.scripts["kaya:measure"] || "", /nomreh-kaya-measure\.cjs/);

  const script = fs.readFileSync(path.join(root, "scripts/nomreh-kaya-test.cjs"), "utf8");
  // Node 17 compatibility: these are ES2022+ and would crash the console runtime.
  for (const newer of [/\.at\(/, /structuredClone/, /\?\?\./, /Object\.hasOwn/, /AbortSignal\.timeout/]) {
    assert.ok(!newer.test(script), `the console script must not use ${newer} on Node 17`);
  }
  // It re-runs itself on the domain-local Node 22 the app already installed.
  assert.match(script, /ensureNode22/);
  const delegate = fs.readFileSync(path.join(root, "scripts/lib/plesk-node-delegate.cjs"), "utf8");
  assert.match(delegate, /runtime", "node", "bin", "node"/);
  assert.ok(!/require\(["'](?!node:|\.)/.test(delegate), "the delegating helper must stay dependency-free");

  // The key is decrypted in memory only: never logged, never written.
  assert.ok(!/console\.log\(\s*apiKey/.test(script), "the key must never be printed");
  assert.ok(!/writeFileSync/.test(script), "the test must not write to disk");
  // A failure must name the layer instead of a generic network error.
  for (const verdict of ["KAYA_TEST_ALL_OK", "KAYA_TEST_POST_DROPPED", "KAYA_TEST_TRANSPORT_BLOCKED", "KAYA_TEST_API_ERROR"]) {
    assert.ok(script.indexOf(verdict) >= 0, `the test must be able to conclude ${verdict}`);
  }
});

test("the panel can test the real key without a console", () => {
  // The operator has no shell, only the Plesk npm box, and that box rejected every
  // command that was not `npm run <script>`. A test that lives in the panel needs
  // no console at all, so the deep check must also exist as an admin endpoint.
  const route = fs.readFileSync(path.join(root, "app/api/admin/kaya-live-test/route.ts"), "utf8");
  assert.match(route, /requireAdmin/, "the endpoint must be admin-only");
  assert.match(route, /getProviderConfig/, "it must use the stored key, not a pasted one");
  // The 20-minute ceiling is the operator's top concern: the test must be gated by
  // the same budget as grading, otherwise pressing it could block the host.
  assert.match(route, /withProviderBudget/, "the test must spend the same outbound budget as grading");
  // Grading a real failure must never be caused by the test retrying behind a wall.
  assert.ok(!/for\s*\(\s*let\s+attempt/.test(route), "the test must not retry");
  assert.ok(!/console\.log/.test(route), "the key must never reach a log line");
});

test("the panel shows the deep-test result layer by layer", () => {
  const component = fs.readFileSync(path.join(root, "components/api-connection.tsx"), "utf8");
  assert.match(component, /kaya-live-test/, "the panel must call the deep test");
  assert.match(component, /آزمون واقعی کایا/, "the button must be labelled for the operator");
  // A single "failed" line is what made this take days to diagnose.
  for (const layer of ["catalogue", "text", "image"]) {
    assert.ok(component.indexOf(`step === "${layer}"`) >= 0, `the result must separate the ${layer} step`);
  }
});

test("no probe in the console script can hang", () => {
  // The operator's run printed "tcp 443 TIMEOUT" and then sat there forever: the
  // socket's timeout event destroyed the socket without ever resolving the
  // promise. A diagnostic that hangs is worse than none, because it looks like
  // the server froze.
  const script = fs.readFileSync(path.join(root, "scripts/nomreh-kaya-test.cjs"), "utf8");

  // Never destroy-on-timeout without settling the promise.
  assert.ok(
    !/setTimeout\(timeout,\s*\(\)\s*=>\s*socket\.destroy\(\)\)/.test(script),
    "a socket timeout must resolve the promise, not just destroy the socket",
  );
  // Every network wait has an independent timer, so a socket that never answers
  // cannot keep the process alive.
  const timers = (script.match(/clearTimeout\(/g) || []).length;
  assert.ok(timers >= 2, `each guarded wait must clear its timer (found ${timers})`);
  // A failed TCP connect must stop the run before TLS and the three HTTP calls.
  assert.match(script, /reportBlocked/, "a dead port must be reported as a layer, not retried");
  assert.match(script, /reportTicket/, "a block must print something the operator can send");
  // And the block path must return, not fall through to the requests.
  assert.ok(script.indexOf('reportBlocked("tcp"') > 0, "the connect failure must be handled at one place");
});

test("the panel can set the egress address, and grading uses it", () => {
  const route = fs.readFileSync(path.join(root, "app/api/admin/kaya-egress/route.ts"), "utf8");
  assert.match(route, /requireAdmin/, "the setting must be admin-only");
  // Guessing an address must be impossible: the API reports what exists here.
  assert.match(route, /localAddresses/, "the panel must be told which addresses exist");

  const store = fs.readFileSync(path.join(root, "lib/server/kaya-egress-store.ts"), "utf8");
  assert.match(store, /addressMissing/, "a saved address that is not local must be flagged");

  // The setting is worthless unless the real grading request uses it.
  const providers = fs.readFileSync(path.join(root, "lib/server/providers.ts"), "utf8");
  assert.match(providers, /kayaAgent\(input\.egress\)/, "the Kaya call must use the configured source address");
  assert.match(providers, /kayaBaseUrl\(input\.egress\)/, "the Kaya call must use the configured host");
  assert.match(providers, /describeEgressFailure/, "a wrong address must be explained, not reported as an outage");

  const panel = fs.readFileSync(path.join(root, "components/api-connection.tsx"), "utf8");
  assert.match(panel, /آدرس خروجی برای کایا/, "the operator needs a field, not a console command");
});

test("the operator is told which address to use, without a console", () => {
  // "Where do I get an Iranian address?" has one correct answer: the ones this
  // server owns. Anything else cannot be bound to, so the API must report both the
  // addresses that exist and the default one Kaya is refusing.
  const route = fs.readFileSync(path.join(root, "app/api/admin/kaya-egress/route.ts"), "utf8");
  assert.match(route, /defaultAddress/, "the panel needs to show the address Kaya refuses");
  assert.match(route, /localAddresses/, "the panel needs the addresses that can actually be used");

  const panel = fs.readFileSync(path.join(root, "components/api-connection.tsx"), "utf8");
  assert.match(panel, /chip-button/, "a choice must be one click, not a guess typed by hand");
  assert.match(panel, /آدرس‌های موجود روی این سرور/, "the list must be labelled for the operator");

  // And the same answer is available as a command, for a host without the panel.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["kaya:egress"] || "", /nomreh-kaya-egress-check\.cjs/);
  const script = fs.readFileSync(path.join(root, "scripts/nomreh-kaya-egress-check.cjs"), "utf8");
  assert.match(script, /EGRESS_OK|EGRESS_BLOCKED/, "the command must reach a verdict");
  assert.ok(!/apiKey|sk-/.test(script), "listing addresses must not touch credentials");
});

test("the ceiling is server-wide and the panel shows that number", () => {
  // The operator's rule: the 200-per-20-minutes limit is the whole server's, not
  // one API's. A per-host counter could be evaded by adding a second destination,
  // and a separate worker kept its own count, so a widget could have sent 3000.
  const limit = fs.readFileSync(path.join(root, "lib/server/provider-rate-limit.ts"), "utf8");
  assert.match(limit, /createOutboundWindow/, "a single shared window must exist");
  assert.match(limit, /serverWindow\.take\(\)/, "every provider request must spend from it");
  assert.match(limit, /سقف کل خروجی سرور/, "the refusal must say it is the whole server");
  assert.match(limit, /serverOutboundUsage/, "the panel needs the shared number");

  const window = fs.readFileSync(path.join(root, "lib/server/outbound-window.ts"), "utf8");
  // In memory only, two Next.js workers would each count to 120.
  assert.match(window, /dataDirectory/, "the window must live on disk to be shared across processes");
  assert.match(window, /withLock/, "concurrent writers must be serialised");

  const route = fs.readFileSync(path.join(root, "app/api/admin/outbound-usage/route.ts"), "utf8");
  assert.match(route, /serverOutboundUsage/, "the counter endpoint must report the shared window");

  const panel = fs.readFileSync(path.join(root, "components/api-connection.tsx"), "utf8");
  assert.match(panel, /همهٔ مقصدها/, "the panel must show one combined bar");
  assert.match(panel, /محدودیت کل خروجی سرور/, "and label it as the whole server");
});
