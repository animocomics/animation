import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseV2RayConfig, parseV2RayConfigList } from "../lib/server/v2ray-config";

const vless = "vless://00000000-0000-4000-8000-000000000001@192.0.2.10:19226?security=reality&amp;encryption=none&amp;pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&amp;headerType=none&amp;fp=chrome&amp;type=tcp&amp;flow=xtls-rprx-vision&amp;sni=example.com&amp;sid=7c#public-example";
const shadowsocks = "ss://YWVzLTI1Ni1nY206dGVzdC1wYXNzd29yZA@192.0.2.20:19999#public-example";

test("VLESS REALITY Vision and SIP002 Shadowsocks are converted to scoped Xray outbounds", () => {
  const parsedVless = parseV2RayConfig(vless);
  assert.equal(parsedVless.protocol, "vless");
  assert.equal(parsedVless.outbound.protocol, "vless");
  const vnext = (parsedVless.outbound.settings as { vnext: Array<Record<string, unknown>> }).vnext[0];
  assert.equal(vnext.address, "192.0.2.10");
  assert.equal(vnext.port, 19226);
  const stream = parsedVless.outbound.streamSettings as { security: string; realitySettings: Record<string, unknown> };
  assert.equal(stream.security, "reality");
  assert.equal(stream.realitySettings.serverName, "example.com");
  assert.equal(stream.realitySettings.shortId, "7c");
  const parsedSs = parseV2RayConfig(shadowsocks);
  assert.equal(parsedSs.protocol, "ss");
  const server = (parsedSs.outbound.settings as { servers: Array<Record<string, unknown>> }).servers[0];
  assert.equal(server.address, "192.0.2.20");
  assert.equal(server.method, "aes-256-gcm");
  assert.equal(server.port, 19999);
  assert.ok(!JSON.stringify(parsedSs).includes("YFZ"));
});

test("bulk parsing is bounded and removes duplicate server configurations", () => {
  const list = parseV2RayConfigList(`${vless}\n${vless.replace("public-example", "another-name")}\n${shadowsocks}`);
  assert.equal(list.length, 2);
  assert.throws(() => parseV2RayConfigList("https://example.com/not-a-v2ray-config"), /هیچ کانفیگ/);
  assert.throws(() => parseV2RayConfig("vless://not-a-uuid@192.0.2.1:443?security=reality"), /UUID/);
});

test("saved pool is encrypted and public status contains no endpoint or credential material", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nomreh-v2ray-pool-"));
  process.env.NOMREH_DATA_DIR = directory;
  process.env.NOMREH_SECRET_KEY = "v2ray-test-secret-with-enough-entropy";
  try {
    const { saveV2RayConfigs, getV2RayStatus, getV2RayNetworkConfig } = await import("../lib/server/v2ray-runtime");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get() as { id: string };
    await saveV2RayConfigs(`${vless}\n${shadowsocks}`, admin.id);
    const status = await getV2RayStatus();
    assert.equal(status.configured, true);
    assert.equal(status.enabled, false);
    assert.equal(status.configs.length, 2);
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes("192.0.2.10"));
    assert.ok(!serialized.includes("00000000"));
    assert.ok(!serialized.includes("YWVzLTI1"));
    const raw = getDb().prepare("SELECT encrypted_config FROM v2ray_configs").all() as Array<{ encrypted_config: string }>;
    assert.equal(raw.length, 2);
    assert.ok(raw.every((row) => !row.encrypted_config.includes("vless://") && !row.encrypted_config.includes("ss://")));
    assert.equal(await getV2RayNetworkConfig(), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("V2Ray response-body reads honor the same bounded abort as the probe", async () => {
  const { boundedResponseText } = await import("../lib/server/v2ray-runtime");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"models\":[]}"));
      // Deliberately never close: a blackhole or broken proxy must not hang activation.
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("test timeout");
    error.name = "TimeoutError";
    controller.abort(error);
  }, 40);
  try {
    await assert.rejects(
      boundedResponseText(new Response(stream, { status: 200 }), 1000, controller.signal),
      (error: unknown) => error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name),
    );
  } finally {
    clearTimeout(timer);
  }
});

test("V2Ray rejects non-provider URLs before creating any proxy runtime", async () => {
  const { v2rayProviderFetch } = await import("../lib/server/v2ray-runtime");
  await assert.rejects(v2rayProviderFetch("https://example.com/private"), (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400);
  await assert.rejects(v2rayProviderFetch("http://generativelanguage.googleapis.com/v1beta/models"), (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400);
});
