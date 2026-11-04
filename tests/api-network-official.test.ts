import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-official-network-"));
process.env.NOMREH_DATA_DIR = dataDirectory;
process.env.NOMREH_SECRET_KEY = "official-network-test-secret-with-enough-entropy";

test("stored-link official activation uses the guest activator, real provider-test seam, and encrypted persistence", async () => {
  const {
    activateOfficialShecanFromStoredLink,
    getApiNetworkConfig,
    getApiNetworkStatus,
    saveAndTestApiNetwork,
  } = await import("../lib/server/api-network");
  const { getDb } = await import("../lib/server/db");
  const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
  const updateUrl = "https://ddns.shecan.ir/update/stored-test-secret";
  await saveAndTestApiNetwork({ enabled: false, plan: "pro", servers: ["178.22.122.101", "185.51.200.1"], transport: "official-vm", updateUrl }, admin.id);
  const activations: string[] = [];
  let providerTransport = "";
  const status = await activateOfficialShecanFromStoredLink({
    activationSettleMs: 0,
    officialActivator: async (url, servers) => {
      activations.push(url);
      assert.deepEqual(servers, ["178.22.122.101", "185.51.200.1"]);
      return new Date().toISOString();
    },
    providerTester: async (network) => {
      providerTransport = network.transport || "";
      return 123;
    },
  });
  assert.deepEqual(activations, [updateUrl]);
  assert.equal(providerTransport, "official-vm");
  assert.equal(status.enabled, true);
  assert.equal(status.transport, "official-vm");
  assert.equal(status.lastTestStatus, "success");
  assert.equal(status.lastTestLatencyMs, 123);
  assert.ok(!JSON.stringify(status).includes("stored-test-secret"));
  assert.equal((await getApiNetworkConfig()).updateUrl, updateUrl);
  assert.equal((await getApiNetworkStatus()).hasUpdateUrl, true);
  const raw = getDb().prepare("SELECT encrypted_update_url FROM api_network_settings WHERE id=1").get() as { encrypted_update_url: string };
  assert.ok(!raw.encrypted_update_url.includes(updateUrl));

  await saveAndTestApiNetwork({ enabled: false, plan: "pro", servers: ["178.22.122.101", "185.51.200.1"], transport: "dns" }, admin.id);
  let unexpectedActivation = false;
  const preserved = await activateOfficialShecanFromStoredLink({
    officialActivator: async () => { unexpectedActivation = true; throw new Error("must not activate"); },
  });
  assert.equal(preserved.transport, "dns");
  assert.equal(unexpectedActivation, false, "deployment must not override the manager's selected transport");

  await saveAndTestApiNetwork({ enabled: false, plan: "pro", servers: ["178.22.122.101", "185.51.200.1"], transport: "official-vm" }, admin.id);
  getDb().prepare("INSERT INTO v2ray_settings (id,enabled,last_test_status,last_test_message,updated_at,updated_by) VALUES (1,1,'success','',?,?) ON CONFLICT(id) DO UPDATE SET enabled=1,last_test_status='success',updated_at=excluded.updated_at,updated_by=excluded.updated_by").run(new Date().toISOString(), admin.id);
  const guarded = await activateOfficialShecanFromStoredLink({
    officialActivator: async () => { unexpectedActivation = true; throw new Error("must not activate alongside V2Ray"); },
  });
  assert.equal(guarded.enabled, false);
  assert.equal(unexpectedActivation, false, "an active V2Ray selection must remain mutually exclusive");
});

test.after(() => {
  try { (globalThis as typeof globalThis & { __nomrehDatabase?: { close: () => void } }).__nomrehDatabase?.close(); } catch { /* already closed */ }
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});
