import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PROVIDER_HOSTNAMES = new Set([
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'api.z.ai',
  'api.minimax.io',
  'api.mistral.ai',
  'tinker.thinkingmachines.dev',
]);
const DOH_HOSTNAME = 'pro.shecan.ir';
const DOH_IPV4 = '185.51.200.1';
const MAX_DNS_BYTES = 65_535;
const MAX_HEADER_BYTES = 32_768;

function safeCode(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error && ['TimeoutError', 'AbortError'].includes(current.name)) return 'TIMEOUT';
    const code = typeof current === 'object' && current && 'code' in current ? current.code : undefined;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/i.test(code)) return code.toUpperCase();
    current = typeof current === 'object' && current && 'cause' in current ? current.cause : undefined;
  }
  return 'FAILED';
}

function timeoutError(message = 'Windows Shecan request timed out') {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function validHostname(value) {
  const hostname = String(value || '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) throw new Error('Invalid DNS hostname');
  const labels = hostname.split('.');
  if (labels.some((label) => !label.length || label.length > 63)) throw new Error('Invalid DNS hostname');
  return hostname;
}

export function encodeDnsQuery(hostname, id = 0) {
  const normalized = validHostname(hostname);
  if (!Number.isInteger(id) || id < 0 || id > 65_535) throw new Error('Invalid DNS query ID');
  const name = Buffer.alloc(normalized.length + 2);
  let offset = 0;
  for (const label of normalized.split('.')) {
    name.writeUInt8(label.length, offset);
    offset += 1;
    name.write(label, offset, 'ascii');
    offset += label.length;
  }
  name.writeUInt8(0, offset);
  const packet = Buffer.alloc(18 + normalized.length);
  name.copy(packet, 12);
  packet.writeUInt16BE(id, 0);
  packet.writeUInt16BE(0x0100, 2);
  packet.writeUInt16BE(1, 4);
  packet.writeUInt16BE(1, packet.length - 4);
  packet.writeUInt16BE(1, packet.length - 2);
  return packet;
}

function skipDnsName(packet, initialOffset) {
  let offset = initialOffset;
  for (let steps = 0; steps < 128; steps += 1) {
    if (offset >= packet.length) throw new Error('Truncated DNS name');
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error('Truncated DNS pointer');
      return offset + 2;
    }
    if (length > 63) throw new Error('Invalid DNS label');
    offset += 1;
    if (!length) return offset;
    offset += length;
  }
  throw new Error('Too many DNS labels');
}

export function parseDnsMessage(packet, expectedId) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.length > MAX_DNS_BYTES) throw new Error('Invalid DNS response size');
  if (packet.readUInt16BE(0) !== expectedId || !(packet.readUInt16BE(2) & 0x8000)) throw new Error('Mismatched DNS response');
  const flags = packet.readUInt16BE(2);
  if (flags & 0x0200) throw new Error('Truncated DNS response');
  if ((flags & 0x000f) !== 0) throw new Error('DNS response status');
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  if (questions > 16 || answers > 256) throw new Error('Unreasonable DNS response');
  let offset = 12;
  for (let index = 0; index < questions; index += 1) {
    offset = skipDnsName(packet, offset);
    if (offset + 4 > packet.length) throw new Error('Truncated DNS question');
    offset += 4;
  }
  const records = [];
  for (let index = 0; index < answers; index += 1) {
    offset = skipDnsName(packet, offset);
    if (offset + 10 > packet.length) throw new Error('Truncated DNS answer');
    const type = packet.readUInt16BE(offset);
    const recordClass = packet.readUInt16BE(offset + 2);
    const ttl = packet.readUInt32BE(offset + 4);
    const length = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > packet.length) throw new Error('Truncated DNS data');
    if (type === 1 && recordClass === 1 && length === 4) {
      const address = `${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`;
      if (net.isIPv4(address)) records.push({ address, ttl });
    }
    offset += length;
  }
  return records;
}

export function parseConnectTarget(line) {
  const match = /^CONNECT ([a-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]$/i.exec(String(line || '').trim());
  if (!match) return null;
  const hostname = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!/^[a-z0-9.-]+$/.test(hostname) || port !== 443) return null;
  return { hostname, port };
}

function parseHeaders(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    if (buffer.length > MAX_HEADER_BYTES) throw new Error('HTTP headers too large');
    return null;
  }
  if (headerEnd > MAX_HEADER_BYTES) throw new Error('HTTP headers too large');
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const statusMatch = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(lines[0]);
  if (!statusMatch) throw new Error('Invalid HTTP response');
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers[name]) headers[name] = `${headers[name]}, ${value}`;
    else headers[name] = value;
  }
  return { status: Number(statusMatch[1]), headers, bodyOffset: headerEnd + 4 };
}

function decodeChunked(buffer, start, maximum) {
  let offset = start;
  const chunks = [];
  let size = 0;
  for (let count = 0; count < 4096; count += 1) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const line = buffer.subarray(offset, lineEnd).toString('ascii');
    const length = Number.parseInt(line.split(';', 1)[0], 16);
    if (!Number.isInteger(length) || length < 0 || !/^[0-9a-f]+(?:;.*)?$/i.test(line)) throw new Error('Invalid HTTP chunk');
    offset = lineEnd + 2;
    if (length === 0) {
      if (buffer.length < offset + 2) return null;
      if (buffer.subarray(offset, offset + 2).toString('latin1') === '\r\n') return { body: Buffer.concat(chunks, size), end: offset + 2 };
      const trailerEnd = buffer.indexOf('\r\n\r\n', offset);
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(chunks, size), end: trailerEnd + 4 };
    }
    size += length;
    if (size > maximum) throw new Error('HTTP body too large');
    if (buffer.length < offset + length + 2) return null;
    chunks.push(buffer.subarray(offset, offset + length));
    offset += length;
    if (buffer.subarray(offset, offset + 2).toString('latin1') !== '\r\n') throw new Error('Invalid HTTP chunk ending');
    offset += 2;
  }
  throw new Error('Too many HTTP chunks');
}

export function parseHttpResponse(buffer, { readBody = true, ended = false, maximumBody = MAX_DNS_BYTES } = {}) {
  const parsed = parseHeaders(buffer);
  if (!parsed) return null;
  if (!readBody) return { ...parsed, body: Buffer.alloc(0), complete: true };
  if (/chunked/i.test(parsed.headers['transfer-encoding'] || '')) {
    const decoded = decodeChunked(buffer, parsed.bodyOffset, maximumBody);
    return decoded ? { ...parsed, body: decoded.body, complete: true } : null;
  }
  if (parsed.headers['content-length'] !== undefined) {
    const length = Number(parsed.headers['content-length']);
    if (!Number.isInteger(length) || length < 0 || length > maximumBody) throw new Error('Invalid HTTP content length');
    if (buffer.length < parsed.bodyOffset + length) return null;
    return { ...parsed, body: buffer.subarray(parsed.bodyOffset, parsed.bodyOffset + length), complete: true };
  }
  if (!ended) return null;
  const body = buffer.subarray(parsed.bodyOffset);
  if (body.length > maximumBody) throw new Error('HTTP body too large');
  return { ...parsed, body, complete: true };
}

function requestHeaders(hostname, method, headers, body) {
  const values = {
    Host: hostname,
    'User-Agent': 'Nomreh-Windows-Shecan/1.0',
    Accept: '*/*',
    Connection: 'close',
    ...headers,
  };
  if (body?.length) values['Content-Length'] = String(body.length);
  let text = `${method} ${headers.__path || '/'} HTTP/1.1\r\n`;
  delete values.__path;
  for (const [name, value] of Object.entries(values)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n]/.test(String(value))) throw new Error('Invalid HTTP request header');
    text += `${name}: ${value}\r\n`;
  }
  return `${text}\r\n`;
}

export async function pinnedHttpsRequest({
  hostname,
  address,
  requestPath = '/',
  method = 'GET',
  headers = {},
  body,
  readBody = true,
  maximumBody = MAX_DNS_BYTES,
  timeoutMs = 10_000,
}) {
  if (!net.isIPv4(address) || !/^[a-z0-9.-]+$/i.test(hostname) || !requestPath.startsWith('/') || /[\r\n]/.test(requestPath)) {
    throw Object.assign(new Error('Invalid pinned HTTPS input'), { code: 'INVALID_REQUEST' });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = tls.connect({
      host: address,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    socket.on('secureConnect', () => {
      if (!socket.authorized) {
        finish(Object.assign(new Error('TLS certificate was not authorized'), { code: 'CERTIFICATE' }));
        return;
      }
      const request = requestHeaders(hostname, method, { ...headers, __path: requestPath }, body);
      socket.write(request, 'latin1');
      if (body?.length) socket.write(body);
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      received = Buffer.concat([received, chunk]);
      if (received.length > maximumBody + MAX_HEADER_BYTES + 262_144) {
        finish(Object.assign(new Error('HTTPS response too large'), { code: 'RESPONSE_TOO_LARGE' }));
        return;
      }
      try {
        const parsed = parseHttpResponse(received, { readBody, maximumBody });
        if (parsed) finish(undefined, parsed);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => {
      if (settled) return;
      try {
        const parsed = parseHttpResponse(received, { readBody, ended: true, maximumBody });
        if (parsed) finish(undefined, parsed);
        else finish(Object.assign(new Error('Incomplete HTTPS response'), { code: 'INCOMPLETE_RESPONSE' }));
      } catch (error) { finish(error); }
    });
    socket.on('error', (error) => finish(error));
  });
}

function udpDns(hostname, server, port = 53, timeoutMs = 3000) {
  const id = randomBytes(2).readUInt16BE(0);
  const query = encodeDnsQuery(hostname, id);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (error, records) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Already closed. */ }
      if (error) reject(error);
      else resolve(records);
    };
    const timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    socket.on('message', (message, remote) => {
      if (remote.address !== server) return;
      try {
        const records = parseDnsMessage(message, id).filter((record) => net.isIPv4(record.address));
        if (!records.length) throw Object.assign(new Error('No IPv4 DNS answer'), { code: 'DNS_NO_IPV4' });
        finish(undefined, records);
      } catch (error) { finish(error); }
    });
    socket.on('error', (error) => finish(error));
    try { socket.send(query, port, server); } catch (error) { finish(error); }
  });
}

function firstSuccessful(promises) {
  return Promise.any(promises.map((promise) => promise.then((records) => {
    if (!records.length) throw Object.assign(new Error('No IPv4 DNS answer'), { code: 'DNS_NO_IPV4' });
    return records;
  })));
}

async function dohDns(hostname) {
  const query = encodeDnsQuery(hostname).toString('base64url');
  const response = await pinnedHttpsRequest({
    hostname: DOH_HOSTNAME,
    address: DOH_IPV4,
    requestPath: `/dns-query?dns=${query}`,
    headers: { Accept: 'application/dns-message' },
    maximumBody: MAX_DNS_BYTES,
    timeoutMs: 8000,
  });
  if (response.status !== 200) throw Object.assign(new Error('DoH status'), { code: 'DOH_HTTP_ERROR' });
  return parseDnsMessage(response.body, 0);
}

async function dotDns(hostname) {
  const id = randomBytes(2).readUInt16BE(0);
  const query = encodeDnsQuery(hostname, id);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: DOH_IPV4, port: 853, servername: DOH_HOSTNAME, rejectUnauthorized: true, ALPNProtocols: ['dot'] });
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (error, records) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(records);
    };
    const timer = setTimeout(() => finish(timeoutError()), 8000);
    socket.on('secureConnect', () => {
      if (!socket.authorized) { finish(Object.assign(new Error('DoT certificate was not authorized'), { code: 'CERTIFICATE' })); return; }
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([prefix, query]));
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_DNS_BYTES + 2) { finish(Object.assign(new Error('DoT response too large'), { code: 'DNS_TOO_LARGE' })); return; }
      if (received.length < 2) return;
      const length = received.readUInt16BE(0);
      if (received.length < length + 2) return;
      try { finish(undefined, parseDnsMessage(received.subarray(2, length + 2), id)); }
      catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!settled) finish(Object.assign(new Error('Incomplete DoT response'), { code: 'DOT_NO_RESPONSE' })); });
    socket.on('error', (error) => finish(error));
  });
}

export function createShecanResolver() {
  let servers = ['178.22.122.101', '185.51.200.1'];
  let cache = new Map();
  async function resolve(hostname) {
    const normalized = validHostname(hostname);
    const cached = cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) return cached.records.map((record) => record.address);
    const attempts = [
      () => firstSuccessful(servers.map((server) => udpDns(normalized, server))),
      () => dohDns(normalized),
      () => dotDns(normalized),
      () => firstSuccessful(servers.map((server) => udpDns(normalized, server, 5353))),
    ];
    let lastError;
    for (const attempt of attempts) {
      try {
        const records = (await attempt()).filter((record) => net.isIPv4(record.address));
        if (!records.length) continue;
        const ttl = Math.min(...records.map((record) => Math.max(0, record.ttl || 0)));
        cache.set(normalized, { records, expiresAt: Date.now() + Math.min(Math.max(ttl, 5), 300) * 1000 });
        return records.map((record) => record.address);
      } catch (error) { lastError = error; }
    }
    throw Object.assign(new Error('All scoped Shecan DNS methods failed'), { code: 'DNS_FAILED', cause: lastError });
  }
  return {
    resolve,
    setServers(value) {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(net.isIPv4)) throw new Error('Invalid Shecan DNS servers');
      servers = [...value];
      cache = new Map();
    },
    clear() { cache = new Map(); },
  };
}

function tcpConnect(address, port, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { socket.destroy(); reject(error); }
      else resolve(socket);
    };
    const timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    socket.once('connect', () => finish());
    socket.once('error', (error) => finish(error));
  });
}

export function createConnectServer({ resolve, allowedHosts = PROVIDER_HOSTNAMES, onActiveChange = () => undefined, connect = tcpConnect }) {
  const clients = new Set();
  const tunnels = new Set();
  let active = 0;
  const server = net.createServer((client) => {
    clients.add(client);
    let buffered = Buffer.alloc(0);
    let handled = false;
    const timer = setTimeout(() => client.destroy(), 10_000);
    const reject = (status) => {
      if (handled) return;
      handled = true;
      clearTimeout(timer);
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    client.on('data', (chunk) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16_384) { reject('431 Request Header Fields Too Large'); return; }
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      handled = true;
      clearTimeout(timer);
      const target = parseConnectTarget(buffered.subarray(0, end).toString('latin1').split('\r\n', 1)[0]);
      if (!target || !allowedHosts.has(target.hostname)) { handled = false; reject('403 Forbidden'); return; }
      const remainder = buffered.subarray(end + 4);
      void (async () => {
        const addresses = (await resolve(target.hostname)).filter(net.isIPv4).slice(0, 8);
        if (!addresses.length) throw Object.assign(new Error('No provider IPv4'), { code: 'DNS_NO_IPV4' });
        let upstream;
        let lastError;
        for (const address of [...new Set(addresses)]) {
          try { upstream = await connect(address, target.port); break; }
          catch (error) { lastError = error; }
        }
        if (!upstream) throw lastError || new Error('Provider connection failed');
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length) upstream.write(remainder);
        const pair = { client, upstream };
        tunnels.add(pair);
        active += 1;
        onActiveChange(active);
        const close = () => {
          if (!tunnels.delete(pair)) return;
          active -= 1;
          onActiveChange(active);
          client.destroy();
          upstream.destroy();
        };
        client.on('error', close);
        upstream.on('error', close);
        client.on('close', close);
        upstream.on('close', close);
        client.pipe(upstream);
        upstream.pipe(client);
      })().catch(() => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
    });
    client.on('error', () => { clearTimeout(timer); client.destroy(); });
    client.on('close', () => { clearTimeout(timer); clients.delete(client); });
  });
  server.closeAll = () => {
    for (const client of clients) client.destroy();
    for (const pair of [...tunnels]) { pair.client.destroy(); pair.upstream.destroy(); }
  };
  return server;
}

function verifiedUpdateAddresses(hostname) {
  if (hostname === 'ddns.shecan.ir') return ['185.143.234.133', '185.143.233.133'];
  if (hostname === 'nddns.shecan.ir') return ['188.245.62.250'];
  return [];
}

function validateUpdateUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password || value.length > 2000 || !(hostname === 'shecan.ir' || hostname.endsWith('.shecan.ir'))) {
    throw Object.assign(new Error('Invalid Shecan update URL'), { code: 'INVALID_ACTIVATION' });
  }
  return url;
}

export function createActivator({ resolve, request = pinnedHttpsRequest }) {
  return async function activate(updateUrl, servers) {
    if (!Array.isArray(servers) || servers.length !== 2 || !servers.every(net.isIPv4)) throw Object.assign(new Error('Invalid Shecan servers'), { code: 'INVALID_ACTIVATION' });
    let current = validateUpdateUrl(updateUrl);
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const hostname = current.hostname.toLowerCase();
      const attempted = new Set();
      const requestGroup = async (addresses) => {
        let lastError;
        for (const address of [...new Set(addresses)].filter(net.isIPv4).slice(0, 6)) {
          if (attempted.has(address)) continue;
          attempted.add(address);
          try {
            const response = await request({
              hostname,
              address,
              requestPath: `${current.pathname}${current.search}`,
              headers: { Accept: '*/*' },
              readBody: false,
              timeoutMs: 10_000,
            });
            if (response.status >= 200 && response.status < 300) return { response };
            if (response.status >= 300 && response.status < 400 && response.headers.location) return { response };
            throw Object.assign(new Error('Shecan update returned an HTTP error'), { code: `HTTP_${response.status}` });
          } catch (error) {
            if (/^HTTP_/.test(safeCode(error))) throw error;
            lastError = error;
          }
        }
        return { lastError };
      };

      // Exercise the exact official host first when its current documented
      // address is known. If that path is unreachable, use every scoped Shecan
      // resolver rather than falling back to the host resolver.
      let outcome = await requestGroup(verifiedUpdateAddresses(hostname));
      if (!outcome.response) {
        let resolved;
        try { resolved = await resolve(hostname); }
        catch (error) {
          if (outcome.lastError) throw Object.assign(new Error('Shecan activation request failed'), { code: safeCode(outcome.lastError), cause: outcome.lastError });
          throw Object.assign(new Error('Shecan activation DNS failed'), { code: 'DNS_FAILED', cause: error });
        }
        const resolvedOutcome = await requestGroup(resolved);
        outcome = resolvedOutcome.response ? resolvedOutcome : { lastError: resolvedOutcome.lastError || outcome.lastError };
      }
      if (outcome.response) {
        const response = outcome.response;
        if (response.status >= 200 && response.status < 300) return new Date().toISOString();
        if (redirect >= 3) throw Object.assign(new Error('Too many activation redirects'), { code: 'TOO_MANY_REDIRECTS' });
        current = validateUpdateUrl(new URL(response.headers.location, current).toString());
        continue;
      }
      throw Object.assign(new Error('Shecan activation request failed'), { code: safeCode(outcome.lastError), cause: outcome.lastError });
    }
    throw Object.assign(new Error('Shecan activation redirect limit'), { code: 'TOO_MANY_REDIRECTS' });
  };
}

export function createControlServer({ token, activate }) {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid broker control token');
  const expectedToken = Buffer.from(token, 'hex');
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    let text = '';
    let completed = false;
    const timer = setTimeout(() => socket.destroy(), 100_000);
    socket.on('data', (chunk) => {
      if (completed) return;
      text = `${text}${chunk.toString('utf8')}`.slice(0, 8192);
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      completed = true;
      const line = text.slice(0, newline).trim();
      const [command, nonce = '', rawToken = '', encodedUrl = '', encodedPrimary = '', encodedSecondary = ''] = line.split(' ');
      const finish = (status, code = '') => {
        clearTimeout(timer);
        socket.end(`${status} ${nonce}${code ? ` ${code}` : ''}\n`);
      };
      try {
        if (command !== 'ACTIVATE' || !/^[a-f0-9]{16}$/i.test(nonce)) { socket.destroy(); return; }
        const supplied = Buffer.from(rawToken, 'hex');
        if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) { finish('ERROR', 'AUTH'); return; }
        const updateUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
        const servers = [Buffer.from(encodedPrimary, 'base64').toString('utf8'), Buffer.from(encodedSecondary, 'base64').toString('utf8')];
        void activate(updateUrl, servers).then(() => finish('OK')).catch((error) => finish('ERROR', safeCode(error)));
      } catch (error) { finish('ERROR', safeCode(error)); }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { clearTimeout(timer); clients.delete(socket); });
  });
  server.closeAll = () => { for (const client of clients) client.destroy(); };
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch { /* The containing directory is still private. */ }
}

export async function main() {
  const stateDirectory = path.resolve(process.env.SHECAN_BROKER_STATE_DIR || '');
  const tokenFile = path.resolve(process.env.SHECAN_BROKER_TOKEN_FILE || '');
  const proxyPort = Number(process.env.SHECAN_BROKER_PORT || 18888);
  const controlPort = Number(process.env.SHECAN_BROKER_CONTROL_PORT || 18889);
  if (!stateDirectory || !tokenFile || ![proxyPort, controlPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) || proxyPort === controlPort) {
    throw Object.assign(new Error('Invalid broker configuration'), { code: 'INVALID_CONFIG' });
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const statusPath = path.join(stateDirectory, 'broker-status.json');
  const resolver = createShecanResolver();
  let brokerReady = false;
  let activationReady = false;
  let activatedAt;
  let activeConnections = 0;
  let lastError;
  let activationQueue = Promise.resolve();
  const writeStatus = () => writeJsonAtomic(statusPath, {
    brokerReady,
    activationReady,
    activatedAt,
    activeConnections,
    lastError,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  });
  const activate = createActivator({ resolve: resolver.resolve });
  const activateSerialized = (updateUrl, servers) => {
    const job = activationQueue.then(async () => {
      activationReady = false;
      lastError = undefined;
      writeStatus();
      try {
        const result = await activate(updateUrl, servers);
        resolver.setServers(servers);
        activatedAt = result;
        activationReady = true;
        writeStatus();
        return result;
      } catch (error) {
        activationReady = false;
        lastError = safeCode(error);
        writeStatus();
        throw error;
      }
    });
    activationQueue = job.catch(() => undefined);
    return job;
  };
  const proxy = createConnectServer({ resolve: resolver.resolve, onActiveChange: (count) => { activeConnections = count; } });
  const control = createControlServer({ token, activate: activateSerialized });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    brokerReady = false;
    activationReady = false;
    try { writeStatus(); } catch { /* Process liveness remains fail-closed. */ }
    proxy.closeAll();
    control.closeAll();
    proxy.close();
    control.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await listen(proxy, proxyPort);
  try { await listen(control, controlPort); }
  catch (error) { proxy.closeAll(); proxy.close(); throw error; }
  brokerReady = true;
  writeStatus();
  const interval = setInterval(writeStatus, 5000);
  interval.ref();
  console.log('NOMREH_WINDOWS_AI_BROKER_LISTENING');
}

if (process.env.SHECAN_BROKER_RUN === '1') {
  main().catch((error) => {
    console.error(`NOMREH_WINDOWS_AI_BROKER_ERROR ${safeCode(error)}`);
    process.exit(1);
  });
}
