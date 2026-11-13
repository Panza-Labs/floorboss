// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Round 7 of the run-6 audit fixes: the invariants that make an "ok" after a read-back safe by construction, asserted
// over generated answers and states rather than one example each.
//   I1  only the two gates read or write a pending reading (a grep over the code);
//   I2  at the draft gate an ok-only answer is never saved at once, in any state: it is applied only as a yes to a valid
//       reading the user was shown, and otherwise read back by ID;
//   I3  at the shortlist gate "ok" is the shortlist as shown only when no pending file is there at all;
//   I4  through flow answer and through the gate CLI alike, nobody outside a reading the user was shown is approved, and
//       the shortlist is never saved as shown while a skip was shown and not saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, cpSync, mkdtempSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setup, cli, triage, draftApprove, fitAll, NOW, ROOT } from './fixtures/harness.mjs';
import { readLedger } from '../lib/ledger.mjs';

const THREE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nJohn Lind,VP,Globex,john@globex.test\nCy Ek,CTO,Initech,cy@initech.test\n';
const entries = (H) => readLedger(join(H.dir, 'ledger.jsonl')).entries;
const approved = (H) => [...new Set(entries(H).filter((e) => e.type === 'approved').map((e) => e.id))].sort();
const at = (min) => new Date(Date.parse(NOW) + min * 6e4).toISOString();
const clone = (H) => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-inv-'));
  cpSync(H.HOME, HOME, { recursive: true });
  return { ...H, HOME, dir: join(HOME, 'events', H.slug) };
};
const pendingFile = (H, g) => join(H.dir, 'derived', `pending-${g}.json`);
// The two entry points: the gate's own CLI, and flow answer with the words (or a JSON value) in a file.
const send = (H, gate, via, answer, now = NOW) => {
  if (via === 'gate') return cli(H, gate === 'approval' ? 'event-outreach' : 'crm-triage', ['gate', '--event', H.slug, '--answers', answer], now);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'answer.txt');
  writeFileSync(f, via === 'json' ? JSON.stringify({ answers: answer }) : answer);
  const r = cli(H, 'flow', ['answer', '--event', H.slug, '--ask', gate === 'approval' ? 'approve' : 'gate', '--value-file', f], now);
  return r.result && typeof r.result === 'object' ? { ...r.result, ...(r.ERROR ? { ERROR: r.ERROR } : {}) } : r;
};
// The IDs a read-back lists under "approve" (never under "not approve").
const listedApprove = (text) =>
  new Set(
    String(text || '')
      .split(/;\s*|\.\s+|reads as:\s*/)
      .filter((p) => /^approve /.test(p.trim()))
      .flatMap((p) => p.match(/\bc\d{3,}\b/g) || [])
  );

// A small seeded generator: the same cases every run.
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const OK_WORDS = ['ok', 'okay', 'sure', 'defaults', 'looks good', 'all good', 'go ahead', 'ok gracias', 'ok thanks', 'yes', 'yes please', 'sí', 'great', 'ok :)'];
const DRESS = [
  (w) => w,
  (w) => w.toUpperCase(),
  (w) => w[0].toUpperCase() + w.slice(1),
  (w) => `${w};`,
  (w) => `${w},`,
  (w) => `${w}.`,
  (w) => `${w}!`,
  (w) => `${w} `,
  (w) => `​${w}​`,
  (w) => `\n\n${w}\n\n`,
  (w) => `${w} please`,
  (w) => `${w}, thanks`,
  (w) => `${w} gracias`,
  (w) => `${w} 👍`,
  (w) => `${w};\n;`
];
const okAnswers = (r, n) => Array.from({ length: n }, () => DRESS[Math.floor(r() * DRESS.length)](OK_WORDS[Math.floor(r() * OK_WORDS.length)]));
const isAgreementWord = async (t) => (await import('../lib/reading.mjs')).isAgreement(t);
const isYesWord = async (t) => (await import('../lib/reading.mjs')).isYes(t);

// The states a second answer can meet: a valid reading, one too old, one read against a list or verdict that changed,
// an unreadable file, the trace of a reading another answer replaced, and nothing at all.
const STATES = ['valid', 'stale', 'changed', 'unreadable', 'dropped', 'nothing'];
function enter(H, gate, state, first) {
  if (state === 'nothing') return { shown: '' };
  const r = send(H, gate, 'gate', first);
  assert.equal(r.pending, true, `${first}: read back first`);
  if (state === 'changed') {
    if (gate === 'approval') cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', 'c002', '--touch', '1', '--text', 'FAIL\n- too long']);
    else cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', 'c002', '--group', 'warm', '--because', 'met at the fair']);
  }
  if (state === 'unreadable') writeFileSync(pendingFile(H, gate === 'approval' ? 'approval' : 'shortlist'), '{ not json');
  if (state === 'dropped') assert.ok(send(H, gate, 'gate', 'frobnicate everyone').ERROR, 'a refused answer replaces the reading');
  return { shown: r.say_to_user };
}

test('I1: nothing but the two gates and lib/reading.mjs reads or writes a pending reading', () => {
  const NAMES = /\b(?:dropPending|clearPending|savePending|peekPending|takePending|hasPending|readPending|markDropped|justDropped|clearDropped)\b|pending-(?:approval|shortlist)|pending-\$\{/;
  const OWNERS = new Set(['lib/reading.mjs', 'skills/crm-triage/scripts/cli.mjs', 'skills/event-outreach/scripts/commands/approval.mjs']);
  const found = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:mjs|js|cjs)$/.test(f) && !OWNERS.has(relative(ROOT, p)) && NAMES.test(readFileSync(p, 'utf8'))) found.push(relative(ROOT, p));
    }
  };
  for (const d of ['skills', 'hooks', 'lib', 'scripts']) walk(join(ROOT, d));
  assert.deepEqual(found, []);
});

test('I2 + I4 at the draft gate: an ok-only answer approves nobody unless it agrees to a valid reading shown, through both entry points', async () => {
  const base = setup({ attendees: THREE });
  triage(base);
  draftApprove(base, NOW, 'edit c001');
  const all = ['c001', 'c002', 'c003'];
  const r = rng(7);
  const cases = [];
  // The reviewer's own cases first, then generated ones.
  for (const a of ['ok gracias', 'defaults', 'defaults;', 'Defaults.', 'ok, gracias', 'defaults thanks', 'defaults ']) cases.push({ first: 'approve all except Cy please', state: 'valid', via: 'flow', a });
  cases.push({ first: 'approve all except Cy please', state: 'valid', via: 'json', a: 'defaults' });
  for (const state of STATES)
    for (const via of ['gate', 'flow'])
      for (const a of okAnswers(r, 2)) cases.push({ first: r() < 0.5 ? 'approve all except Cy please' : 'drop Cy', state, via, a });
  for (const k of cases) {
    const H = clone(base);
    const { shown } = enter(H, 'approval', k.state, k.first);
    const res = send(H, 'approval', k.via, k.a, k.state === 'stale' ? at(31) : NOW);
    const label = `${k.state} ${k.via} ${JSON.stringify(k.first)} -> ${JSON.stringify(k.a)}`;
    const got = approved(H);
    const agreed = k.state === 'valid' && (await isAgreementWord(k.a));
    if (agreed) for (const id of got) assert.ok(listedApprove(shown).has(id), `${label}: ${id} was in the reading shown (${shown})`);
    else assert.deepEqual(got, [], `${label}: an ok-only answer approved nobody: ${JSON.stringify(res).slice(0, 300)}`);
    // An ok-only answer is read back (a word the gate doesn't take, "great", is refused and saves nothing).
    if (!agreed && !(await isYesWord(k.a)) && !res.ERROR) assert.equal(res.pending, true, `${label}: an ok-only answer is read back: ${JSON.stringify(res).slice(0, 300)}`);
    if (!agreed && res.pending) {
      // Read back by ID: every person is named, approved or not, and the yes saves exactly the IDs listed.
      for (const id of all) assert.match(res.say_to_user, new RegExp(`\\b${id}\\b`), `${label}: ${id} is named`);
      const yes = send(H, 'approval', 'gate', 'yes', k.state === 'stale' ? at(31) : NOW);
      assert.ok(!yes.ERROR, `${label}: ${yes.ERROR}`);
      assert.deepEqual(approved(H), [...listedApprove(res.say_to_user)].sort(), `${label}: the yes saved exactly what was listed: ${res.say_to_user}`);
    }
  }
  // "ok :)" or "great", then "ok": the second "ok" agrees to the read-back the first one produced, nothing more.
  for (const first of ['ok :)', 'great']) {
    const H = clone(base);
    const a = send(H, 'approval', 'flow', first);
    assert.deepEqual(approved(H), [], first);
    const b = send(H, 'approval', 'flow', 'ok');
    if (a.pending) assert.deepEqual(approved(H), [...listedApprove(a.say_to_user)].sort(), `${first} then ok`);
    else assert.ok(b.pending || b.ERROR, `${first} then ok is read back: ${JSON.stringify(b).slice(0, 200)}`);
  }
  // Approving everyone at once still takes the words.
  const W = clone(base);
  assert.ok(send(W, 'approval', 'gate', 'approve all').approved >= 1);
});

test('I3 + I4 at the shortlist gate: "ok" is the shortlist as shown only with no pending file at all, through both entry points', async () => {
  const base = setup({ attendees: THREE });
  fitAll(base, cli(base, 'crm-triage', ['load', '--event', base.slug]));
  const r = rng(11);
  const cases = [];
  for (const state of STATES)
    for (const via of ['gate', 'flow'])
      for (const a of okAnswers(r, 2)) cases.push({ first: r() < 0.5 ? 'skip Cy' : 'skip Cy please', state, via, a });
  for (const a of ['defaults', 'defaults;', 'ok gracias']) cases.push({ first: 'skip Cy', state: 'valid', via: 'json', a });
  const savedAsShown = (H) => entries(H).some((e) => e.type === 'answered' && e.ask === 'gate');
  const cySkipped = (H) => entries(H).some((e) => e.type === 'decide' && e.id === 'c003' && e.group === 'skip');
  for (const k of cases) {
    const H = clone(base);
    enter(H, 'shortlist', k.state, k.first);
    const now = k.state === 'stale' ? at(31) : NOW;
    const res = send(H, 'shortlist', k.via, k.a, now);
    const label = `${k.state} ${k.via} ${JSON.stringify(k.first)} -> ${JSON.stringify(k.a)}`;
    if (k.state !== 'nothing') assert.ok(!(savedAsShown(H) && !cySkipped(H)), `${label}: never saved as shown over a skip shown and not saved: ${JSON.stringify(res).slice(0, 300)}`);
    const agreed = k.state === 'valid' && (await isAgreementWord(k.a));
    if (k.state !== 'nothing' && !agreed && !res.pending) {
      // An ok-only answer said the reading can't be used and cleared the file, so the very next "ok" is the shortlist
      // as shown; an answer the gate refused leaves the trace, and the "ok" after it is told so once.
      if (!res.ERROR) assert.ok(!existsSync(pendingFile(H, 'shortlist')), `${label}: the file is cleared`);
      const trace = existsSync(pendingFile(H, 'shortlist'));
      const next = send(H, 'shortlist', 'gate', 'ok', now);
      if (trace) assert.match(next.say_to_user || '', /can't be used|was dropped/, `${label}: told once`);
      if (!savedAsShown(H)) send(H, 'shortlist', 'gate', 'ok', now);
      assert.ok(savedAsShown(H), `${label}: then "ok" saves the shortlist as shown`);
    }
  }
});

test('a shortlist answer between a read-back and its yes makes the reading stale: nobody shown as "not approve" is approved', () => {
  const base = setup({ attendees: THREE });
  triage(base);
  draftApprove(base, NOW, 'edit c001');
  // Cut to one, read back ("approve one; not approve two"), widen again without naming anybody, then yes.
  for (const [cut, back] of [
    ['keep 1', 'keep 3'],
    ['skip c002', 'reach c002']
  ]) {
    for (const via of ['gate', 'flow']) {
      const H = clone(base);
      const t1 = send(H, 'shortlist', 'gate', cut);
      assert.ok(!t1.ERROR, `${cut}: ${t1.ERROR}`);
      const shownAs = send(H, 'approval', via, 'ok');
      const shown = shownAs.say_to_user || '';
      assert.match(shown, /not approve/, `${cut}: the read-back says who is not approved (${shown})`);
      const listed = listedApprove(shown);
      const t2 = send(H, 'shortlist', 'gate', back);
      assert.ok(!t2.ERROR, `${back}: ${t2.ERROR}`);
      const y = send(H, 'approval', via, 'yes');
      assert.match(JSON.stringify(y), /can't be used/, `${cut} -> ${back} (${via}): the yes is refused as stale (${JSON.stringify(y).slice(0, 300)})`);
      for (const id of approved(H)) assert.ok(listed.has(id), `${cut} -> ${back} (${via}): ${id} approved though the read-back did not list it under approve`);
      assert.deepEqual(approved(H), [], `${cut} -> ${back} (${via}): nothing saved on a stale yes`);
    }
  }
});
