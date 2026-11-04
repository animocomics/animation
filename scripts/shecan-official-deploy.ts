import { createRequire } from "node:module";
import {
  getOfficialRuntimeStatus,
  restartOfficialRuntime,
  startOfficialRuntime,
  stopOfficialRuntime,
} from "../lib/server/shecan-runtime";
import { isWindowsRuntimeInstalled } from "../lib/server/shecan-windows-runtime";
import { activateOfficialShecanFromStoredLink, getApiNetworkStatus } from "../lib/server/api-network";

const require = createRequire(import.meta.url);
const {
  commitHeadlessRuntime,
  prepareOfficialHeadlessRuntime,
  rollbackHeadlessRuntime,
} = require("./shecan-vm/patch-official-runtime.cjs") as {
  commitHeadlessRuntime(transaction: RuntimeTransaction): void;
  prepareOfficialHeadlessRuntime(): Promise<RuntimeTransaction>;
  rollbackHeadlessRuntime(transaction: RuntimeTransaction): void;
};

interface RuntimeTransaction {
  patched: boolean;
  installed: boolean;
  root: string;
  backup: string;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForOfficialRuntime() {
  const deadline = Date.now() + 240_000;
  let lastStage = "";
  let runtime = getOfficialRuntimeStatus();
  while (Date.now() < deadline) {
    runtime = getOfficialRuntimeStatus();
    const stage = runtime.markers.at(-1)?.replace(/ /g, "_");
    if (stage && stage !== lastStage) {
      lastStage = stage;
      console.log(`NOMREH_OFFICIAL_BOOT_STAGE ${stage}`);
    }
    if (runtime.appReady && runtime.brokerReady && runtime.phase !== "error") return runtime;
    if (runtime.phase === "error") {
      throw new Error(`The patched official guest entered its sanitized error state (${runtime.errorCode || stage || "UNKNOWN_GUEST_ERROR"})`);
    }
    await delay(2000);
  }
  throw new Error(`The patched official guest did not become app/broker ready in four minutes (last_stage=${lastStage || "NONE"}, running=${runtime.running ? "yes" : "no"}, supervisor=${runtime.supervisorRunning ? "yes" : "no"})`);
}

async function main() {
  const selected = await getApiNetworkStatus();
  const v2ray = await (await import("../lib/server/v2ray-runtime")).getV2RayStatus();
  const explicitlyDisabled = !selected.enabled && selected.lastTestStatus !== "error";
  if (!selected.configured || selected.transport !== "official-vm" || explicitlyDisabled || v2ray.enabled || v2ray.pending) {
    console.log("NOMREH_OFFICIAL_DEPLOY_SKIPPED manager_selection_unchanged");
    return;
  }
  const windows = isWindowsRuntimeInstalled();
  const transaction = windows ? null : await prepareOfficialHeadlessRuntime();
  if (!windows && !transaction?.installed) {
    throw new Error("Official Shecan mode is selected but its verified runtime is not installed; no AI route was enabled");
  }
  try {
    if (windows) {
      // The Windows supervisor owns the genuine app, CDP viewer and Bun broker;
      // no initramfs patch, QEMU boot or noVNC validation is involved.
      await startOfficialRuntime();
    } else if (transaction?.patched) {
      // Validate exactly one patched legacy boot while its watchdog is suspended.
      await restartOfficialRuntime({ supervise: false });
    } else {
      await startOfficialRuntime({ supervise: false });
    }
    await waitForOfficialRuntime();
  } catch (error) {
    if (!windows && transaction?.patched) {
      await stopOfficialRuntime().catch(() => undefined);
      rollbackHeadlessRuntime(transaction);
      await startOfficialRuntime().catch(() => undefined);
    }
    throw error;
  }
  if (transaction) commitHeadlessRuntime(transaction);
  // Resume always-on supervision only after the real runtime has passed.
  await startOfficialRuntime();
  console.log(`NOMREH_OFFICIAL_APP_READY transport=${windows ? "windows-cdp" : "headless"} vnc_required=no`);

  const status = await activateOfficialShecanFromStoredLink();
  if (status.transport !== "official-vm") {
    console.log("NOMREH_OFFICIAL_ACTIVATION_SKIPPED manager_selected_other_transport");
    return;
  }
  if (!status.hasUpdateUrl) {
    console.log("NOMREH_OFFICIAL_ACTIVATION_SKIPPED no_stored_update_link");
    return;
  }
  if (!status.enabled || status.lastTestStatus !== "success") {
    throw new Error("The real official-guest Gemini check did not pass; AI routing remains disabled");
  }
  console.log(`NOMREH_OFFICIAL_AI_ACTIVE provider=gemini transport=official-vm latency_ms=${status.lastTestLatencyMs ?? "unknown"}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Official Shecan deployment failed";
  const safe = message.replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 400);
  console.error(`NOMREH_OFFICIAL_DEPLOY_ERROR ${safe}`);
  process.exitCode = 1;
});
