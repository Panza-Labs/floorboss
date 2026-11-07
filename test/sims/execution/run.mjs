#!/usr/bin/env node
// Runs the forty execution scenarios, four at a time, one JSON result per scenario, then a summary.
// Usage: node test/sims/execution/run.mjs [id …] --out <dir> [--workers 4]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SPECS } from './specs.mjs';
import { runPersona } from '../lib/generated.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = flag('--out', join(process.cwd(), 'exec-results'));
const workers = Number(flag('--workers', 4));
const only = args.filter((a, i) => !a.startsWith('--') && !['--out', '--workers'].includes(args[i - 1]));
if (process.env.FB_ONE) {
  const spec = SPECS.find((s) => s.id === process.env.FB_ONE);
  const t0 = Date.now();
  let r;
  try { r = runPersona(spec, { maxSteps: Number(process.env.FB_MAX || 900) }); } catch (e) { r = { id: spec.id, stages: [{ name: 'crash', ok: false, error: String(e.stack || e).slice(0, 1500) }] }; }
  r.seconds = Math.round((Date.now() - t0) / 1000);
  writeFileSync(join(out, `${spec.id}.json`), JSON.stringify(r, null, 2));
  process.exit(0);
}
mkdirSync(out, { recursive: true });
const queue = SPECS.filter((s) => !only.length || only.includes(s.id)).map((s) => s.id);
const runOne = (id) => new Promise((res) => { const p = spawn(process.execPath, [new URL(import.meta.url).pathname, '--out', out], { env: { ...process.env, FB_ONE: id }, stdio: ['ignore', 'ignore', 'inherit'] }); p.on('exit', res); });
const worker = async () => { while (queue.length) { const id = queue.shift(); process.stdout.write(`start ${id}\n`); await runOne(id); process.stdout.write(`done ${id}\n`); } };
await Promise.all(Array.from({ length: workers }, worker));
const rows = SPECS.filter((s) => !only.length || only.includes(s.id)).map((s) => { const f = join(out, `${s.id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { id: s.id, stages: [{ name: 'missing', ok: false }] }; });
const summary = rows.map((r) => ({ id: r.id, s: r.seconds, stages: r.stages.map((x) => `${x.name}:${x.ok ? 'ok' : 'FAIL'}`).join(' '), error: r.stages.find((x) => !x.ok)?.error?.slice(0, 300) || null, draft_trips: r.draft_trips, problems: r.check?.problems || [], counts: r.check?.counts || null, friction: (r.friction || []).map((f) => `${f.ask}: ${f.question.slice(0, 90)}`) }));
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`${summary.filter((x) => !x.error && !x.problems.length).length}/${summary.length} clean`);
