#!/usr/bin/env node
// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Talk to one stand-in server over stdio, the way an MCP client would.
// Usage: node call.mjs <server> list
//        node call.mjs <server> call <tool> '<json args>'
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVERS = ['calendar-a', 'calendar-b', 'crm-a', 'crm-b', 'mail-a', 'mail-b', 'gmail', 'browser-app', 'enrich-a'];
const here = dirname(fileURLToPath(import.meta.url));

// Sets the exit code instead of exiting, so piped output is flushed first.
function fail(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exitCode = 1;
}
const nl = process.stdout.isTTY ? '\n' : '';

const [server, verb, tool, rawArgs = '{}'] = process.argv.slice(2);
if (!SERVERS.includes(server)) usage(`Server must be one of: ${SERVERS.join(', ')}.`);
if (verb !== 'list' && !(verb === 'call' && tool)) usage("Usage: node call.mjs <server> list | call <tool> '<json args>'");
let args;
try {
  args = JSON.parse(rawArgs);
} catch {
  usage('Arguments must be JSON.');
}
function usage(text) {
  fail(text);
  process.exit(1);
}

const child = spawn(process.execPath, [join(here, `${server}.mjs`)], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
child.on('exit', (code) => usage(`${server} exited (${code}) before answering.`));

createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) {
    send({ method: 'notifications/initialized' });
    send(verb === 'list' ? { id: 2, method: 'tools/list' } : { id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
    return;
  }
  if (msg.id !== 2) return;
  child.removeAllListeners('exit');
  child.stdin.end();
  if (msg.error) return fail(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
  if (verb === 'list') {
    process.stdout.write(JSON.stringify(msg.result.tools, null, 2) + '\n');
    return;
  }
  const text = msg.result.content.map((c) => c.text).join('');
  if (msg.result.isError) return fail(text);
  process.stdout.write(text + nl);
});

send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'standin-call', version: '0.1.0' } } });
