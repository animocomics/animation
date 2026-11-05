#!/usr/bin/env node
"use strict";

const DEPLOY_ARCHIVE = /^nomreh-deploy(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.zip$/;

function isNomrehDeployArchive(name) {
  return typeof name === "string" && DEPLOY_ARCHIVE.test(name);
}

function cleanupCandidates(names, keep) {
  if (!isNomrehDeployArchive(keep)) throw new Error("The archive to preserve is not a validated Nomreh deployment archive.");
  return [...new Set(names.filter((name) => isNomrehDeployArchive(name) && name !== keep))].sort();
}

module.exports = { cleanupCandidates, isNomrehDeployArchive };
