#!/usr/bin/env node
/**
 * End-to-end check: spawn the stdio proxy once, speak the real protocol,
 * assert real numbers.
 *
 * Why not a "can I connect" check: that kind stays green even when the server
 * returns empty arrays. Here we assert specific dollar amounts, so a data
 * change that slips through turns this red — which is the red we want.
 *
 *   node test/smoke.js
 *   FD_MCP_URL=http://127.0.0.1:8788/mcp node test/smoke.js
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY = join(HERE, '..', 'bin', 'figuredeck-mcp.js');

// Some networks (corporate proxies, sandboxes) add tens of seconds of latency.
// Assertions are unchanged; only the patience is configurable.
const RPC_TIMEOUT_MS = Number(process.env.FD_SMOKE_TIMEOUT_MS || 30000);

// One-unit home, King County WA, calendar year 2026. From the FHFA county file.
const EXPECT = {
  kingCountyLimit: 1063750,
  payment400k: 2528,
};

// This suite runs against the live endpoint, and the endpoint counts every
// tools/call. Sending the default UA would make our own checks indistinguishable
// from a real user, so the runner identifies itself. Overriding is allowed, but
// the default is what protects the usage numbers.
const UA = process.env.FD_MCP_UA || 'figuredeck-smoke/1.0';

const child = spawn(process.execPath, [PROXY], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, FD_MCP_UA: UA },
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON line on stdout (stdio stream polluted): ${line.slice(0, 120)}`);
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS / 1000}s`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(`${method} returned an error: ${JSON.stringify(m.error)}`));
      else resolve(m.result);
    });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  if (!ok) failures++;
}
function fail(msg) {
  console.log(`FAIL  ${msg}`);
  failures++;
}

function textOf(res) {
  const c = res && res.content;
  if (!Array.isArray(c) || !c.length) return '';
  return c.map((x) => x.text || '').join('\n');
}

/**
 * Pull an amount out of the reply by anchoring on the sentence pattern.
 *
 * Do not take "the first $ amount": the first version did exactly that and the
 * payment assertion grabbed the loan amount ($400,000), which appears earlier
 * in the sentence, producing a false red. Anchoring is the fix.
 */
function moneyIn(text, pattern) {
  const m = text.match(pattern);
  if (!m) return null;
  return Number(m[1].replace(/[$,]/g, ''));
}

async function main() {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'figuredeck-smoke', version: '1.0.0' },
  });
  check('initialize carries a protocolVersion', !!init.protocolVersion, JSON.stringify(init).slice(0, 200));
  check(
    'serverInfo identifies FigureDeck',
    /figuredeck/i.test(JSON.stringify(init.serverInfo || {})),
    JSON.stringify(init.serverInfo),
  );

  // Skipping this leaves some servers waiting until timeout.
  notify('notifications/initialized', {});

  const list = await rpc('tools/list', {});
  const names = (list.tools || []).map((t) => t.name).sort();
  check('tools/list returns 3 tools', names.length === 3, `got ${names.length}: ${names}`);
  for (const want of ['search_conforming_limits', 'mortgage_payment', 'affordability']) {
    check(`tool present: ${want}`, names.includes(want), names.join(','));
  }

  const limits = await rpc('tools/call', {
    name: 'search_conforming_limits',
    arguments: { county: 'King County, WA' },
  });
  const lt = textOf(limits);
  const got = moneyIn(lt, /conforming limit is \$([0-9,]+)/);
  check(
    `King County one-unit limit = $${EXPECT.kingCountyLimit.toLocaleString('en-US')}`,
    got === EXPECT.kingCountyLimit,
    `got ${got === null ? '(no amount parsed out of the reply)' : '$' + got.toLocaleString('en-US')}, text: ${lt.slice(0, 200)}`,
  );

  const pay = await rpc('tools/call', {
    name: 'mortgage_payment',
    arguments: { loan_amount: 400000, annual_rate_percent: 6.5, term_years: 30 },
  });
  const pt = textOf(pay);
  const pmt = moneyIn(pt, /is \$([0-9,]+) a month/);
  check(
    `$400k @ 6.5% / 30y payment ~ $${EXPECT.payment400k.toLocaleString('en-US')}`,
    pmt !== null && Math.abs(pmt - EXPECT.payment400k) <= 2,
    `got ${pmt}, text: ${pt.slice(0, 200)}`,
  );

  const aff = await rpc('tools/call', {
    name: 'affordability',
    arguments: {
      monthly_income: 8000,
      annual_rate_percent: 6.5,
      term_years: 30,
      monthly_debts: 400,
      down_payment: 60000,
    },
  });
  const at = textOf(aff);
  const price = moneyIn(at, /purchase price of \$([0-9,]+)/);
  check(
    'affordability returns a usable price ceiling',
    price !== null && price > 200000 && price < 900000,
    `got ${price}, text: ${at.slice(0, 200)}`,
  );

  child.kill();
  console.log('');
  if (failures) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((e) => {
  child.kill();
  console.log(`FAIL  aborted: ${e.message}`);
  process.exit(1);
});
