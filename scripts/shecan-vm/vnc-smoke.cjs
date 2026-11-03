#!/usr/bin/env node
"use strict";

// Minimal RFB 3.8 None-security/raw-framebuffer smoke client for the scoped
// loopback Xvnc probe. It supports no remote authentication and no proxying.
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");

const port = Number(process.argv[2]);
const outputPath = process.argv[3] || "";
const attempts = Number(process.env.VNC_SMOKE_ATTEMPTS || 60);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid VNC port");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForReadable(socket, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("VNC read timeout")), timeout);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      if (error) reject(error); else resolve();
    };
    const onReadable = () => finish();
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error("VNC connection ended"));
    const onClose = () => finish(new Error("VNC connection closed"));
    socket.once("readable", onReadable);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
  });
}

async function readExactly(socket, length) {
  if (length === 0) return Buffer.alloc(0);
  for (;;) {
    const chunk = socket.read(length);
    if (chunk) return chunk;
    await waitForReadable(socket);
  }
}

async function connect() {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.pause();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("VNC connect timeout")), 4000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onConnect = () => finish();
    const onError = (error) => finish(error);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return socket;
}

async function capture() {
  const socket = await connect();
  try {
    const version = await readExactly(socket, 12);
    if (!/^RFB 003\.\d{3}\n$/.test(version.toString("ascii"))) throw new Error("Not an RFB 3.x server");
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));
    const count = (await readExactly(socket, 1))[0];
    if (!count) throw new Error("VNC server offered no security type");
    const securityTypes = await readExactly(socket, count);
    if (!securityTypes.includes(1)) throw new Error("VNC None security is unavailable");
    socket.write(Buffer.from([1]));
    const result = await readExactly(socket, 4);
    if (result.readUInt32BE(0) !== 0) throw new Error("VNC security negotiation failed");
    socket.write(Buffer.from([1])); // shared ClientInit

    const initial = await readExactly(socket, 24);
    const width = initial.readUInt16BE(0);
    const height = initial.readUInt16BE(2);
    const bits = initial[4];
    const bigEndian = initial[6] !== 0;
    const trueColor = initial[7] !== 0;
    const redShift = initial[14];
    const greenShift = initial[15];
    const blueShift = initial[16];
    const nameLength = initial.readUInt32BE(20);
    if (nameLength > 4096) throw new Error("Invalid VNC desktop name length");
    await readExactly(socket, nameLength);
    if (!width || !height || width > 4096 || height > 4096 || bits !== 32 || !trueColor) {
      throw new Error(`Unsupported VNC framebuffer ${width}x${height}x${bits}`);
    }

    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(0, 4); // raw only
    socket.write(encodings);
    const request = Buffer.alloc(10);
    request[0] = 3;
    request.writeUInt16BE(0, 2);
    request.writeUInt16BE(0, 4);
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    socket.write(request);

    let rectangles = 0;
    let updateHeader;
    for (;;) {
      const type = (await readExactly(socket, 1))[0];
      if (type === 0) {
        updateHeader = await readExactly(socket, 3);
        rectangles = updateHeader.readUInt16BE(1);
        break;
      }
      if (type === 2) continue;
      if (type === 3) {
        const header = await readExactly(socket, 7);
        const length = header.readUInt32BE(3);
        if (length > 1024 * 1024) throw new Error("Oversized VNC text message");
        await readExactly(socket, length);
        continue;
      }
      throw new Error(`Unsupported VNC server message ${type}`);
    }
    if (!rectangles || rectangles > 128) throw new Error("VNC returned no usable framebuffer rectangles");

    const rgb = Buffer.alloc(width * height * 3);
    const colors = new Set();
    let minimum = 255;
    let maximum = 0;
    for (let index = 0; index < rectangles; index += 1) {
      const header = await readExactly(socket, 12);
      const x = header.readUInt16BE(0);
      const y = header.readUInt16BE(2);
      const w = header.readUInt16BE(4);
      const h = header.readUInt16BE(6);
      const encoding = header.readInt32BE(8);
      if (encoding !== 0 || x + w > width || y + h > height || !w || !h) throw new Error("Unsupported VNC rectangle");
      const raw = await readExactly(socket, w * h * 4);
      for (let row = 0; row < h; row += 1) {
        for (let column = 0; column < w; column += 1) {
          const source = (row * w + column) * 4;
          const value = bigEndian ? raw.readUInt32BE(source) : raw.readUInt32LE(source);
          const red = (value >>> redShift) & 0xff;
          const green = (value >>> greenShift) & 0xff;
          const blue = (value >>> blueShift) & 0xff;
          const target = ((y + row) * width + x + column) * 3;
          rgb[target] = red;
          rgb[target + 1] = green;
          rgb[target + 2] = blue;
          if (colors.size < 4096) colors.add((red << 16) | (green << 8) | blue);
          const luminance = Math.round((red + green + blue) / 3);
          minimum = Math.min(minimum, luminance);
          maximum = Math.max(maximum, luminance);
        }
      }
    }
    const ppm = Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii"), rgb]);
    const hash = crypto.createHash("sha256").update(ppm).digest("hex");
    if (outputPath) fs.writeFileSync(outputPath, ppm, { mode: 0o600 });
    return { width, height, colors: colors.size, minimum, maximum, hash, bytes: ppm.length };
  } finally {
    socket.destroy();
  }
}

(async () => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await capture();
      if (result.colors < 16 || result.maximum - result.minimum < 24) {
        lastError = new Error(`framebuffer still uniform (colors=${result.colors})`);
        if (attempt === 1 || attempt % 5 === 0) console.log(`NOMREH_VNC_FRAMEBUFFER_WAIT attempt=${attempt} colors=${result.colors} luminance_range=${result.maximum - result.minimum} width=${result.width} height=${result.height}`);
      } else {
        console.log(`NOMREH_VNC_FRAMEBUFFER_PASS width=${result.width} height=${result.height} colors=${result.colors} luminance_range=${result.maximum - result.minimum} sha256=${result.hash} bytes=${result.bytes}`);
        return;
      }
    } catch (error) {
      lastError = error;
      if (attempt === 1 || attempt % 15 === 0) console.log(`NOMREH_VNC_FRAMEBUFFER_WAIT attempt=${attempt} error=${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
    }
    await delay(1000);
  }
  throw lastError || new Error("VNC framebuffer was not available");
})().catch((error) => {
  console.error(`NOMREH_VNC_FRAMEBUFFER_ERROR ${error.message}`);
  process.exitCode = 1;
});
