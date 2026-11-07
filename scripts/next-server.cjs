const { createServer } = require("node:http");
const next = require("next");

// Nomreh's launcher — plain Next.js, one transport, no side systems.
//
// This file used to attach a VNC HTTP channel and a WebSocket bridge, then boot a
// QEMU guest on every start so the AI traffic could leave through a Windows copy
// of Shecan. All of that is gone. What is left is the ordinary Next.js handler,
// which is what a reviewer expects to find behind `server.js`.
//
// Consequence worth stating plainly: a restart can no longer resurrect a tunnel,
// so an outage is always the application or the destination — never a stale guest
// holding a port.

process.env.NODE_ENV = "production";
const port = Number(process.env.PORT) || 3000;
const hostname = process.env.NOMREH_HOST || "0.0.0.0";
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((request, response) => handle(request, response));
  server.listen(port, hostname, () => {
    console.log(`Nomreh is ready on ${hostname}:${port} with ${process.version}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}).catch((error) => {
  console.error("Nomreh failed to start", error);
  process.exit(1);
});
