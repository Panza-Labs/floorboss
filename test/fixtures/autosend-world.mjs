// A small data folder for the auto-send tests (lib/autosend/): one event with people whose whole email sequence was
// drafted, passed the critic and was approved for its text, written straight into the ledger as the approval step
// writes it. Fast to build, so the unit tests can make one per test. Addresses are .example only.
import './isolated-home.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { approvalHash } from '../../lib/sendcheck.mjs';
import { plannedDays, modeOn } from '../../lib/spacing.mjs';
import { stageData } from '../../lib/autosend/sync.mjs';
import { saveDraft } from '../../lib/drafts.mjs';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const SLUG = 'harbor-expo';
// Monday 12 October 2026, 08:00 UTC: 09:00 in Lisbon (summer time).
export const NOW = '2026-10-12T08:00:00Z';
export const EVENT = { slug: SLUG, name: 'Harbor Expo', city: 'Lisbon', time_zone: 'Europe/Lisbon', start_date: '2026-11-03', end_date: '2026-11-04', autosend: true, settings: {} };
export const OWN = 'sam@lanecraft.example';
export const PEOPLE = [
  { id: 'c001', name: 'Ana Ito', email: 'ana@north.example', company: 'North' },
  { id: 'c002', name: 'Bo Li', email: 'bo@east.example', company: 'East' },
  { id: 'c003', name: 'Cy Moss', email: 'cy@west.example', company: 'West' }
];

export const line = (o) => JSON.stringify(o);
export const draftText = (p, t, extra = '') => ({
  id: p.id,
  touch: t,
  kind: 'message',
  channel: 'email',
  subject: t === 1 ? `At Harbor Expo, ${p.name.split(' ')[0]}` : 'One more thought',
  body: `Hi ${p.name.split(' ')[0]},\n\nMessage ${t} for ${p.company}.${extra} Could we find 20 minutes at Harbor Expo?\n\nBest, Sam\n\nIf this isn't relevant, say so and I won't follow up.`
});

// One message of a person, drafted, read by the critic and approved (as the approval step writes it).
export function approvedLines(evDir, p, t, { at = '2026-10-12T07:00:00Z', extra = '', plan = null, critic = 'PASS', approve = true, channel = 'email', where = null, slot_ids = [] } = {}) {
  const d = { ...draftText(p, t, extra), channel };
  const to = channel === 'email' ? p.email : `${p.name} (${p.company})`;
  // Saved as the real save step saves it (lib/drafts.mjs saveDraft: the text only), and the times it offers on the
  // drafted line (skills/event-outreach/scripts/commands/drafting.mjs), where the guard and the planner read them.
  const hash = saveDraft(evDir, { channel: d.channel, to, subject: d.subject, body: d.body, kind: 'message' });
  if (hash !== approvalHash(d, to)) throw new Error('the saved draft and the approval name different texts');
  const out = [
    { at, type: 'drafted', who: 'floorboss', id: p.id, touch: t, kind: 'message', hash, slot_ids: [...slot_ids], checks: [], ...(plan || {}) },
    ...(critic ? [{ at, type: 'critic', who: 'floorboss', id: p.id, touch: t, hash, verdict: critic, reasons: [] }] : []),
    ...(approve ? [{ at, type: 'approved', who: 'user', id: p.id, touch: t, hash, to, via: 'you', ...(where ? { where } : {}), said: 'approve all' }] : [])
  ];
  return { hash, to, lines: out };
}

// A data folder with the event and its people. touches: messages per person (each follow-up planned from today).
export function world({ touches = 2, people = PEOPLE, event = EVENT, home = null } = {}) {
  const HOME = home || mkdtempSync(join(tmpdir(), 'fb-as-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  const evDir = join(HOME, 'events', event.slug);
  mkdirSync(evDir, { recursive: true });
  // The event's number of messages is the sequence built here (the readback asks for every planned one).
  writeFileSync(join(evDir, 'event.json'), JSON.stringify({ ...event, settings: { ...(event.settings || {}), touches } }, null, 2));
  const lines = [];
  const plan = plannedDays({}, event, NOW.slice(0, 10), modeOn(event, NOW.slice(0, 10)), touches);
  for (const p of people) {
    lines.push({ at: '2026-10-12T06:00:00Z', type: 'person', who: 'floorboss', id: p.id, name: p.name, company: p.company, email: p.email, keys: [`e:${p.email}`] });
    for (let t = 1; t <= touches; t++) {
      const pl = t === 1 ? {} : (({ due, from }) => ({ planned_due: due, planned_gap: 'table', planned_from: from }))(plan.find((x) => x.touch === t));
      lines.push(...approvedLines(evDir, p, t, { plan: pl }).lines);
    }
  }
  writeFileSync(join(evDir, 'ledger.jsonl'), lines.map(line).join('\n') + '\n');
  return { HOME, evDir, slug: event.slug };
}
export const addLines = (evDir, ls) => appendFileSync(join(evDir, 'ledger.jsonl'), ls.map(line).join('\n') + '\n');
export const ledgerLines = (evDir) =>
  existsSync(join(evDir, 'ledger.jsonl'))
    ? readFileSync(join(evDir, 'ledger.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// The auto-send CLI, as Codex runs it (a Codex marker, no CLAUDECODE), or as Claude Code would (claude: true).
export const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
export function envFor(HOME, { claude = false, now = NOW, extra = {} } = {}) {
  const env = { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: now, GIT_CONFIG_NOSYSTEM: '1', ...extra };
  if (claude) {
    env.CLAUDECODE = '1';
    for (const k of Object.keys(CODEX)) delete env[k];
  } else {
    Object.assign(env, CODEX);
    delete env.CLAUDECODE;
  }
  return env;
}
export function autosend(HOME, args, opts = {}) {
  const r = spawnSync('node', [join(ROOT, 'skills/autosend/scripts/cli.mjs'), ...args], { env: envFor(HOME, opts), encoding: 'utf8' });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1200), status: r.status };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ERROR: `not JSON: ${r.stdout.slice(0, 400)}` };
  }
}
export const said = (HOME, words) => {
  const f = join(HOME, 'work', `said-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(f, words);
  return f;
};

// git, for the fake remote: a bare repo in a temp folder, cloned as the laptop and as each cloud run.
export const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
export function remoteFor(HOME) {
  const base = mkdtempSync(join(tmpdir(), 'fb-as-remote-'));
  const bare = join(base, 'data.git');
  git(base, ['init', '--bare', '-q', '-b', 'main', bare]);
  git(HOME, ['init', '-q', '-b', 'main']);
  // Only floorboss's data paths go to the repo (lib/autosend/sync.mjs DATA_RE), as its own sync stages them.
  const st = stageData(HOME);
  if (st.stop) throw new Error(st.stop);
  git(HOME, [...ID, 'commit', '-q', '-m', 'data']);
  git(HOME, ['remote', 'add', 'origin', bare]);
  git(HOME, ['push', '-q', '-u', 'origin', 'main']);
  return { base, bare };
}
// A fresh clone of the remote, as the cloud task makes each run.
export function cloneOf(bare, name = 'cloud') {
  const dir = join(mkdtempSync(join(tmpdir(), `fb-as-${name}-`)), 'data');
  git(tmpdir(), ['clone', '-q', bare, dir]);
  return dir;
}
export const commitsOf = (bare) => git(bare, ['log', '--format=%s', 'main']).trim().split('\n');
export const remoteFile = (bare, path) => {
  try {
    return git(bare, ['show', `main:${path}`]);
  } catch {
    return null;
  }
};
