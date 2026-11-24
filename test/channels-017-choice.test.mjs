// 0.1.7 spec section 1: one question before any drafting, at every setup level and in both hosts: besides email,
// where to reach people. Only the chosen channels are in anyone's sequence; each step is written for its own channel;
// the one approval up front covers every step on every channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, cli, triage, todoJobs, draftApprove, idOf, ROOT, NOW } from './fixtures/harness.mjs';
import { levelAllows, NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { personRoute, routeLength } from '../lib/route.mjs';
import { readLedger, fold, legacyState } from '../lib/ledger.mjs';

const EV = { slug: 'ev', name: 'Expo', start_date: '2026-11-10', app_name: 'Grip', time_zone: 'Europe/Amsterdam' };
const QUESTION = 'Besides email, where do you want to reach people?';
const node = NODES.find((n) => n.id === 'reach_channels');
const inHost = (codex, fn) => {
  const before = { c: process.env.CLAUDECODE, x: process.env.CODEX_SESSION_ID };
  if (codex) { delete process.env.CLAUDECODE; process.env.CODEX_SESSION_ID = 's'; }
  try { return fn(); } finally { process.env.CLAUDECODE = before.c; if (before.x === undefined) delete process.env.CODEX_SESSION_ID; else process.env.CODEX_SESSION_ID = before.x; }
};

test('the question is asked at every setup level, in Claude Code and in Codex, with the same words', () => {
  assert.ok(node, 'there is a channel question');
  const seen = new Set();
  for (const codex of [false, true])
    for (const level of ['quick', 'standard', 'full'])
      inHost(codex, () => {
        const s = { ev: EV, cfg: {}, ans: { setup_level: level }, inv: { found: {} } };
        assert.ok(levelAllows('reach_channels', level) && node.when(s) && !node.done(s), `${level}, ${codex ? 'Codex' : 'Claude Code'}`);
        seen.add(JSON.stringify([node.ask(s), node.options(s)]));
      });
  assert.equal(seen.size, 1, 'one wording in both hosts and at every level');
  const s = { ev: EV, cfg: {}, ans: {} };
  assert.equal(node.ask(s), QUESTION);
  const opts = node.options(s);
  assert.equal(opts.length, 4);
  assert.match(opts[0], /^the event app \(Grip\): /);
  assert.match(opts[1], /^LinkedIn: /);
  assert.match(opts[2], /^both: /);
  assert.match(opts[3], /^email only: /);
  // Each answer says what happens after it, in plain words.
  for (const o of opts) assert.ok(o.split(': ')[1]?.length > 20, o);
  for (const o of [node.ask(s), ...opts]) assert.doesNotMatch(o, /\b(route|touch|slug|connector)/i, o);
  // Asked before the order of channels and before anything is drafted: done only once answered.
  assert.equal(node.done(s), false);
  assert.equal(node.done({ ...s, ans: { reach_asked: true } }), true);
});

test('only the chosen channels are in anyone\'s sequence', () => {
  const FULL = { email: 'a@x.test', profile_url: 'https://www.linkedin.com/in/a' };
  const S = { channels: ['email', 'paste'], linkedin_messages: true };
  const ev = { app_name: 'Grip' };
  assert.deepEqual(personRoute(FULL, ev, { ...S, reach: ['app', 'linkedin'] }), ['email', 'app', 'linkedin', 'email']);
  assert.deepEqual(personRoute(FULL, ev, { ...S, reach: ['app'] }), ['email', 'app', 'email']);
  assert.deepEqual(personRoute(FULL, ev, { ...S, reach: ['linkedin'] }), ['email', 'linkedin', 'email']);
  assert.deepEqual(personRoute(FULL, ev, { ...S, reach: [] }), ['email', 'email']);
  // An order the user gave is kept, less the channels they didn't choose.
  assert.deepEqual(personRoute(FULL, ev, { ...S, reach: ['linkedin'], route: ['linkedin', 'app', 'email'] }), ['linkedin', 'email']);
  assert.equal(routeLength({ ...S, reach: [] }), 2);
  assert.equal(routeLength({ ...S, reach: ['app'] }), 3);
});

const flowAnswer = (HOME, ask, text) => {
  mkdirSync(join(HOME, 'work'), { recursive: true });
  const f = join(HOME, 'work', `${ask}.txt`);
  writeFileSync(f, text);
  return execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--ask', ask, '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
};

test('the answer is saved as the channels chosen, each answer as offered or in the user\'s words', () => {
  for (const [said, reach] of [
    [node.options({ ev: EV })[0], ['app']], [node.options({ ev: EV })[1], ['linkedin']], [node.options({ ev: EV })[2], ['app', 'linkedin']], [node.options({ ev: EV })[3], []],
    ['1', ['app']], ['2', ['linkedin']], ['3', ['app', 'linkedin']], ['4', []], ['just email', []], ['Grip', ['app']], ['linkedin and the app', ['app', 'linkedin']]
  ]) {
    const HOME = mkdtempSync(join(tmpdir(), 'fb-reach-'));
    writeFileSync(join(HOME, 'onboarding.json'), JSON.stringify({ rounds: {}, event: null, answers: { setup_level: 'quick' } }));
    flowAnswer(HOME, 'reach_channels', said);
    const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'));
    assert.deepEqual(cfg.reach, reach, said);
    assert.equal(JSON.parse(readFileSync(join(HOME, 'onboarding.json'), 'utf8')).answers.reach_asked, true, said);
  }
});

const ANA = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
const steps = (H) => todoJobs(H).jobs.filter((j) => j.kind === 'message').sort((a, b) => a.touch - b.touch).map((j) => j.routed || (j.channel === 'email' ? 'email' : j.invite_note ? 'linkedin' : j.channel));

test('nothing is written for a channel the user did not choose; each step is written for its own channel', () => {
  const base = { sending: { channels: ['email', 'app'], followups: 'scheduled' } };
  const at = (reach) => { const H = setup({ attendees: ANA, event: { app_name: 'Grip' }, settings: { ...base, reach } }); triage(H); return steps(H); };
  assert.deepEqual(at([]), ['email', 'email']);
  assert.deepEqual(at(['app']), ['email', 'app', 'email']);
  assert.deepEqual(at(['linkedin']), ['email', 'linkedin', 'email']);
  assert.deepEqual(at(['app', 'linkedin']), ['email', 'app', 'linkedin', 'email']);
});

test('the one approval up front covers every step on every channel', () => {
  const H = setup({ attendees: ANA, event: { app_name: 'Grip' }, settings: { sending: { channels: ['email', 'app'], followups: 'scheduled' }, reach: ['app', 'linkedin'], app_note_times: 'in_app', app_note_event_name: false, app_note_optout: false } });
  triage(H);
  draftApprove(H);
  const st = legacyState(fold(readLedger(join(H.dir, 'ledger.jsonl')).entries))[idOf(H, 'Ana Berg')];
  for (const t of [1, 2, 3, 4]) assert.ok(st.touches[t]?.approved, `message ${t} approved in the one approval`);
});
