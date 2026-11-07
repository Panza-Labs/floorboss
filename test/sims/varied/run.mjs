#!/usr/bin/env node
// Runs the varied personas, two at a time, and writes one summary per persona.
// Usage: node test/sims/varied/run.mjs [id …] --out <dir>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPECS } from './specs.mjs';
import { runPersona } from '../lib/generated.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : join(process.cwd(), 'sim-results');
const only = args.filter((a, i) => !a.startsWith('--') && i !== outAt + 1);
if (process.env.FB_ONE) {
  const spec = SPECS.find((s) => s.id === process.env.FB_ONE);
  const t0 = Date.now();
  const r = runPersona(spec);
  r.seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(join(out, `${spec.id}.json`), JSON.stringify(r, null, 2));
  process.exit(0);
}
mkdirSync(out, { recursive: true });
const queue = SPECS.filter((s) => !only.length || only.includes(s.id)).map((s) => s.id);
const runOne = (id) => new Promise((res) => { const p = spawn(process.execPath, [new URL(import.meta.url).pathname, '--out', out], { env: { ...process.env, FB_ONE: id }, stdio: 'inherit' }); p.on('exit', res); });
const worker = async () => { while (queue.length) { const id = queue.shift(); process.stdout.write(`start ${id}\n`); await runOne(id); process.stdout.write(`done ${id}\n`); } };
await Promise.all([worker(), worker()]);
