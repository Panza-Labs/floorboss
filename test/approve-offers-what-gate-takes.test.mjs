// What the approve step offers is what the gate can approve: one rule for both (event-outreach approval.mjs
// planApproval). A draft the gate would refuse with nothing changed (its working copy edited by hand after it was saved;
// a LinkedIn note over the note limit as the settings stand now) is never offered: it is said once as a held line with
// what to say, the others are approved, and the flow finishes in a bounded number of steps. With whole sequences and
// without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPECS } from './sims/varied/specs.mjs';
import { buildPersona } from './sims/lib/generated.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { NOW } from './fixtures/harness.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';

const BASE = SPECS.find((s) => s.id === 'crm-connected-drops');
const spec = (whole, o = {}) => ({ ...BASE, id: `offer-${whole ? 'whole' : 'single'}`, gen: { ...BASE.gen, n: 12, ...(o.gen || {}) }, connected: whole ? ['send'] : [], faults: undefined, toolDown: undefined, asks: { ...BASE.asks, ...(o.asks || {}) } });
const ledger = (P) => readFileSync(join(P.H.HOME, 'events', P.per.slug, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const approvedOf = (P) => new Set(ledger(P).filter((x) => x.type === 'approved').map((x) => `${x.id}:${x.touch}`));

// Runs the persona; at the first approval, before the answer, spoil(P, ids, todo) makes one offered draft one the gate
// refuses with nothing changed, and returns it.
function run(whole, spoil, o) {
  const P = buildPersona(spec(whole, o));
  let target = null;
  const told = [], offers = [];
  const r = drive(P.H, P.per, { maxSteps: 200, onStep: (s) => {
    if (s.tell_user) told.push(s.tell_user);
    if (s.step !== 'approve') return;
    const ids = s.run_first[s.run_first.indexOf('--ids') + 1].split(',');
    offers.push(ids);
    if (!target) target = spoil(P, ids, JSON.parse(readFileSync(join(P.H.HOME, 'events', s.event, 'derived', 'todo.json'), 'utf8')), s.event);
  } });
  P.per.slug = r.slug;
  return { P, r, target, told, offers };
}

function check({ P, r, target, told, offers, before = false }, why) {
  assert.ok(target, 'a draft was spoiled');
  assert.ok(r.last.done || ['waiting', 'second_yes'].includes(r.last.step), r.trail.slice(-8).join(' → '));
  assert.ok(r.trail.filter((x) => x === 'approve').length <= 2, `the approval came back: ${r.trail.join(' ')}`);
  // Offered after it was spoiled: never (spoiled before the approval, not even once).
  assert.ok(!offers.slice(before ? 0 : 1).flat().some((x) => x.startsWith(`${target.split(':')[0]}:`)), JSON.stringify(offers));
  const ok = approvedOf(P);
  assert.ok(!ok.has(target), `${target} was approved`);
  const others = [...new Set(offers[0])].filter((x) => !x.startsWith(`${target.split(':')[0]}:`));
  assert.ok(others.length >= 2, JSON.stringify(offers[0]));
  // Everyone else on the screen was approved, or is named in a held line for the same reason (a lower LinkedIn limit
  // holds every note over it).
  const heldNamed = (k) => told.some((t) => t.includes(`(${k}) is rewritten or dropped`) && why.test(t));
  assert.deepEqual(others.filter((x) => !ok.has(x) && !heldNamed(x)), [], 'everyone else on the screen was approved');
  const line = told.find((t) => t.includes(`(${target}) is rewritten or dropped`) && why.test(t));
  assert.ok(line, `one held line names the message and why: ${JSON.stringify(told.slice(-3))}`);
}

// Case 3: the working copy of an offered draft is edited by hand after it was saved.
const handEdit = (P, ids, todo) => {
  const k = ids.find((x) => /:1$/.test(x));
  const j = todo.jobs.find((x) => `${x.id}:${x.touch}` === k);
  const d = JSON.parse(readFileSync(j.draft_file, 'utf8'));
  writeFileSync(j.draft_file, JSON.stringify({ ...d, body: `${d.body}\n\nP.S. one more line, typed by hand.` }));
  return k;
};
for (const whole of [false, true])
  test(`a working copy edited by hand after saving is not offered again${whole ? ' (whole sequences)' : ''}`, { timeout: 1200000 }, () => {
    check(run(whole, handEdit), /its text changed after/);
  });

// Case 2: the LinkedIn note limit is lowered after a LinkedIn note passed its checks (the mock event has LinkedIn
// notes to paste). With whole sequences: sending on, through the stand-in Gmail.
const SEND = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };
function mockRun(whole) {
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, ...(whole ? { sending: { channels: ['email'], followups: 'scheduled' }, connectors: { 'email.send': SEND } } : {}) }));
  loadMock(HOME);
  // The mock's profile links, as LinkedIn ones: the people with no address get LinkedIn notes to paste.
  const list = join(HOME, 'events', MOCK, 'attendees.csv');
  writeFileSync(list, readFileSync(list, 'utf8').replaceAll('https://example.com/in/', 'https://www.linkedin.com/in/'));
  const H = { HOME, now: NOW, env: envOf(HOME) };
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  let target = null;
  const told = [], offers = [];
  const trail = [];
  // Up to the first approval, unanswered: then the limit is lowered to one character under one LinkedIn note.
  try {
    drive(H, per, { maxSteps: 200, onStep: (s) => {
      if (s.step !== 'approve') return;
      const ids = s.run_first[s.run_first.indexOf('--ids') + 1].split(',');
      const todo = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
      // A note to paste, for someone with no address and a LinkedIn profile (the mock has no event app).
      const j = todo.jobs.find((x) => ids.includes(`${x.id}:${x.touch}`) && x.kind === 'message' && x.channel === 'paste');
      if (j) {
        const body = String(JSON.parse(readFileSync(j.draft_file, 'utf8')).body || '');
        const f = join(HOME, 'config.json');
        writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), linkedin_note_limit: body.length - 1 }));
        target = `${j.id}:${j.touch}`;
      }
      throw Object.assign(new Error('at the approval'), { stop: true });
    } });
  } catch (e) {
    if (!e.stop) throw e;
  }
  let r;
  try {
    r = drive(H, per, { maxSteps: 200, onStep: (s) => {
      trail.push(s.step);
      if (s.tell_user) told.push(s.tell_user);
      // The first send: the flow is past the approval (sending itself is other tests' business).
      if (s.call) throw Object.assign(new Error('past the approval'), { reached: true });
      if (s.step === 'approve') offers.push(s.run_first[s.run_first.indexOf('--ids') + 1].split(','));
    } });
  } catch (e) {
    if (!e.reached) throw e;
    r = { trail, last: { step: 'waiting' } };
  }
  const P = { H, per: { slug: MOCK } };
  return { P, r, target, told, offers };
}
for (const whole of [false, true])
  test(`a LinkedIn note over the limit as it stands now is not offered again${whole ? ' (whole sequences)' : ''}`, { timeout: 1200000 }, () => {
    check({ ...mockRun(whole), before: true }, /LinkedIn allows in a connection note/);
  });
