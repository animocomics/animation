"use strict";

// Plesk may provide only an older bootstrap Node.js. Keep this launcher
// compatible with Node 17, then run the actual Next.js server with the
// domain-local Node 22 runtime installed by build:plesk.
const major = Number(process.versions.node.split(".")[0]);

if (major >= 22) {
  require("./scripts/next-server.cjs");
} else if (process.env.NOMREH_NODE22_DELEGATED === "1") {
  console.error(`Nomreh requires its Node 22 runtime, but the delegated process is still ${process.version}.`);
  process.exit(1);
} else {
  require("./scripts/plesk-node22.cjs").launchServer();
}
