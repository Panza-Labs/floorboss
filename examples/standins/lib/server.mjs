// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Shared plumbing for the stand-in MCP servers: stdio JSON-RPC, call log, fake data, recurrence.
// These fake real connectors for tests and simulations. They are never shipped as real connectors.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { wallParts, zonedToUtc, dateKey, parseDateKey, addDays } from '../../../lib/tz.mjs';

export const PROTOCOL = '2025-06-18';

// Thrown by a tool on bad input; becomes an isError result, not a JSON-RPC error.
export class BadInput extends Error {}

export function loadData() {
  const path = process.env.STANDIN_DATA;
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function draftsPath() {
  return process.env.STANDIN_DATA ? `${process.env.STANDIN_DATA}.drafts.json` : null;
}

export function loadDrafts() {
  const p = draftsPath();
  return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}

// Re-reads before writing so two servers sharing one data file don't drop each other's drafts.
export function saveDraft(draft) {
  const p = draftsPath();
  if (!p) return;
  const all = loadDrafts().filter((d) => d.id !== draft.id);
  all.push(draft);
  writeFileSync(p, JSON.stringify(all, null, 2) + '\n');
}

function logCall(server, tool, args, ok) {
  const p = process.env.STANDIN_LOG;
  if (!p) return;
  appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), server, tool, args, ok }) + '\n');
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Input helpers.
export function str(args, key, { optional = false } = {}) {
  const v = args?.[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new BadInput(`"${key}" is required and must be a non-empty string.`);
  return v;
}

export function instant(value, key) {
  const t = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(t.getTime())) throw new BadInput(`"${key}" must be an ISO date-time.`);
  return t;
}

export function window(min, max) {
  if (min >= max) throw new BadInput('The window end must be after its start.');
  return [min, max];
}

// Calendar events expanded into instances overlapping [from, to): {event, start, end, allDay, date}.
// Timed recurrences keep their wall-clock time in the calendar's zone, so DST doesn't drift them.
export function expandEvents(calendar = {}, from, to) {
  const zone = calendar.time_zone || 'UTC';
  // A time with no Z or offset is wall time in the calendar's zone, never the machine's.
  const at = (v) =>
    typeof v === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/.test(v) && /T\d{2}:\d{2}/.test(v)
      ? (() => {
          const [d, t] = v.split('T');
          const [hh, mm] = t.split(':').map(Number);
          return zonedToUtc({ ...parseDateKey(d), hh, mm }, zone);
        })()
      : new Date(v);
  const out = [];
  for (const ev of calendar.events || []) {
    const allDay = Boolean(ev.all_day);
    const baseKey = allDay ? ev.date : dateKey(wallParts(at(ev.start), zone));
    const w = allDay ? { hh: 0, mm: 0 } : wallParts(at(ev.start), zone);
    const length = allDay ? 0 : at(ev.end) - at(ev.start);
    const step = { daily: 1, weekly: 7 }[ev.recurrence] || 0;
    for (let k = 0; k < 5000; k++) {
      const key = addDays(baseKey, k * step);
      if (ev.until && key > ev.until) break;
      const start = zonedToUtc({ ...parseDateKey(key), hh: w.hh, mm: w.mm }, zone);
      if (start >= to) break;
      const end = allDay ? zonedToUtc(parseDateKey(addDays(key, 1)), zone) : new Date(start.getTime() + length);
      if (end > from) out.push({ event: ev, start, end, allDay, date: key });
      if (!step) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Runs one server over stdio. tools: { name: { description, inputSchema, run(args) } }.
function faultFor(server, tool) {
  const f = process.env.STANDIN_FAULTS;
  if (!f || !existsSync(f)) return null;
  const rules = JSON.parse(readFileSync(f, 'utf8'));
  const key = rules[`${server}.${tool}`] ? `${server}.${tool}` : rules[`${server}.*`] ? `${server}.*` : null;
  if (!key) return null;
  const countsPath = `${process.env.STANDIN_DATA || f}.calls.json`;
  const counts = existsSync(countsPath) ? JSON.parse(readFileSync(countsPath, 'utf8')) : {};
  const n = (counts[key] || 0) + 1;
  counts[key] = n;
  writeFileSync(countsPath, JSON.stringify(counts));
  const r = rules[key];
  return n > (r.after || 0) && (r.for == null || n <= (r.after || 0) + r.for) ? r.mode || 'error' : null;
}

export function serve(name, tools, { version = '0.1.0' } = {}) {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const handle = (method, params) => {
    if (method === 'initialize') {
      return { protocolVersion: PROTOCOL, serverInfo: { name, version }, capabilities: { tools: {} } };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') {
      return { tools: Object.entries(tools).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema })) };
    }
    if (method === 'tools/call') {
      const tool = tools[params?.name];
      const args = params?.arguments || {};
      if (!tool) {
        logCall(name, params?.name, args, false);
        return { isError: true, content: [{ type: 'text', text: `Unknown tool "${params?.name}".` }] };
      }
      // Injected faults (tests only): STANDIN_FAULTS names a JSON file {"<server>.<tool>" | "<server>.*":
      // {"after": n, "for": m, "mode": "error" | "down" | "timeout"}}. Calls are counted per key in
      // <STANDIN_DATA>.calls.json; calls after+1 … after+m fail (m omitted: every later call), then it recovers.
      const fault = faultFor(name, params.name);
      if (fault === 'down') {
        logCall(name, params.name, args, false);
        process.exit(3);
      }
      if (fault === 'timeout') {
        logCall(name, params.name, args, false);
        process.exit(4);
      }
      if (fault === 'error') {
        logCall(name, params.name, args, false);
        return { isError: true, content: [{ type: 'text', text: `${name}: connection lost (the server could not be reached)` }] };
      }
      try {
        const payload = tool.run(args);
        logCall(name, params.name, args, true);
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      } catch (err) {
        logCall(name, params.name, args, false);
        if (!(err instanceof BadInput)) throw err;
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }
    const e = new Error(`Method not found: ${method}`);
    e.code = -32601;
    throw e;
  };
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = handle(msg.method, msg.params);
      if (isRequest) send({ id: msg.id, result });
    } catch (err) {
      if (isRequest) send({ id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  });
}

// A tool floorboss must never call. It answers plausibly; the call log is what tests check.
export function trap(description, properties, reply) {
  return { description, inputSchema: { type: 'object', properties }, run: (args) => reply(args) };
}
