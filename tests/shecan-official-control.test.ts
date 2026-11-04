import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendOfficialGuestActivation } from "../lib/server/shecan-runtime";

function listen(socketPath: string, handler: (line: string, socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline >= 0) handler(input.slice(0, newline), socket);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

test("official control sends the secret only on its private socket and accepts only a matching nonce", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-control-"));
  const socketPath = path.join(directory, "control.sock");
  const updateUrl = "https://ddns.shecan.ir/update/test-only-secret";
  const servers: [string, string] = ["178.22.122.101", "185.51.200.1"];
  let received = "";
  const server = await listen(socketPath, (line, socket) => {
    received = line;
    const [action, nonce, encodedUrl, primary, secondary] = line.split(" ");
    assert.equal(action, "ACTIVATE");
    assert.match(nonce, /^[a-f0-9]{16}$/);
    assert.equal(Buffer.from(encodedUrl, "base64").toString("utf8"), updateUrl);
    assert.equal(Buffer.from(primary, "base64").toString("utf8"), servers[0]);
    assert.equal(Buffer.from(secondary, "base64").toString("utf8"), servers[1]);
    socket.write(`OK 0000000000000000\nOK ${nonce}\n`);
  });
  try {
    const activatedAt = await sendOfficialGuestActivation(updateUrl, servers, { socketPath, timeoutMs: 3000 });
    assert.ok(!Number.isNaN(Date.parse(activatedAt)));
    assert.ok(received.startsWith("ACTIVATE "));
    assert.ok(!received.includes(updateUrl), "the command channel must encode the stored URL");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("official control returns bounded sanitized guest errors without the update URL", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-control-error-"));
  const socketPath = path.join(directory, "control.sock");
  const updateUrl = "https://ddns.shecan.ir/update/another-test-secret";
  const server = await listen(socketPath, (line, socket) => {
    const nonce = line.split(" ")[1];
    socket.end(`ERROR ${nonce} UPDATE_FAILED\n`);
  });
  try {
    await assert.rejects(
      sendOfficialGuestActivation(updateUrl, ["178.22.122.101", "185.51.200.1"], { socketPath, timeoutMs: 3000 }),
      (error: unknown) => error instanceof Error && error.message.includes("UPDATE_FAILED") && !error.message.includes(updateUrl),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("official control rejects non-Shecan update hosts before opening a socket", async () => {
  await assert.rejects(sendOfficialGuestActivation("https://example.com/update", ["178.22.122.101", "185.51.200.1"], { socketPath: "/tmp/must-not-open-nomreh.sock" }), /Invalid isolated/);
});

test("official guest preserves the validated Xvnc mode and scopes its TCP fallback to the UNIX desktop", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../scripts/shecan-vm/official-guest-init.sh"), "utf8");
  assert.match(source, /-rfbport -1 -rfbunixpath \/tmp\/shecan-vnc\.sock/);
  assert.doesNotMatch(source, /-rfbport 5900/);
  assert.match(source, /socat TCP-LISTEN:5900,bind=0\.0\.0\.0,reuseaddr,fork UNIX-CONNECT:\/tmp\/shecan-vnc\.sock/);
  assert.match(source, /NOMREH_OFFICIAL_VNC_TCP_RELAY_READY/);
});
