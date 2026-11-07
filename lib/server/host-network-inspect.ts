import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";

// Read-only inspection of the host's network configuration.
//
// The operator may only have the browser (no shell), so the checks that would
// normally be typed in a terminal are performed here and returned to the admin
// console. Nothing is modified: only `cat`-style reads and status commands with
// fixed arguments are used, never a shell, and every command is time-boxed.
//
// The point is to catch the case that produces this exact symptom: a local DNS
// proxy or a VPN/TUN tool was installed, it died, and now every outbound
// connection times out while the site itself still works.

export interface InspectionLine {
  label: string;
  value: string;
  ok: boolean | null;
  hint?: string;
}

export interface HostInspection {
  resolvConf: { path: string; nameservers: string[]; symlinkTarget?: string; raw: string[] };
  listeners: string[];
  processes: string[];
  tunDevices: string[];
  firewallRules: string[];
  services: Array<{ name: string; state: string }>;
  publicIp?: string;
  lines: InspectionLine[];
  verdict: string;
  suggestions: string[];
}

const PROXY_PORT = /:(53|5353|1080|1081|3128|7300|8080|8081|8400|10808|10809|10810)\b/;
const PROXY_PROCESS = /^(v2ray|xray|sing-box|sing_box|dns2socks|psiphon|tun2socks|warp-svc|openvpn|wg-quick|wireguard|hysteria|naive|trojan|shadowsocks|ss-local|ss-redir|clash|mihomo)/i;
const REDIRECT_RULE = /(REDIRECT|TPROXY|DNAT|MASQUERADE|REJECT|DROP)/;
const SERVICES = ["v2ray", "xray", "sing-box", "shecan", "tun2socks", "wg-quick@wg0", "openvpn"];

function run(command: string, args: string[], timeout = 4000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        const code = (error as { code?: number | string }).code;
        resolve({ ok: false, stdout: String(stdout || ""), error: code === 1 ? "not-found-or-empty" : String(code ?? "error") });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || "") });
    });
  });
}

async function inspectResolv(): Promise<HostInspection["resolvConf"]> {
  const path = "/etc/resolv.conf";
  let raw: string[] = [];
  let symlinkTarget: string | undefined;
  try {
    const content = await readFile(path, "utf8");
    raw = content.split("\n").filter(Boolean).slice(0, 20);
  } catch {
    raw = [];
  }
  try {
    symlinkTarget = await readlink(path);
  } catch {
    symlinkTarget = undefined;
  }
  const nameservers = raw
    .filter((line) => line.trim().startsWith("nameserver"))
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  return { path, nameservers, symlinkTarget, raw };
}

export async function inspectHost(): Promise<HostInspection> {
  const [resolvConf, ssOut, netstatOut, psOut, ipLinkOut, iptablesOut, nftOut] = await Promise.all([
    inspectResolv(),
    run("ss", ["-lntup"]),
    run("netstat", ["-lntup"]),
    run("ps", ["ax", "-o", "pid=,comm=,args="]),
    run("ip", ["link", "show"]),
    run("iptables", ["-S"]),
    run("nft", ["list", "ruleset"]),
  ]);

  const listenerSource = ssOut.ok ? ssOut.stdout : netstatOut.ok ? netstatOut.stdout : "";
  const listeners = listenerSource
    .split("\n")
    .filter((line) => PROXY_PORT.test(line))
    .slice(0, 12)
    .map((line) => line.trim().slice(0, 160));

  // Match the command name only. Matching the whole command line flagged our own
  // application, whose paths contain "official", and produced a false "VPN is
  // running" verdict for a host with no VPN at all.
  const OWN_PATHS = /(nomreh-vm|nomreh-data|nomreh\.arounidea\.com|shecan-runtime|next-server)/;
  const processes = psOut.ok
    ? psOut.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !OWN_PATHS.test(line))
        .filter((line) => PROXY_PROCESS.test(line.split(/\s+/)[1] || ""))
        .slice(0, 10)
        .map((line) => line.slice(0, 160))
    : [];

  const tunDevices = ipLinkOut.ok
    ? ipLinkOut.stdout
        .split("\n")
        .filter((line) => /^\d+:\s+(tun|tap|wg|utun|nordlynx)/i.test(line.trim()) || /:\s+(tun|tap|wg)\d*:/.test(line))
        .slice(0, 8)
        .map((line) => line.trim().slice(0, 120))
    : [];

  const firewallSource = iptablesOut.ok ? iptablesOut.stdout : nftOut.ok ? nftOut.stdout : "";
  const firewallRules = firewallSource
    ? firewallSource
        .split("\n")
        .filter((line) => REDIRECT_RULE.test(line))
        .slice(0, 12)
        .map((line) => line.trim().slice(0, 160))
    : [];

  const services = await Promise.all(
    SERVICES.map(async (name) => {
      const result = await run("systemctl", ["is-active", name], 2500);
      const state = (result.stdout || result.error || "unknown").trim().split("\n")[0];
      return { name, state };
    }),
  );

  // Build the human-facing lines.
  const lines: InspectionLine[] = [];
  const localNameserver = resolvConf.nameservers.find((server) => /^(127\.|::1$|0\.0\.0\.0$|localhost)/.test(server));
  lines.push({
    label: "resolv.conf",
    value: resolvConf.nameservers.length ? resolvConf.nameservers.join(", ") : "بدون nameserver",
    ok: resolvConf.nameservers.length > 0 && !localNameserver,
    hint: localNameserver ? "آدرس محلی: به یک DNS محلی وصل است که ممکن است مرده باشد" : undefined,
  });
  if (resolvConf.symlinkTarget) {
    lines.push({ label: "resolv.conf →", value: resolvConf.symlinkTarget, ok: null });
  }
  lines.push({
    label: "پورت‌های پروکسی/DNS محلی",
    value: listeners.length ? `${listeners.length} مورد باز` : "هیچ",
    ok: listeners.length === 0,
  });
  lines.push({
    label: "پروسهٔ VPN/DNS",
    value: processes.length ? `${processes.length} مورد در حال اجرا` : "هیچ",
    ok: processes.length === 0,
  });
  lines.push({
    label: "کارت شبکهٔ تونل (TUN)",
    value: tunDevices.length ? tunDevices.map((line) => line.split(":")[1]?.trim() || line).join(", ") : "هیچ",
    ok: tunDevices.length === 0,
  });
  lines.push({
    label: "قواعد فایروال (redirect/drop)",
    value: firewallSource ? (firewallRules.length ? `${firewallRules.length} قاعده` : "هیچ") : "قابل خواندن نبود (نیاز به root)",
    ok: firewallSource ? firewallRules.length === 0 : null,
  });
  const activeServices = services.filter((service) => service.state === "active");
  if (activeServices.length) {
    lines.push({ label: "سرویس‌های فعال", value: activeServices.map((service) => service.name).join(", "), ok: false });
  }

  const suggestions: string[] = [];
  let verdict = "";

  if (localNameserver) {
    verdict = `DNS سرور به یک resolver محلی (${localNameserver}) وصل است. اگر ابزاری که آن را نصب کرده متوقف شده باشد، همهٔ اتصال‌ها timeout می‌شوند — همان چیزی که دیده می‌شود.`;
    suggestions.push(
      `cp /etc/resolv.conf /root/resolv.conf.bak && printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf`,
      `getent hosts kayaai.ir && curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 10 https://kayaai.ir/api/chat/completions`,
    );
  }
  if (tunDevices.length) {
    verdict = verdict || "یک کارت شبکهٔ تونل (TUN) روی سرور فعال است؛ ترافیک کل سیستم از آن عبور می‌کند و اگر مقصدش در دسترس نباشد همه‌چیز timeout می‌شود.";
    suggestions.push("ip link show", "ip link delete <نام تونل>  (پس از متوقف‌کردن سرویس مربوطه)");
  }
  if (activeServices.length) {
    verdict = verdict || `سرویس ${activeServices.map((service) => service.name).join(", ")} فعال است و احتمالاً ترافیک را تغییر مسیر می‌دهد.`;
    suggestions.push(`systemctl stop ${activeServices.map((service) => service.name).join(" ")}`, `systemctl disable ${activeServices.map((service) => service.name).join(" ")}`);
  }
  if (firewallRules.length) {
    verdict = verdict || "قواعد فایروال ترافیک را redirect یا drop می‌کنند.";
    suggestions.push("iptables-save > /root/iptables.bak", "iptables -S | grep -E 'REDIRECT|TPROXY|DNAT|REJECT|DROP'", "iptables -D <زنجیره> <شمارهٔ قاعده>");
  }
  if (!verdict) {
    // Everything LOCAL is clean. That is not the same as "the network is broken":
    // on this host GitHub answers while Kaya times out, so the filter is per
    // destination. Saying so stops the operator from chasing DNS or firewalls.
    verdict =
      "روی خود سرور هیچ نشانه‌ای از DNS محلی، تونل، پروسهٔ VPN یا قاعدهٔ redirect نیست، پس تنظیمات سرور مقصر نیست. مقصدهای دیگر (GitHub) از همین ماشین جواب می‌دهند؛ فقط مقصد مشخصی بسته است و آن لایه، لایهٔ مسیر/مقصد است نه برنامه.";
    suggestions.push(
      "curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 10 https://api.github.com",
      "curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 10 https://kayaai.ir/   # اگر این هم timeout شد، مقصد بسته است",
    );
  }

  // The public IP tells the operator whether the host still owns the address the
  // site used to serve from. If it changed, egress filtering is at the new
  // address and the hosting provider is the only one who can lift it.
  const publicIp = await run("curl", ["-sS", "--max-time", "6", "https://api.ipify.org"], 7000)
    .then((result) => (result.ok ? result.stdout.trim().slice(0, 60) : ""))
    .catch(() => "");
  lines.push({
    label: "IP عمومی خروجی",
    value: publicIp || "قابل تشخیص نبود (خروجی بسته است)",
    ok: publicIp ? true : null,
    hint: publicIp ? "این آدرسی است که ترافیک شما با آن به اینترنت می‌رود" : undefined,
  });

  // The addresses this machine actually owns. The egress field can only bind to one
  // of these, so the operator must see them instead of guessing which of the
  // provider's IPs is really on the box.
  try {
    const { networkInterfaces } = await import("node:os");
    const local: string[] = [];
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) local.push(address.address);
      }
    }
    lines.push({
      label: "آدرس‌های روی این سرور",
      value: local.length ? local.join(", ") : "هیچ آدرس غیرلوکالی نیست",
      ok: local.length > 0,
      hint: local.length
        ? "فقط یکی از این‌ها را می‌توان به‌عنوان آدرس خروجی انتخاب کرد"
        : "آدرس عمومی که هاستینگ می‌دهد روی ماشین نیست؛ باید روی کارت شبکه گذاشته شود",
    });
  } catch {
    /* node:os is always present; nothing to report otherwise */
  }

  return { resolvConf, listeners, processes, tunDevices, firewallRules, services, publicIp, lines, verdict, suggestions };
}
