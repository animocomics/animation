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
  return value.trim().replace(/&amp;/gi, "&");
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
  if (!["tcp", "ws", "grpc", "httpupgrade"].includes(network)) fail(`نوع انتقال ${network || "نامشخص"} پشتیبانی نمی‌شود؛ TCP، WebSocket، gRPC و HTTPUpgrade وارد کنید.`);
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
    if (headerType !== "none") fail("فعلاً TCP headerType=none پشتیبانی می‌شود.");
    result.tcpSettings = { header: { type: "none" } };
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
  } else {
    result.httpupgradeSettings = {
      path: safeText(query.get("path"), 2048) || "/",
      host: safeText(query.get("host"), 253) || sni || url.hostname,
    };
  }
  return result;
}

function parseVless(line: string): ParsedV2RayConfig {
  const url = new URL(line);
  const { address, port } = serverAddress(url);
  const id = decodePart(url.username);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) fail("UUID کانفیگ VLESS معتبر نیست.");
  if ((url.searchParams.get("encryption") || "none") !== "none") fail("رمزنگاری VLESS باید none باشد.");
  const flow = safeText(url.searchParams.get("flow"), 80);
  if (flow && !/^[A-Za-z0-9-]{3,80}$/.test(flow)) fail("مقدار flow در VLESS معتبر نیست.");
  return {
    protocol: "vless",
    normalized: line,
    outbound: {
      protocol: "vless",
      settings: { vnext: [{ address, port, users: [{ id, encryption: "none", ...(flow ? { flow } : {}) }] }] },
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
    if (typeof raw === "string" && raw) params.set(key, raw);
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

export function parseV2RayConfigList(input: string, maximum = 40): ParsedV2RayConfig[] {
  const text = input.trim();
  if (!text) fail("حداقل یک کانفیگ V2Ray وارد کنید.");
  if (text.length > 600_000) fail("حجم فهرست کانفیگ‌ها بیش از ۶۰۰ هزار نویسه است.");
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length || lines.length > maximum) fail(`حداقل ۱ و حداکثر ${maximum} کانفیگ در هر فهرست وارد کنید.`);
  const parsed = lines.map(parseV2RayConfig);
  const fingerprints = new Set<string>();
  return parsed.filter((item) => {
    const fingerprint = JSON.stringify(item.outbound);
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
}
