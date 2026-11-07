import type { KayaEgressConfig } from "./kaya-egress";
import { DEFAULT_KAYA_EGRESS } from "./kaya-egress";

// Reads and writes the one Kaya egress row.
//
// Kept separate from the module that builds the socket options so the panel can
// show the setting without importing anything that opens connections.

interface EgressRow {
  bind_address: string;
  host: string;
  updated_at: string;
}

export interface KayaEgressStatus extends KayaEgressConfig {
  updatedAt?: string;
  /** True when the saved address is not on this machine, so the panel can warn. */
  addressMissing: boolean;
}

export async function getKayaEgress(): Promise<KayaEgressStatus> {
  const { getDb } = await import("./db");
  const row = getDb().prepare("SELECT bind_address, host, updated_at FROM kaya_egress WHERE id = 1").get() as EgressRow | undefined;
  const config: KayaEgressConfig = row
    ? { bindAddress: row.bind_address || "", host: row.host || "" }
    : { ...DEFAULT_KAYA_EGRESS };
  // A saved address that is not on this server can never work, and the operator
  // needs to know before a grading run fails, not after.
  let addressMissing = false;
  if (config.bindAddress) {
    const { networkInterfaces } = await import("node:os");
    const local = new Set<string>();
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) if (address.family === "IPv4") local.add(address.address);
    }
    addressMissing = !local.has(config.bindAddress);
  }
  return { ...config, updatedAt: row?.updated_at, addressMissing };
}

export async function saveKayaEgress(input: KayaEgressConfig, userId: string): Promise<KayaEgressStatus> {
  const bindAddress = (input.bindAddress || "").trim();
  const host = (input.host || "").trim().replace(/\/+$/, "");
  if (bindAddress && !/^\d{1,3}(\.\d{1,3}){3}$/.test(bindAddress)) {
    throw new Error("آدرس خروجی باید یک IPv4 باشد، مثل 185.192.112.49");
  }
  if (host && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(host) && !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    throw new Error("میزبان باید یک دامنه یا نشانی https باشد.");
  }
  const { getDb } = await import("./db");
  getDb()
    .prepare(
      `INSERT INTO kaya_egress (id, bind_address, host, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET bind_address=excluded.bind_address, host=excluded.host,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    )
    .run(bindAddress, host, new Date().toISOString(), userId);
  // A changed setting must not keep reusing a pooled connection from the old one.
  const { closeKayaAgent } = await import("./kaya-egress");
  closeKayaAgent();
  return getKayaEgress();
}
