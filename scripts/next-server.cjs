const { createServer } = require("node:http");
const next = require("next");
const { attachShecanVncWebSocket } = require("./shecan-vnc-websocket.cjs");

process.env.NODE_ENV = "production";
const port = Number(process.env.PORT) || 3000;
const hostname = process.env.NOMREH_HOST || "0.0.0.0";
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((request, response) => handle(request, response));
  attachShecanVncWebSocket(server, port);
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
