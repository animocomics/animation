import { writeFileSync } from "node:fs";
import { parseV2RayConfig } from "../lib/server/v2ray-config";

const ORIGIN = "https://nomreh.arounidea.com";
const output = process.env.NOMREH_V2RAY_LIVE_OUTPUT || "/tmp/nomreh-v2ray-live-test.md";
const lines: string[] = ["# Nomreh V2Ray live activation", "", "This run uses the real admin API and Xray on the existing Nomreh host. It does not start QEMU, a guest, VNC, or a browser, and it never prints share links, credentials, cookies, or provider request bodies.", ""];
const started = Date.now();
let cookie = "";

function clean(value: unknown): string {
  return String(value || "")
    .replace(/(?:vless|vmess|trojan|ss):[^\s]+/gi, "[redacted-link]")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[redacted-id]")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function normalizeMarkdown(value: string): string {
  return value.trim().replace(/&amp;/gi, "&").replace(/\[([^\]]+)\]\((?:mailto:|https?:\/\/)[^)]+\)/gi, "$1");
}

function report(): string {
  const text = lines.join("\n");
  writeFileSync(output, text, { mode: 0o600 });
  return text;
}

async function request(pathname: string, init: RequestInit = {}): Promise<{ status: number; payload: Record<string, any>; headers: Headers }> {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    redirect: "manual",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(30_000),
  });
  const text = (await response.text()).slice(0, 200_000);
  let payload: Record<string, any> = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: `Non-JSON HTTP ${response.status}` }; }
  return { status: response.status, payload, headers: response.headers };
}

async function main() {
  const raw = process.env.NOMREH_V2RAY_TEST_CONFIGS || "";
  if (!raw.trim()) throw new Error("No V2Ray test input was supplied.");
  const accepted: string[] = [];
  let rejected = 0;
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = normalizeMarkdown(sourceLine);
    if (!line) continue;
    try {
      parseV2RayConfig(line);
      if (accepted.length < 60) accepted.push(line);
    } catch {
      rejected += 1;
    }
  }
  const overLimit = Math.max(0, raw.split(/\r?\n/).map(normalizeMarkdown).filter(Boolean).length - rejected - accepted.length);
  lines.push(`- Input normalized in memory: ${accepted.length} supported config(s) queued; ${rejected} unsupported/malformed line(s) skipped; ${overLimit} over the bounded 60-config run limit. No raw config was logged.`);
  if (!accepted.length) throw new Error("None of the supplied lines matched the currently deployed supported Xray formats.");

  const username = process.env.NOMREH_ADMIN_USERNAME || (process.env.NOMREH_ALLOW_DEMO_ACCOUNTS === "1" ? "admin" : "");
  const password = process.env.NOMREH_ADMIN_PASSWORD || (process.env.NOMREH_ALLOW_DEMO_ACCOUNTS === "1" ? "Admin@1405" : "");
  if (!username || !password) throw new Error("Authorized admin credentials were unavailable.");
  const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`Admin login failed with HTTP ${login.status}.`);
  const setCookie = login.headers.get("set-cookie") || "";
  const session = setCookie.match(/nomreh_session=[^;]+/)?.[0] || "";
  if (!session) throw new Error("The admin login did not return a session cookie.");
  cookie = session;
  lines.push("- Real admin login succeeded; the session cookie remained in memory.");

  const activation = await request("/api/admin/v2ray", { method: "POST", body: JSON.stringify({ action: "activate", configs: accepted.join("\n") }) });
  if (activation.status !== 202) throw new Error(`V2Ray activation was rejected with HTTP ${activation.status}: ${clean(activation.payload.error)}`);
  lines.push("- Real V2Ray activation job accepted (HTTP 202); no QEMU/VNC wait is involved.");

  let status: Record<string, any> = {};
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const result = await request("/api/admin/v2ray");
    if (result.status !== 200 || !result.payload.status) throw new Error(`V2Ray status polling failed with HTTP ${result.status}.`);
    status = result.payload.status;
    if (!status.pending) break;
  }
  if (status.pending) throw new Error("V2Ray activation exceeded the bounded ten-minute polling window.");
  const configs = Array.isArray(status.configs) ? status.configs : [];
  const healthy = configs.filter((item) => item.testStatus === "success").length;
  const failed = configs.filter((item) => item.testStatus === "error").length;
  lines.push(`- Activation finished in ${Math.round((Date.now() - started) / 1000)}s: enabled=${status.enabled ? "yes" : "no"}; running=${status.running ? "yes" : "no"}; healthy=${healthy}; failed=${failed}; selected=${clean(status.selectedLabel || "none")}.`);
  const errorCounts = new Map<string, number>();
  for (const item of configs) if (typeof item.errorCode === "string" && /^[A-Z][A-Z0-9_]{2,30}$/.test(item.errorCode)) errorCounts.set(item.errorCode, (errorCounts.get(item.errorCode) || 0) + 1);
  if (errorCounts.size) lines.push(`- Safe per-config failure codes: ${[...errorCounts.entries()].sort().map(([code, count]) => `${code}=${count}`).join(", ")}.`);
  if (status.lastTestMessage) lines.push(`- Sanitized runtime result: ${clean(status.lastTestMessage)}`);
  if (status.jobError) lines.push(`- Sanitized activation error: ${clean(status.jobError)}`);
  if (!status.enabled || !status.running) throw new Error("No supplied V2Ray config passed the real Gemini probe; V2Ray was not marked active.");

  const provider = await request("/api/provider/test", {
    method: "POST",
    body: JSON.stringify({ provider: "gemini", model: "gemini-3.8-flash" }),
    signal: AbortSignal.timeout(35_000),
  });
  lines.push(`- Real stored-Gemini provider request through the selected V2Ray route: HTTP ${provider.status}; ${provider.status === 200 ? "provider accepted the request" : `safe error: ${clean(provider.payload.error)}`}.`);
  if (provider.status !== 200) throw new Error("V2Ray activated, but the stored Gemini provider acceptance request did not pass.");
  lines.push("", "## Result", "", "V2Ray activation and the real stored-Gemini request passed without any direct-fallback claim or guest/VNC dependency.");
}

main().then(() => report()).catch((error) => {
  lines.push("", "## Result", "", `FAILED: ${clean(error instanceof Error ? error.message : "V2Ray live test failed")}`);
  report();
  process.exitCode = 1;
});
