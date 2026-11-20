// The mock event driven to its outbox in Codex (hand-send) or Claude Code, every first message recorded sent. Built
// once per test process and copied for each test, as the drive takes a while.
import './isolated-home.mjs';
import { writeFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './harness.mjs';
import { simplePersona, drive } from '../sims/lib/driver.mjs';
import { MOCK, envOf, home } from './r2.mjs';

export const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
export const envFor = (HOME, codex, extra = {}) => {
  const env = envOf(HOME, { ...(codex ? CODEX : {}), ...extra });
  if (codex) delete env.CLAUDECODE;
  else for (const k of Object.keys(CODEX)) delete env[k];
  return env;
};
export const runAs = (HOME, codex, skill, args, extra = {}) => {
  try {
    return JSON.parse(execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: envFor(HOME, codex, extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    return { ERROR: String(e.stderr || e.message).slice(0, 800) };
  }
};
const built = {};
function build(codex) {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const env = envFor(HOME, codex);
  execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', NOW], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), rate: 'skip', voice_samples: 'skip', replies_since: 'none' } });
  const r = drive({ HOME, now: NOW, env }, per, { maxSteps: 220 });
  if (!(r.last.done || r.last.step === 'waiting')) throw new Error(r.trail.slice(-6).join(' '));
  const sent = (r.last.summary?.in_outbox_to_send || []).filter((x) => x.touch === 1).map((x) => x.id);
  if (sent.length < 2) throw new Error(JSON.stringify(r.last.summary).slice(0, 300));
  writeFileSync(join(HOME, 'work', 'sent.json'), JSON.stringify({ items: sent.map((who) => ({ who, what: 'sent', date: NOW.slice(0, 10) })) }));
  const rec = runAs(HOME, codex, 'event-outreach', ['record', '--event', MOCK, '--file', join(HOME, 'work', 'sent.json')]);
  if (rec.ERROR) throw new Error(rec.ERROR);
  return { HOME, sent };
}
// A fresh copy of the built home.
export function sentHome(codex) {
  const b = (built[codex] ||= build(codex));
  const HOME = mkdtempSync(join(tmpdir(), 'fb-sent-'));
  cpSync(b.HOME, HOME, { recursive: true });
  return { HOME, sent: b.sent };
}
