#!/usr/bin/env node
"use strict";

// Stops the official Shecan guest and keeps it stopped across restarts.
//
//   npm run shecan:off
//   npm run shecan:on     # undo, when the guest is wanted again
//
// Why this is needed: the app treats an application restart as a request for
// always-on service, so it clears its own stop marker and relaunches the watchdog.
// That is correct for the delivered product but it means "Stop the guest" from the
// panel silently comes back after every Restart App. While the host's egress keeps
// being blocked, the guest is one more moving part nobody needs, so this sets the
// documented opt-out instead of editing scripts by hand.
//
// It changes only Nomreh's own markers and reports. It does not touch the database,
// the provider secret, .env, user uploads or any other domain.

const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.NOMREH_DATA_DIR
  ? path.resolve(process.env.NOMREH_DATA_DIR)
  : path.resolve(APP_ROOT, "..", "nomreh-data");
const SHECAN_DIR = path.join(DATA_DIR, "shecan-official");
const STOP_MARKER = path.join(SHECAN_DIR, "stop-requested");
const OFF_MARKER = path.join(DATA_DIR, "shecan-disabled-by-operator");

function log(message) {
  console.log(message);
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function disable() {
  log(`Nomreh — disable the official Shecan guest`);
  log(`data dir: ${DATA_DIR}`);

  // 1. the marker the runtime itself honours
  writeAtomic(STOP_MARKER, new Date().toISOString());
  log(`  stop marker written: ${STOP_MARKER}`);

  // 2. an explicit operator marker so the intent survives and is visible
  writeAtomic(
    OFF_MARKER,
    JSON.stringify(
      {
        disabledAt: new Date().toISOString(),
        reason:
          "Disabled from the Plesk Node console. The guest is not needed for direct provider access and only adds a moving part while egress is blocked.",
        reEnable: "npm run shecan:on",
      },
      null,
      2,
    ),
  );
  log(`  operator marker written: ${OFF_MARKER}`);

  // 3. report where the opt-out belongs. We do not edit the application scripts:
  //    the marker above is the documented switch and editing files is what broke
  //    this deployment before.
  log("");
  log("  To make the opt-out permanent, set this environment variable in Plesk");
  log("  (Websites & Domains → Node.js → Custom environment variables):");
  log("      NOMREH_DISABLE_SHECAN_SUPERVISOR = 1");
  log("");
  log("  Then restart the application. With that variable set, neither the Windows");
  log("  nor the Linux supervisor is started, and the panel's Shecan section stays");
  log("  dormant instead of relaunching a guest that cannot help.");
  log("NOMREH_SHECAN_DISABLED");
}

function enable() {
  log("Nomreh — re-enable the official Shecan guest");
  for (const [label, file] of [["stop marker", STOP_MARKER], ["operator marker", OFF_MARKER]]) {
    try {
      fs.unlinkSync(file);
      log(`  removed ${label}`);
    } catch {
      log(`  ${label} was already absent`);
    }
  }
  log("");
  log("  Also remove NOMREH_DISABLE_SHECAN_SUPERVISOR from the Node.js environment");
  log("  variables in Plesk, then restart the application.");
  log("NOMREH_SHECAN_ENABLED");
}

const mode = process.argv.includes("--on") ? "on" : "off";
try {
  if (mode === "on") enable();
  else disable();
} catch (error) {
  log(`NOMREH_SHECAN_FAILED ${String(error && error.message ? error.message : error).slice(0, 200)}`);
  process.exitCode = 1;
}
