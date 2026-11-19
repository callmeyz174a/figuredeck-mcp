#!/usr/bin/env node
/**
 * FigureDeck MCP — a thin stdio proxy to the remote Streamable HTTP endpoint.
 *
 * Why this layer exists: the hosted endpoint (https://mcp.figuredeck.com/mcp)
 * works on its own, but many clients only speak stdio (Claude Desktop, various
 * IDE plugins). This proxy only forwards, it implements no business logic —
 * the data lives on the far side, so there is no local copy to go stale.
 *
 * Usage:
 *   npx -y github:callmeyz174a/figuredeck-mcp
 *   FD_MCP_URL=http://127.0.0.1:8788/mcp node bin/figuredeck-mcp.js   # local build
 *
 * Contract: stdout carries JSON-RPC only, logs go to stderr. That is a hard
 * requirement of MCP stdio — a single stray console.log makes clients fail to
 * parse the stream (Claude Desktop disconnects outright).
 */

import { createInterface } from 'node:readline';

const ENDPOINT = process.env.FD_MCP_URL || 'https://mcp.figuredeck.com/mcp';
const TIMEOUT_MS = Number(process.env.FD_MCP_TIMEOUT_MS || 30000);

/** If the remote answers with SSE, pick the data: frame whose id matches. */
function pickFromSse(text, id) {
  const payloads = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^data:\s*(.+)$/);
    if (!m) continue;
    try {
      payloads.push(JSON.parse(m[1]));
    } catch {
      /* comment frame or heartbeat, ignore */
    }
  }
  if (payloads.length === 0) return null;
  if (id === undefined) return null;
  return payloads.find((p) => p && p.id === id) || payloads[payloads.length - 1];
}

let sessionId = null;

const RETRIES = Number(process.env.FD_MCP_RETRIES || 2);

/** One POST, no retry logic. Returns { res, body }. */
async function postOnce(msg) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'figuredeck-mcp-stdio/1.0',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: ctrl.signal,
    });
    return { res, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function forward(msg) {
  // Network flakiness is common enough that a single attempt is a bad default:
  // a transient connect timeout would surface to the model as "server broken".
  // Every method here is read-only, so retrying cannot double an effect.
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res, body;
    try {
      ({ res, body } = await postOnce(msg));
    } catch (err) {
      lastErr = err;
      if (attempt === RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    // 5xx is worth retrying; 4xx means the request itself is wrong.
    if (res.status >= 500 && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }

    if (!res.ok) {
      // Surface HTTP failures as a JSON-RPC error the client can read.
      // Throwing straight up would crash the process and look like "server gone".
      throw Object.assign(new Error(`HTTP ${res.status}`), { detail: body.slice(0, 400) });
    }

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const picked = pickFromSse(body, msg.id);
      if (picked) return picked;
      if (msg.id === undefined) return null;
      throw new Error('no SSE frame carried the request id');
    }

    const text = body.trim();
    if (!text) return null;
    return JSON.parse(text);
  }

  throw lastErr || new Error('request failed');
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * "fetch failed" alone tells the caller nothing. Node nests the real reason in
 * `cause` (ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, TLS errors), so
 * unroll it — otherwise a proxy or DNS problem looks identical to a dead server.
 */
function describe(err) {
  const parts = [err.message];
  let c = err.cause;
  let depth = 0;
  while (c && depth < 5) {
    parts.push(c.code || c.message);
    c = c.cause;
    depth++;
  }
  return parts.filter(Boolean).join(' <- ');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // Notifications (no id) expect no reply, but must still be forwarded —
  // some servers block waiting for notifications/initialized.
  const isNotification = msg.id === undefined || msg.id === null;

  try {
    const out = await forward(msg);
    if (!isNotification && out) write(out);
  } catch (err) {
    const reason = describe(err);
    process.stderr.write(`[figuredeck-mcp] ${reason} ${err.detail || ''}\n`);
    if (!isNotification) {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `upstream error: ${reason}` },
      });
    }
  }
});

rl.on('close', () => process.exit(0));

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
