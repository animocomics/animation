"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { checkManifest } = require("./staged-host-probe.cjs");

function buildHostStageCommand(phase, manifest, nonce) {
  if (!/^(?:preflight-base-upload|extract-base|preflight-part-upload-00[0-2]|extract-part-00[0-2]|assemble)$/.test(phase)) throw new Error("Invalid staged probe phase");
  if (!/^[a-f0-9]{24}$/.test(nonce)) throw new Error("Invalid stage nonce");
  checkManifest(manifest);
  const packedScript = zlib.gzipSync(fs.readFileSync(path.join(__dirname, "staged-host-probe.cjs"))).toString("base64");
  const packedManifest = zlib.gzipSync(Buffer.from(JSON.stringify(manifest))).toString("base64");
  const prefix = `NOMREH_HOST_STAGE_${nonce}`;
  const source = `const z=require('zlib'),M=require('module');try{const m=new M('/tmp/nomreh-staged-probe.cjs');m.filename='/tmp/nomreh-staged-probe.cjs';m.paths=M._nodeModulePaths('/tmp');m._compile(z.gunzipSync(Buffer.from(${JSON.stringify(packedScript)},'base64')).toString(),'nomreh-staged-probe.cjs');const data=JSON.parse(z.gunzipSync(Buffer.from(${JSON.stringify(packedManifest)},'base64')).toString());const out=m.exports.installStage(data,${JSON.stringify(phase)},process.cwd());console.log(${JSON.stringify(prefix + '_PASS ')}+JSON.stringify(out))}catch(e){const msg=String(e.message||'FAILED');console.log(${JSON.stringify(prefix + '_FAIL ')}+(/[^A-Z_]/.test(msg)?'SYSTEM_ERROR':msg));process.exitCode=1}`;
  const command = `exec -- node -e ${JSON.stringify(source)}`;
  if (Buffer.byteLength(command) > 100000 || command.includes("$") || command.includes("`")) throw new Error("Staged command size or quoting check failed");
  return { command, prefix };
}
module.exports = { buildHostStageCommand };
