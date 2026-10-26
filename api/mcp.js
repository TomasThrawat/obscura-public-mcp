'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const BINARY_URL = process.env.OBSCURA_BINARY_URL ||
  'https://output.circle-artifacts.com/output/job/56d61262-6aae-4557-a46f-1130a071b6de/artifacts/0/obscura-release-binary';
const BINARY_PATH = '/tmp/obscura';
const MAX_BINARY_BYTES = 180 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 55000;
const STARTUP_TIMEOUT_MS = 20000;

const state = globalThis.__obscuraMcpState || (globalThis.__obscuraMcpState = {
  child: null,
  port: null,
  binaryPromise: null,
  startPromise: null,
  lastError: null,
  rateBuckets: new Map(),
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, statusCode, payload, origin) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.end(JSON.stringify(payload));
}

function isRateLimited(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0] : '') ||
    req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = state.rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= 60000) {
    bucket = { startedAt: now, count: 0 };
    state.rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (state.rateBuckets.size > 500) {
    for (const [key, value] of state.rateBuckets) {
      if (now - value.startedAt >= 60000) state.rateBuckets.delete(key);
    }
  }
  return bucket.count > 90;
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
    return Buffer.from(JSON.stringify(req.body), 'utf8');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_REQUEST_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function hasBinary() {
  try {
    const handle = await fs.open(BINARY_PATH, 'r');
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    await handle.close();
    return signature[0] === 0x7f && signature[1] === 0x45 &&
      signature[2] === 0x4c && signature[3] === 0x46;
  } catch (_) {
    return false;
  }
}

async function ensureBinary() {
  if (await hasBinary()) {
    await fs.chmod(BINARY_PATH, 0o700);
    return BINARY_PATH;
  }
  if (state.binaryPromise) return state.binaryPromise;
  state.binaryPromise = (async () => {
    const response = await fetch(BINARY_URL, { redirect: 'follow', signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error('Binary download returned HTTP ' + response.status);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_BINARY_BYTES) throw new Error('Binary download exceeded the size limit');
    const binary = Buffer.from(await response.arrayBuffer());
    if (binary.length < 1024 || binary.length > MAX_BINARY_BYTES ||
        binary[0] !== 0x7f || binary[1] !== 0x45 || binary[2] !== 0x4c || binary[3] !== 0x46) {
      throw new Error('Binary URL did not return a valid Linux executable');
    }
    await fs.writeFile(BINARY_PATH, binary, { mode: 0o700 });
    await fs.chmod(BINARY_PATH, 0o700);
    return BINARY_PATH;
  })();
  try {
    return await state.binaryPromise;
  } finally {
    state.binaryPromise = null;
  }
}

async function probe(port) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
      method: 'OPTIONS',
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(1000),
    });
    return response.status === 204;
  } catch (_) {
    return false;
  }
}

async function ensureEngine() {
  if (state.child && state.child.exitCode === null && state.port) return state.port;
  if (state.startPromise) return state.startPromise;
  state.startPromise = (async () => {
    const binaryPath = await ensureBinary();
    const port = 20000 + Math.floor(Math.random() * 25000);
    const env = { ...process.env, OBSCURA_ALLOW_PRIVATE_NETWORK: '0', OBSCURA_STORAGE_DIR: '/tmp/obscura-storage' };
    delete env.OBSCURA_MCP_TOKEN;
    const child = spawn(binaryPath, ['mcp', '--http', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: '/tmp',
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    state.child = child;
    state.port = port;
    state.lastError = null;
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      state.lastError = text.slice(-1500);
    });
    child.on('error', (err) => {
      state.lastError = err.message;
      if (state.child === child) {
        state.child = null;
        state.port = null;
      }
    });
    child.on('exit', (code, signal) => {
      if (state.child === child) {
        state.child = null;
        state.port = null;
        if (code !== 0) state.lastError = 'process exited (' + code + ', ' + signal + ')';
      }
    });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (state.child !== child || child.exitCode !== null) {
        throw new Error('Obscura process exited during startup');
      }
      if (await probe(port)) return port;
      await sleep(200);
    }
    child.kill('SIGTERM');
    throw new Error('Obscura process did not become ready in time');
  })();
  try {
    return await state.startPromise;
  } finally {
    state.startPromise = null;
  }
}

function postToEngine(port, incoming, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'content-type': typeof incoming.headers['content-type'] === 'string'
        ? incoming.headers['content-type'] : 'application/json',
      'content-length': String(body.length),
      connection: 'close',
    };
    for (const name of ['accept', 'origin', 'mcp-protocol-version', 'authorization']) {
      const value = incoming.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          upstream.destroy(new Error('MCP response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Obscura request timed out')));
    upstream.on('error', reject);
    upstream.end(body);
  });
}

module.exports = async function handler(req, res) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (origin) res.setHeader('Vary', 'Origin');
    return res.end();
  }

  if (req.method === 'GET') {
    return sendJson(res, 200, {
      name: 'Obscura Remote MCP',
      status: 'ok',
      transport: 'MCP Streamable HTTP',
      endpoint: '/mcp',
      authentication: 'none',
      engine: 'starts on first MCP POST',
    }, origin);
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Use POST for MCP Streamable HTTP requests.' }, origin);
  }

  if (isRateLimited(req)) {
    return sendJson(res, 429, { error: 'Rate limit exceeded; retry in a minute.' }, origin);
  }

  try {
    const body = await readBody(req);
    if (body.length === 0) return sendJson(res, 400, { error: 'Missing JSON-RPC request body.' }, origin);
    if (body.length > MAX_REQUEST_BYTES) return sendJson(res, 413, { error: 'Request body too large.' }, origin);

    const port = await ensureEngine();
    const response = await postToEngine(port, req, body);
    res.statusCode = response.statusCode;
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const key of [
      'access-control-allow-origin', 'access-control-allow-methods',
      'access-control-allow-headers', 'access-control-max-age', 'vary',
    ]) {
      if (response.headers[key]) res.setHeader(key, response.headers[key]);
    }
    return res.end(response.body);
  } catch (error) {
    const status = error && error.statusCode ? error.statusCode : 503;
    console.error('[obscura-mcp] request failed:', error && error.message ? error.message : 'unknown error');
    return sendJson(res, status, {
      error: status === 413 ? 'Request body too large.' : 'Obscura MCP engine failed to start or handle the request.',
      retryable: status !== 413,
    }, origin);
  }
};