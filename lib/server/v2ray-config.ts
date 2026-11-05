export type V2RayProtocol = "vless" | "vmess" | "trojan" | "ss";

export interface ParsedV2RayConfig {
  protocol: V2RayProtocol;
  normalized: string;
  outbound: Record<string, unknown>;
}

const MAX_CONFIG_LENGTH = 16_384;
const VALID_PROTOCOLS = new Set(["vless", "vmess", "trojan", "ss"]);

function fail(message: string): never {
  throw new Error(message);
}

function cleanLine(value: string): string {
  return value.trim()
    .replace(/&amp;/gi, "&")
    // Accept links copied from Markdown-enabled chat without ever retaining
    // the Markdown destination as part of the Xray endpoint.
    .replace(/\[([^\]]+)\]\((?:mailto:|https?:\/\/)[^)]+\)/gi, "$1");
}

function safeText(value: unknown, maximum = 512): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function required(value: unknown, message: string): string {
  const text = safeText(value, 16_384);
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) fail(message);
  return text;
}

function decodePart(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return fail("کانفیگ دارای کدگذاری نامعتبر است."); }
}

function decodeBase64(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (!compact || compact.length > 16_384 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) fail("بخش Base64 کانفیگ معتبر نیست.");
  try {
    const result = Buffer.from(compact, "base64url").toString("utf8");
    if (!result || result.includes("\ufffd")) fail("Base64 کانفیگ قابل خواندن نیست.");
    return result;
  } catch { return fail("Base64 کانفیگ قابل خواندن نیست."); }
}

function serverAddress(url: URL): { address: string; port: number } {
  const address = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const port = Number(url.port);
  if (!address || address.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail("آدرس یا پورت سرور کانفیگ معتبر نیست.");
  }
  if (url.username.includes("%2f") || url.password.includes("%2f")) fail("فرمت اطلاعات ورود کانفیگ معتبر نیست.");
  return { address, port };
}

function streamSettings(url: URL, defaultSecurity = "none"): Record<string, unknown> {
  const query = url.searchParams;
  const network = query.get("type") || "tcp";
  if (!["tcp", "ws", "grpc", "httpupgrade", "xhttp"].includes(network)) fail(`نوع انتقال ${network || "نامشخص"} پشتیبانی نمی‌شود؛ TCP، WebSocket، gRPC، HTTPUpgrade و XHTTP وارد کنید.`);
  const security = (query.get("security") || defaultSecurity).toLowerCase();
  if (!["none", "tls", "reality"].includes(security)) fail("نوع امنیت کانفیگ باید none، tls یا reality باشد.");
  const result: Record<string, unknown> = { network, security };
  const sni = safeText(query.get("sni"), 253);
  const fingerprint = safeText(query.get("fp"), 40) || "chrome";
  const alpn = safeText(query.get("alpn"), 200);
  if (security === "reality") {
    const publicKey = required(query.get("pbk"), "کانفیگ REALITY بدون pbk معتبر نیست.");
    if (!/^[A-Za-z0-9_-]{20,160}$/.test(publicKey)) fail("مقدار pbk در کانفیگ REALITY معتبر نیست.");
    const shortId = safeText(query.get("sid"), 64);
    if (shortId && !/^[a-fA-F0-9]{2,64}$/.test(shortId)) fail("مقدار sid در کانفیگ REALITY معتبر نیست.");
    result.realitySettings = {
      serverName: sni || url.hostname,
      publicKey,
      shortId,
      fingerprint,
      spiderX: safeText(query.get("spx"), 300) || "/",
    };
  } else if (security === "tls") {
    result.tlsSettings = {
      serverName: sni || safeText(query.get("host"), 253) || url.hostname,
      fingerprint,
      ...(alpn ? { alpn: alpn.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 8) } : {}),
    };
  }
  if (network === "tcp") {
    const headerType = query.get("headerType") || "none";
    if (!["none", "http"].includes(headerType)) fail("TCP headerType باید none یا http باشد.");
    result.tcpSettings = { header: { type: headerType } };
  } else if (network === "ws") {
    result.wsSettings = {
      path: safeText(query.get("path"), 2048) || "/",
      headers: { Host: safeText(query.get("host"), 253) || sni || url.hostname },
    };
  } else if (network === "grpc") {
    result.grpcSettings = {
      serviceName: safeText(query.get("serviceName"), 512),
      ...(safeText(query.get("authority"), 253) ? { authority: safeText(query.get("authority"), 253) } : {}),
    };
  } else if (network === "httpupgrade") {
    result.httpupgradeSettings = {
      path: safeText(query.get("path"), 2048) || "/",
      host: safeText(query.get("host"), 253) || sni || url.hostname,
    };
  } else {
    const mode = safeText(query.get("mode"), 30) || "auto";
    if (!["auto", "packet-up", "stream-up", "stream-one"].includes(mode)) fail("مقدار mode در XHTTP معتبر نیست.");
    let extra: Record<string, unknown> | undefined;
    const rawExtra = safeText(query.get("extra"), 4096);
    if (rawExtra) {
      try {
        const parsed = JSON.parse(rawExtra) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("extra در XHTTP باید JSON object باشد.");
        extra = parsed as Record<string, unknown>;
      } catch (error) {
        if (error instanceof Error && error.message.includes("JSON object")) throw error;
        fail("extra در XHTTP دارای JSON نامعتبر است.");
      }
    }
    result.xhttpSettings = {
      path: safeText(query.get("path"), 2048) || "/",
      host: safeText(query.get("host"), 253) || sni || url.hostname,
      mode,
      ...(extra ? { extra } : {}),
    };
  }
  return result;
}

function parseVless(line: string): ParsedV2RayConfig {
  const url = new URL(line);
  const { address, port } = serverAddress(url);
  const id = decodePart(url.username);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) fail("UUID کانفیگ VLESS معتبر نیست.");
  const encryption = safeText(url.searchParams.get("encryption"), 512) || "none";
  if (!/^(?:none|mlkem768x25519plus\.[A-Za-z0-9._-]{3,500})$/.test(encryption)) fail("رمزنگاری VLESS معتبر نیست.");
  const flow = safeText(url.searchParams.get("flow"), 80);
  if (flow && !/^[A-Za-z0-9-]{3,80}$/.test(flow)) fail("مقدار flow در VLESS معتبر نیست.");
  return {
    protocol: "vless",
    normalized: line,
    outbound: {
      protocol: "vless",
      settings: { vnext: [{ address, port, users: [{ id, encryption, ...(flow ? { flow } : {}) }] }] },
      streamSettings: streamSettings(url),
    },
  };
}

function parseVmess(line: string): ParsedV2RayConfig {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(decodeBase64(line.slice("vmess://".length))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("JSON کانفیگ VMess معتبر نیست.");
    value = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && !/JSON|Base64/.test(error.message)) throw error;
    return fail("JSON کانفیگ VMess معتبر نیست.");
  }
  const address = required(value.add, "آدرس سرور VMess خالی است.");
  const port = Number(value.port);
  const id = required(value.id, "UUID کانفیگ VMess خالی است.");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9-]{36}$/i.test(id)) fail("پورت یا UUID کانفیگ VMess معتبر نیست.");
  const params = new URLSearchParams();
  for (const key of ["net", "type", "security", "tls", "sni", "host", "path", "fp", "alpn", "serviceName", "authority", "pbk", "sid", "spx", "flow"]) {
    const raw = value[key];
    if (typeof raw === "string" && raw && !(key === "type" && raw === "none")) params.set(key, raw);
  }
  if (!params.has("type")) params.set("type", safeText(value.net, 30) || "tcp");
  if (!params.has("security")) params.set("security", safeText(value.tls, 20) || "none");
  const streamUrl = new URL(`vless://unused@localhost:443?${params.toString()}`);
  return {
    protocol: "vmess",
    normalized: line,
    outbound: {
      protocol: "vmess",
      settings: { vnext: [{ address, port, users: [{ id, alterId: Math.max(0, Math.min(65535, Number(value.aid) || 0)), security: safeText(value.scy, 30) || "auto" }] }] },
      streamSettings: streamSettings(streamUrl),
    },
  };
}

function parseTrojan(line: string): ParsedV2RayConfig {
  const url = new URL(line);
  const { address, port } = serverAddress(url);
  const password = decodePart(url.username);
  if (!password || password.length > 2048) fail("رمز کانفیگ Trojan معتبر نیست.");
  return {
    protocol: "trojan",
    normalized: line,
    outbound: {
      protocol: "trojan",
      settings: { servers: [{ address, port, password }] },
      streamSettings: streamSettings(url, "tls"),
    },
  };
}

function parseShadowsocks(line: string): ParsedV2RayConfig {
  if (new URL(line).searchParams.get("plugin")) fail("Shadowsocks دارای plugin باید بدون plugin یا با کانفیگ جداگانه وارد شود.");
  const url = new URL(line);
  const { address, port } = serverAddress(url);
  const encodedUser = decodePart(url.username);
  let method = "";
  let password = "";
  const decoded = encodedUser.includes(":") ? encodedUser : decodeBase64(encodedUser);
  const separator = decoded.indexOf(":");
  if (separator > 0) {
    method = decoded.slice(0, separator);
    password = decoded.slice(separator + 1);
  } else if (url.password) {
    method = encodedUser;
    password = decodePart(url.password);
  }
  if (!/^[A-Za-z0-9_-]{2,80}$/.test(method) || !password || password.length > 2048) fail("روش یا رمز Shadowsocks معتبر نیست.");
  const supported = new Set(["aes-128-gcm", "aes-256-gcm", "chacha20-poly1305", "chacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"]);
  if (!supported.has(method)) fail(`روش Shadowsocks (${method}) توسط هستهٔ امن این بخش پشتیبانی نمی‌شود.`);
  return {
    protocol: "ss",
    normalized: line,
    outbound: {
      protocol: "shadowsocks",
      settings: { servers: [{ address, port, method, password }] },
      streamSettings: { network: "tcp", security: "none", tcpSettings: { header: { type: "none" } } },
    },
  };
}

export function parseV2RayConfig(input: string): ParsedV2RayConfig {
  const line = cleanLine(input);
  if (!line || line.length > MAX_CONFIG_LENGTH) fail("طول کانفیگ بیش از حد مجاز است.");
  const scheme = line.split(":", 1)[0]?.toLowerCase() || "";
  if (!VALID_PROTOCOLS.has(scheme)) fail("فقط کانفیگ‌های vless://، vmess://، trojan:// و ss:// پذیرفته می‌شوند.");
  try {
    if (scheme === "vless") return parseVless(line);
    if (scheme === "vmess") return parseVmess(line);
    if (scheme === "trojan") return parseTrojan(line);
    return parseShadowsocks(line);
  } catch (error) {
    if (error instanceof TypeError) fail("ساختار کانفیگ یا آدرس آن معتبر نیست.");
    throw error;
  }
}

export interface ParsedV2RayConfigList {
  configs: ParsedV2RayConfig[];
  rejected: number;
  overflow: number;
  total: number;
}

export function parseV2RayConfigListDetailed(input: string, maximum = 60): ParsedV2RayConfigList {
  const text = input.trim();
  if (!text) fail("حداقل یک کانفیگ V2Ray وارد کنید.");
  if (text.length > 600_000) fail("حجم فهرست کانفیگ‌ها بیش از ۶۰۰ هزار نویسه است.");
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length || lines.length > 200) fail("فهرست کانفیگ‌ها باید بین ۱ تا ۲۰۰ خط باشد.");
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) fail("حداکثر کانفیگ معتبر نیست.");
  const configs: ParsedV2RayConfig[] = [];
  const fingerprints = new Set<string>();
  let rejected = 0;
  let overflow = 0;
  for (const line of lines) {
    let item: ParsedV2RayConfig;
    try { item = parseV2RayConfig(line); }
    catch { rejected += 1; continue; }
    const fingerprint = JSON.stringify(item.outbound);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    if (configs.length >= maximum) { overflow += 1; continue; }
    configs.push(item);
  }
  if (!configs.length) fail("هیچ کانفیگ پشتیبانی‌شده‌ای در فهرست پیدا نشد؛ خطاهای فرمت را بررسی کنید.");
  return { configs, rejected, overflow, total: lines.length };
}

export function parseV2RayConfigList(input: string, maximum = 60): ParsedV2RayConfig[] {
  return parseV2RayConfigListDetailed(input, maximum).configs;
}
