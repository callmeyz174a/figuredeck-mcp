#!/usr/bin/env node
/**
 * Does the proxy actually send the user-agent it says it sends?
 *
 * The endpoint mirrors this header into its call counter, and that counter is
 * the only evidence anyone outside calls the server. A UA that silently reverts
 * to a hard-coded value would not break a single tool call — it would just make
 * the usage numbers meaningless, and nothing else in this repo would notice.
 *
 * So the check runs offline against a throwaway local server instead of the live
 * endpoint: it can then assert the exact header, and it adds nothing to the
 * numbers it is defending.
 *
 *   node test/ua.js
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = join(HERE, '..', 'bin', 'figuredeck-mcp.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failures++;
}

/** Start a server that records the UA of every request and answers JSON-RPC. */
function collector() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ ua: req.headers['user-agent'] || '(absent)', body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

/** Send one initialize through the proxy and wait for its reply. */
function runOnce(url, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROXY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FD_MCP_URL: url, FD_MCP_TIMEOUT_MS: '10000', ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ua-check', version: '1' } },
      }) + '\n',
    );
    child.stdin.end();
    const done = () => resolve(out);
    child.on('close', done);
    setTimeout(() => child.kill(), 12000);
  });
}

async function main() {
  const { server, seen, port } = await collector();
  const url = `http://127.0.0.1:${port}/mcp`;

  const replied = await runOnce(url, { FD_MCP_UA: 'figuredeck-smoke/1.0' });
  check('proxy answers through the local server', /protocolVersion/.test(replied), replied.slice(0, 120));
  check(
    'the header is the configured one, not a hard-coded default',
    seen.length === 1 && seen[0].ua === 'figuredeck-smoke/1.0',
    JSON.stringify(seen.map((s) => s.ua)),
  );

  const before = seen.length;
  await runOnce(url, { FD_MCP_UA: '' });
  const fallback = seen[before];
  check(
    'with no override the proxy identifies as a proxied call',
    !!fallback && /^figuredeck-mcp-stdio\//.test(fallback.ua),
    JSON.stringify(fallback && fallback.ua),
  );

  server.close();
  console.log('');
  if (failures) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((e) => {
  console.log(`FAIL  aborted: ${e.message}`);
  process.exit(1);
});
