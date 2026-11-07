// Shared setup for the regression tests: a temp FLOORBOSS_HOME with one event, run through the real CLIs.
// Loaded first, so even a bare node --test can't reach the real home.
import './isolated-home.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, cpSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// floorboss's clock may be moved (--now, FLOORBOSS_NOW) only under its own tests.
process.env.FLOORBOSS_TEST = '1';
export const ROOT = new URL('../..', import.meta.url).pathname;
export const NOW = '2026-10-12T08:00:00Z';

// The home folder, for a test that has to write where a real one would be (a fake key, an agents folder): only
// ever the temp home the test preload set up (test/fixtures/isolated-home.mjs), never the real one.
// A call made as the flow makes it while saving one answer (FLOORBOSS_SAVED_BY): for tests of the settings only an
// answer may set (sending, own_email, drafter, drafting_mode).
export function asAnswer(ask, fn) {
  const before = process.env.FLOORBOSS_SAVED_BY;
  process.env.FLOORBOSS_SAVED_BY = ask;
  try { return fn(); } finally { if (before === undefined) delete process.env.FLOORBOSS_SAVED_BY; else process.env.FLOORBOSS_SAVED_BY = before; }
}

export function fakeHomeDir() {
  const h = process.env.FLOORBOSS_ISOLATED_HOME;
  if (!h || homedir() !== h) throw new Error('This test writes into the home folder: run it with npm run unit (the preload points HOME at a temp folder).');
  return h;
}

import { draftFor, makeHome, drive, simplePersona } from '../sims/lib/driver.mjs';

// A fresh home driven through onboarding until the flow asks where the attendee list is (list_source), the
// only moment that answer is saved. Returns the driver's home ({ HOME, env, now }) with the event's slug and
// folder; run commands on it with the driver's cli (its env keeps the scan off the real home).
export function atListSource() {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' } });
  let at = null;
  try { drive(H, simplePersona({}), { onStep: (s) => { if (s.ask?.id === 'list_source') { at = s; throw new Error('at list_source'); } } }); } catch (e) { if (!at) throw e; }
  return { ...H, slug: at.event, dir: join(H.HOME, 'events', at.event) };
}
export function setup({ attendees, crm, dnc, accounts, settings = {}, event = {}, home = null }) {
  const HOME = home || mkdtempSync(join(tmpdir(), 'fb-test-'));
  const slug = event.slug || 'ev';
  const dir = join(HOME, 'events', slug);
  mkdirSync(dir, { recursive: true });
  const ctx = join(HOME, 'context', 'buyers');
  cpSync(join(ROOT, 'examples/mock-event/context/buyers'), ctx, { recursive: true });
  if (attendees != null) writeFileSync(join(dir, 'attendees.csv'), attendees);
  if (crm != null) writeFileSync(join(dir, 'crm.csv'), crm);
  if (dnc != null) writeFileSync(join(dir, 'dnc.txt'), dnc);
  if (accounts != null) writeFileSync(join(dir, 'accounts.csv'), accounts);
  const ev = { slug, name: 'Test Expo', city: 'Rotterdam', time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12',
    context_profile: 'buyers', context_dir: ctx, ...(crm != null ? { crm: { path: join(dir, 'crm.csv') } } : {}), ...(dnc != null ? { dnc_path: join(dir, 'dnc.txt') } : {}),
    ...(accounts != null ? { accounts_path: join(dir, 'accounts.csv') } : {}),
    settings: { goal: 'meet buyers', own_company: 'Lanecraft', own_domains: ['lanecraft.example'], crm_user_name: 'Sam Rivera', status_map: null, ...settings }, ...event };
  writeFileSync(join(dir, 'event.json'), JSON.stringify(ev));
  writeFileSync(join(dir, 'slots.json'), JSON.stringify({ slots: [
    { id: 's20261110T1000', start: '2026-11-10T09:00:00Z', end: '2026-11-10T09:30:00Z' }, { id: 's20261110T1100', start: '2026-11-10T10:00:00Z', end: '2026-11-10T10:30:00Z' },
    { id: 's20261110T1200', start: '2026-11-10T11:00:00Z', end: '2026-11-10T11:30:00Z' }, { id: 's20261110T1300', start: '2026-11-10T12:00:00Z', end: '2026-11-10T12:30:00Z' }] }));
  return { HOME, dir, slug };
}

function markTasks(H, f) {
  let keys = [];
  try {
    keys = (JSON.parse(readFileSync(f, 'utf8')).tasks || []).map((t) => t.key).filter(Boolean);
  } catch {
    return;
  }
  const dir = join(H.dir, 'released');
  mkdirSync(dir, { recursive: true });
  for (const k of keys) writeFileSync(join(dir, `task-${createHash('sha256').update(String(k)).digest('hex').slice(0, 32)}`), NOW);
}
// Runs a CLI; returns its JSON, or { ERROR } with stderr.
export function cli(H, skill, args, now = NOW) {
  // A receipt is taken only for a task the guard let through (it marks each, after the call ran). Tests that save
  // receipts directly stand in for that call, unless they set H.realTaskMarks to test the refusal itself.
  if (skill === 'event-outreach' && args[0] === 'tasks-created' && !H.realTaskMarks) markTasks(H, args[args.indexOf('--file') + 1]);
  try {
    return JSON.parse(execFileSync('node', [join(ROOT, 'skills', skill, 'scripts/cli.mjs'), ...args], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) { return { ERROR: String(e.stderr || e.message).slice(0, 800) }; }
}

export function fitAll(H, load, segment = 'ops-leaders') {
  const f = join(H.dir, 'fits.json');
  writeFileSync(f, JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment, reason: `${r.title} at ${r.company}`, score: 80 }))));
  return cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', f]);
}

export function triage(H, loadArgs = [], gate = 'defaults') {
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug, ...loadArgs]);
  if (load.ERROR) return { load };
  const fit = fitAll(H, load);
  return { load, fit, gate: cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', gate]) };
}

export function todoJobs(H, now = NOW) {
  const t = cli(H, 'event-outreach', ['todo', '--event', H.slug], now);
  if (t.ERROR) return { t, jobs: [] };
  const f = JSON.parse(readFileSync(t.todo_file, 'utf8'));
  return { t, jobs: f.jobs, insights: f.insights };
}

// The compat view writes `final` on every load; someone not judged yet shows as `not_drafted` there, so for
// them the pre-fit group ('open') is the one a test means, as it was when `final` existed only after fit.
export const groups = (H) => {
  const tr = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'triage.json'), 'utf8'));
  const contacts = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts;
  const g = (id) => (tr.final?.[id] && (tr.fits?.[id] || tr.final[id].group !== 'not_drafted') ? tr.final[id] : tr.pre?.[id]) || tr.final?.[id];
  return Object.fromEntries(contacts.map((c) => [c.name, g(c.id)?.group]));
};
export const idOf = (H, name) => JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.find((c) => c.name === name)?.id;

// Draft, PASS and approve everything todo hands out.
export function draftApprove(H, now = NOW) {
  const r = todoJobs(H, now);
  const opt = r.t.optout_sentence;
  for (const j of r.jobs) {
    const first = j.contact.name.split(' ')[0];
    const times = j.slot_labels?.length ? `Could you do ${j.slot_labels.join(' or ')}?` : 'Could we find 30 minutes at Test Expo?';
    const d = j.kind === 'coordinate' ? { body: `${j.holder}, ${j.contact.name} is at Test Expo. Want to reach out?` }
      : j.kind === 'confirmation' ? { subject: 'Re: Test Expo', body: `Hi ${first}, confirming ${j.slot_labels.join('')}. See you at Test Expo.\n\nBest, Sam` }
        : (({ body, structure, fact_source, insight }) => ({ subject: 'Test Expo', body: j.slot_labels?.length ? body : body.replace(/Could you do .*\?/, times), brief: 'x', structure, fact_source, ...(insight ? { insight } : {}) }))(draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] }));
    cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify(d)], now);
    if (j.kind !== 'coordinate') cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
  }
  return { jobs: r.jobs, gate: cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now) };
}

export const outboxHas = (H, name) => readFileSync(join(H.dir, 'outbox.html'), 'utf8').includes(name);
