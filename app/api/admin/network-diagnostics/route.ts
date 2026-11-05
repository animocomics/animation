import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getApiNetworkStatus } from "@/lib/server/api-network";
import { inspectAddresses, addressConclusion } from "@/lib/server/network-probe";

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
// It is admin-only, performs only outbound GET/CONNECT probes to fixed targets,
// sends no credentials, reads no stored secret, and never returns a key. It does
// not alter any setting and does not touch provider routing.
//
// Everything runs in parallel with a hard budget: the slowest case is a network
// that drops packets, and a sequential version exceeded the reverse proxy's
// timeout exactly when the information was most needed (HTTP 504).

interface ProbeResult {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
  skipped?: boolean;
}

const TARGETS = [
  { label: "Kaya AI", url: "https://kayaai.ir/api/chat/completions" },
  { label: "GitHub API", url: "https://api.github.com" },
];

const BUDGET_MS = 22_000;

function describe(error: unknown): string {
  const value = error as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = value?.cause?.code || value?.code || "";
  const message = value?.cause?.message || value?.message || String(error);
  return `${code ? `${code}: ` : ""}${String(message).replace(/https?:\/\/\S+/g, "[url]")}`.slice(0, 200);
}

function withBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function probeDns(hostname: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const dns = await import("node:dns/promises");
    const [v4, v6] = await Promise.all([
      withBudget(dns.resolve4(hostname).catch(() => [] as string[]), 4000, []),
      withBudget(dns.resolve6(hostname).catch(() => [] as string[]), 4000, []),
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

function probeTcp(host: string, port = 443, timeout = 5000): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    void (async () => {
      const net = await import("node:net");
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean, detail: string) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve({ step: `tcp`, ok, detail, ms: Date.now() - started });
      };
      socket.setTimeout(timeout);
      socket.once("connect", () => done(true, `port ${port} accepted`));
      socket.once("timeout", () => done(false, `ETIMEDOUT: port ${port} silent for ${Math.round(timeout / 1000)}s`));
      socket.once("error", (error) => done(false, describe(error)));
    })();
  });
}

function probeTls(hostname: string, address?: string): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    void (async () => {
      const tls = await import("node:tls");
      const socket = tls.connect({ host: address || hostname, servername: hostname, port: 443, rejectUnauthorized: false });
      const done = (ok: boolean, detail: string) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve({ step: "tls", ok, detail, ms: Date.now() - started });
      };
      socket.setTimeout(6000);
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate();
        const issuer = certificate && certificate.issuer ? certificate.issuer.O || certificate.issuer.CN || "unknown" : "unknown";
        done(true, `handshake ok, issuer ${String(issuer).slice(0, 60)}`);
      });
      socket.once("timeout", () => done(false, "ETIMEDOUT: TLS handshake stalled"));
      socket.once("error", (error) => done(false, describe(error)));
    })();
  });
}

function probeHttp(url: string): Promise<ProbeResult> {
  const started = Date.now();
  return (async () => {
    try {
      // The catalogue is public, so no key is needed and none is sent.
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
        headers: { "User-Agent": "nomreh-network-diagnostics" },
      });
      const body = await response.text().catch(() => "");
      return { step: "http", ok: response.ok, detail: `HTTP ${response.status}, ${body.length} bytes`, ms: Date.now() - started };
    } catch (error) {
      return { step: "http", ok: false, detail: describe(error), ms: Date.now() - started };
    }
  })();
}

function probePlainHttp(url: string): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise<ProbeResult>((resolve) => {
    void (async () => {
      const http = await import("node:http");
      const request = http.get(url, { timeout: 5000, headers: { "User-Agent": "nomreh-network-diagnostics" } }, (response) => {
        response.resume();
        resolve({ step: "http:80", ok: true, detail: `HTTP ${response.statusCode}`, ms: Date.now() - started });
      });
      request.on("timeout", () => request.destroy(new Error("ETIMEDOUT")));
      request.on("error", (error) => resolve({ step: "http:80", ok: false, detail: describe(error), ms: Date.now() - started }));
    })();
  });
}

// A target whose TCP connect failed cannot produce a TLS or HTTP result, and
// waiting for those timeouts is what made this endpoint time out. Skipping them
// is both faster and more honest than reporting three timeouts for one cause.
async function probeTarget(target: { label: string; url: string }) {
  const hostname = new URL(target.url).hostname;
  const tcp = await probeTcp(hostname);
  if (!tcp.ok) {
    return {
      label: target.label,
      hostname,
      probes: [
        await probeDns(hostname),
        tcp,
        { step: "tls", ok: false, detail: "skipped: TCP did not connect", ms: 0, skipped: true } as ProbeResult,
        { step: "http", ok: false, detail: "skipped: TCP did not connect", ms: 0, skipped: true } as ProbeResult,
      ],
    };
  }
  return {
    label: target.label,
    hostname,
    probes: [await probeDns(hostname), tcp, await probeTls(hostname), await probeHttp(target.url)],
  };
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  const only = url.searchParams.get("target");
  const targets = only ? TARGETS.filter((item) => item.label.toLowerCase().includes(only.toLowerCase())) : TARGETS;
  const selected = targets.length ? targets : TARGETS;

  // A stale tunnel or a dead local proxy produces exactly the "connection
  // failed" symptom, so report the active routing mode alongside the probes.
  const networkModePromise = getApiNetworkStatus()
    .then((status) => ({
      shecanEnabled: status.enabled,
      transport: status.transport,
      plan: status.plan,
      lastTestStatus: status.lastTestStatus,
      lastTestMessage: status.lastTestMessage,
    }))
    .catch((error) => ({ error: describe(error) }));

  // Raw IPs so a DNS problem cannot masquerade as a routing problem. 1.1.1.1 and
  // 8.8.8.8 are neutral; the provider IP shows whether the block is destination
  // specific, and port 80 shows whether only 443 is filtered.
  const matrixTargets: Array<[string, number]> = [
    ["1.1.1.1", 443],
    ["1.1.1.1", 80],
    ["8.8.8.8", 53],
    ["213.176.6.243", 443],
    ["213.176.6.243", 80],
    ["140.82.121.6", 443],
  ];

  const hostnames = [...new Set(selected.map((target) => new URL(target.url).hostname))];

  const [networkMode, results, egress, addressChecks] = await Promise.all([
    withBudget(networkModePromise, 4000, { error: "timeout" } as Record<string, unknown>),
    Promise.all(selected.map((target) => withBudget(probeTarget(target), 16000, { label: target.label, hostname: new URL(target.url).hostname, probes: [] }))),
    Promise.all([
      ...matrixTargets.map(([host, port]) => probeTcp(host, port, 4000).then((probe) => ({ ...probe, step: `port ${host}:${port}` }))),
      probePlainHttp("http://example.com/"),
    ]),
    Promise.all(
      hostnames.map((hostname) =>
        withBudget(
          inspectAddresses(hostname).then((report) => ({ hostname, report, conclusion: addressConclusion(report) })),
          12000,
          { hostname, report: { error: "timeout" } as unknown, conclusion: "بررسی آدرس‌ها در زمان مجاز تمام نشد." },
        ),
      ),
    ),
  ]);

  const anyOpen = egress.some((probe) => probe.ok);
  const egressConclusion = anyOpen
    ? "حداقل یک مسیر خروجی باز است؛ می‌توان ترافیک AI را از همان پورت عبور داد."
    : "هیچ اتصال خروجی روی پورت‌های آزمایش‌شده برقرار نشد؛ سرور به‌کلی خروجی ندارد و این باید از طرف هاستینگ/فایروال سرور باز شود. هیچ کلید یا تنظیمی در برنامه این را حل نمی‌کند.";

  // The first failing layer is the actionable one.
  const firstFailure = results
    .flatMap((entry) => entry.probes.map((probe) => ({ label: entry.label, hostname: entry.hostname, probe })))
    .find((entry) => !entry.probe.ok && !entry.probe.skipped);

  const resolverHint = addressChecks
    .map((check) => check.conclusion)
    .filter((conclusion) => conclusion && !conclusion.includes("کامل قابل دسترسی"))
    .join(" | ");

  return NextResponse.json({
    // Lets the operator confirm the deploy actually took effect: if this marker
    // is missing, the browser is talking to an older build.
    diagnosticsVersion: "v7",
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    runtimeVersion: process.version,
    platform: process.platform,
    networkMode,
    egress,
    egressConclusion,
    addressChecks,
    results,
    conclusion: firstFailure
      ? `اولین لایهٔ ناموفق برای ${firstFailure.label} (${firstFailure.hostname}): ${firstFailure.probe.step} — ${firstFailure.probe.detail}${resolverHint ? `. ${resolverHint}` : ""}`
      : "همهٔ لایه‌ها تا HTTP سالم هستند.",
  });
}
