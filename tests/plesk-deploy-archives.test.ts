import test from "node:test";
import assert from "node:assert/strict";

const { cleanupCandidates, isNomrehDeployArchive } = require("../scripts/plesk-deploy-archives.cjs");

test("deployment cleanup selects only exact Nomreh ZIP archives and preserves the current one", () => {
  const current = "nomreh-deploy-shecan-5353-v23-delta.zip";
  const candidates = cleanupCandidates([
    current,
    "nomreh-deploy.zip",
    "nomreh-deploy-shecan-doh-v22-delta.zip",
    "nomreh-deploy-shecan-doh-v22-delta.zip",
    "nomreh-data",
    "nomreh-deploy.zip.backup",
    "nomreh-deploy-evil.zip/child",
    "uploads/nomreh-deploy-old.zip",
    ".env",
  ], current);
  assert.deepEqual(candidates, ["nomreh-deploy-shecan-doh-v22-delta.zip", "nomreh-deploy.zip"]);
  assert.equal(candidates.includes(current), false);
});

test("deployment cleanup rejects every non-archive path and an invalid preserve target", () => {
  for (const value of ["", ".env", "server.js", "nomreh-data", "nomreh-deploy-", "nomreh-deploy-UPPER.zip", "nomreh-deploy-a.zip/../secret"]) {
    assert.equal(isNomrehDeployArchive(value), false, value);
  }
  assert.equal(isNomrehDeployArchive("nomreh-deploy.zip"), true);
  assert.throws(() => cleanupCandidates(["nomreh-deploy.zip"], "../nomreh-deploy.zip"));
});
