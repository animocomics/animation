import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getApiNetworkStatus } from "@/lib/server/api-network";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Network diagnostics for the admin console.
//
// The provider screens can only say "connection failed", because a socket-level
// failure carries no HTTP status. When that happens the operator has no way to
// tell an unreachable host from a bad key. This endpoint separates the layers
// (DNS, TCP, TLS, HTTP) and reports the real error code for each.
//
// It is admin-only, performs only GET requests to fixed Kaya/GitHub endpoints,
// sends no credentials, reads no stored secret, and never returns a key. It does
// not alter any setting and does not touch provider routing.

interface ProbeResult {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const TARGETS = [
  { label: "Kaya AI", url: "https://kayaai.ir/api/chat/completions" },
  { label: "GitHub API", url: "https://api.github.com" },
];

function describe(error: unknown): string {
  const value = error as { message?: string; code?: string; cause?: { code?: string; message?: string; errno?: string } };
  const code = value?.cause?.code || value?.code || "";
  const message = value?.cause?.message || value?.message || String(error);
  // Keep it short and free of any URL with credentials.
  return `${code ? `${code}: ` : ""}${String(message).replace(/https?:\/\/\S+/g, "[url]")}`.slice(0, 220);
}

async function probeDns(hostname: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const dns = await import("node:dns/promises");
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]);
    const ok = v4.length + v6.length > 0;
    return {
      step: "dns",
      ok,
      detail: ok ? `IPv4 ${v4.length}, IPv6 ${v6.length}` : "no A/AAAA record",
      ms: Date.now() - started,
    };
  } catch (error) {
    return { step: "dns", ok: false, detail: describe(error), ms: Date.now() - started };
  }
}

async function probeTcp(hostname: string): Promise<ProbeResult> {
  const started = Date.now();
  const net = await import("node:net");
  return new Promise<ProbeResult>((resolve) => {
    const socket = net.createConnection({ host: hostname, port: 443 });
    const done = (ok: boolean, detail: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ step: "tcp", ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(6000);
    socket.once("connect", () => done(true, "port 443 accepted"));
    socket.once("timeout", () => done(false, "ETIMEDOUT: port 443 did not answer within 6s"));
    socket.once("error", (error) => done(false, describe(error)));
  });
}

async function probeTls(hostname: string): Promise<ProbeResult> {
  const started = Date.now();
  const tls = await import("node:tls");
  return new Promise<ProbeResult>((resolve) => {
    const socket = tls.connect({ host: hostname, servername: hostname, port: 443, rejectUnauthorized: false });
    const done = (ok: boolean, detail: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ step: "tls", ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(8000);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const issuer = certificate && certificate.issuer ? certificate.issuer.O || certificate.issuer.CN || "unknown" : "unknown";
      done(true, `handshake ok, issuer ${String(issuer).slice(0, 60)}`);
    });
    socket.once("timeout", () => done(false, "ETIMEDOUT: TLS handshake stalled"));
    socket.once("error", (error) => done(false, describe(error)));
  });
}

async function probeHttp(url: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    // The catalogue is public, so no key is needed and none is sent.
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
      headers: { "User-Agent": "nomreh-network-diagnostics" },
    });
    const body = await response.text().catch(() => "");
    return {
      step: "http",
      ok: response.ok,
      detail: `HTTP ${response.status}, ${body.length} bytes`,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { step: "http", ok: false, detail: describe(error), ms: Date.now() - started };
  }
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  // A stale tunnel or a dead local proxy produces exactly the "connection
  // failed" symptom, so report the active routing mode before probing.
  let networkMode: Record<string, unknown> = {};
  try {
    const status = await getApiNetworkStatus();
    networkMode = {
      shecanEnabled: status.enabled,
      transport: status.transport,
      plan: status.plan,
      lastTestStatus: status.lastTestStatus,
      lastTestMessage: status.lastTestMessage,
    };
  } catch (error) {
    networkMode = { error: describe(error) };
  }

  const url = new URL(request.url);
  const only = url.searchParams.get("target");
  const targets = only ? TARGETS.filter((item) => item.label.toLowerCase().includes(only.toLowerCase())) : TARGETS;

  const results: Array<{ label: string; hostname: string; probes: ProbeResult[] }> = [];
  for (const target of targets.length ? targets : TARGETS) {
    const hostname = new URL(target.url).hostname;
    const probes: ProbeResult[] = [
      await probeDns(hostname),
      await probeTcp(hostname),
      await probeTls(hostname),
      await probeHttp(target.url),
    ];
    results.push({ label: target.label, hostname, probes });
  }

  // The first failing layer is the actionable one.
  const firstFailure = results
    .flatMap((entry) => entry.probes.map((probe) => ({ label: entry.label, hostname: entry.hostname, probe })))
    .find((entry) => !entry.probe.ok);

  return NextResponse.json({
    // Lets the operator confirm the deploy actually took effect: if this marker
    // is missing, the browser is talking to an older build.
    diagnosticsVersion: "v3",
    checkedAt: new Date().toISOString(),
    runtimeVersion: process.version,
    platform: process.platform,
    networkMode,
    results,
    conclusion: firstFailure
      ? `اولین لایهٔ ناموفق برای ${firstFailure.label} (${firstFailure.hostname}): ${firstFailure.probe.step} — ${firstFailure.probe.detail}${networkMode.shecanEnabled ? `. توجه: حالت شبکه «${String(networkMode.transport)}» روشن است؛ اگر لایهٔ TCP سالم است ولی TLS شکسته، همان تونل را خاموش کنید و دوباره آزمایش کنید.` : ""}`
      : "همهٔ لایه‌ها تا HTTP سالم هستند.",
  });
}
