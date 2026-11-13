// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The two gates' answers about people, round 3 of the run-6 audit fixes: an answer made only of the gate's own words,
// IDs and whole names that can mean one person is saved at once; anything else that reads one way waits on disk,
// read back by ID and name, for the user's own yes. The pending reading's whole life, and a property test of the
// DIRECT rule over generated lists and answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, cpSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, todoJobs, fitAll, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { spawnSync } from 'node:child_process';
import { readLedger, append } from '../lib/ledger.mjs';
import { directReading, shown } from '../lib/reading.mjs';
import { sentKind } from '../lib/route.mjs';
import { startsBrowserPackage } from '../lib/security.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const entries = (H) => readLedger(join(H.dir, 'ledger.jsonl')).entries;
const saved = (H, type) => entries(H).filter((e) => e.type === type).map((e) => e.id);
const gate = (H, a, now = NOW) => cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', a], now);
const tgate = (H, a, now = NOW) => cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', a], now);
const at = (min) => new Date(Date.parse(NOW) + min * 6e4).toISOString();
const ROWS = 'Name,Title,Company,Email\nAna Costa,COO,Acme,ana@acme.test\nAna Berg,VP,Globex,anab@globex.test\nBo Li,CTO,Initech,bo@initech.test\nCy Ek,CFO,Umbra,cy@umbra.test\n';
function ready(settings = {}) {
  const H = setup({ attendees: ROWS, settings });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  return H;
}
const pendingFile = (H, g) => join(H.dir, 'derived', `pending-${g}.json`);

test('a pending reading: yes applies exactly it, any other answer drops it, a changed list or an old one is never applied', () => {
  const H = ready();
  const [costa, berg] = [idOf(H, 'Ana Costa'), idOf(H, 'Ana Berg')];
  const none = gate(H, 'yes');
  assert.equal(none.saved, false);
  assert.match(none.say_to_user, /Nothing is waiting for a yes here, so nothing was saved/);
  const r = gate(H, 'approve Ana Costa');
  assert.equal(r.pending, true);
  assert.ok(existsSync(pendingFile(H, 'approval')));
  const p = JSON.parse(readFileSync(pendingFile(H, 'approval'), 'utf8'));
  assert.equal(p.gate, 'approval');
  assert.equal(p.event, H.slug);
  assert.ok(p.rows_hash && p.created_at && p.reading.actions[0].ids.includes(costa), JSON.stringify(p).slice(0, 300));
  // Only a bare yes confirms: "yes, and Ana Berg too" is a new answer, and drops the reading.
  const other = gate(H, 'yes, and Ana Berg too');
  assert.ok(!existsSync(pendingFile(H, 'approval')) || JSON.parse(readFileSync(pendingFile(H, 'approval'), 'utf8')).answer !== 'approve Ana Costa', JSON.stringify(other).slice(0, 200));
  assert.equal(saved(H, 'approved').length, 0);
  // A fresh reading, then yes: exactly what was read back, nobody else.
  gate(H, 'approve Ana Costa');
  for (const y of ['y']) assert.equal(gate(H, y).approved, 1);
  assert.deepEqual(saved(H, 'approved'), [costa]);
  assert.equal(gate(H, 'yes').saved, false, 'a yes applies a reading once');
  // A list that changed since: discarded and asked again.
  gate(H, 'approve Ana Berg');
  const todo = join(H.dir, 'derived', 'todo.json');
  const t = JSON.parse(readFileSync(todo, 'utf8'));
  writeFileSync(todo, JSON.stringify({ ...t, jobs: t.jobs.filter((j) => j.id !== idOf(H, 'Cy Ek')) }));
  assert.match(gate(H, 'yes').ERROR || '', /the list changed since it was read\. Nothing was saved/);
  assert.ok(!saved(H, 'approved').includes(berg));
  writeFileSync(todo, JSON.stringify(t));
  // Older than a run's lock: discarded.
  gate(H, 'approve Ana Berg', at(0));
  assert.match(gate(H, 'yes', at(31)).ERROR || '', /more than 30 minutes ago/);
  assert.ok(!saved(H, 'approved').includes(berg));
  // The shortlist gate the same way.
  const T = setup({ attendees: ROWS });
  triage(T);
  const cy = idOf(T, 'Cy Ek');
  assert.equal(tgate(T, 'skip Cy').pending, true);
  assert.ok(!entries(T).some((e) => e.type === 'decide' && e.id === cy && e.group === 'skip'));
  const y = tgate(T, 'yes');
  assert.match(y.say_to_user, new RegExp(`^Saved: skip ${cy} "Cy Ek"\\.`));
  assert.deepEqual(entries(T).filter((e) => e.type === 'decide' && e.group === 'skip').map((e) => e.id), [cy]);
});

test('nothing is listed or sent while a reading only waits for a yes', () => {
  const H = ready({ sending: { channels: ['email'], followups: 'scheduled' }, route: ['email'] });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  assert.equal(gate(H, 'approve Ana Costa, Ana Berg, Bo Li, Cy Ek').pending, true);
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  assert.equal(list.to_send || 0, 0, JSON.stringify(list).slice(0, 300));
  const items = existsSync(join(H.dir, 'derived', 'send-list.json')) ? JSON.parse(readFileSync(join(H.dir, 'derived', 'send-list.json'), 'utf8')) : [];
  assert.equal(items.length, 0);
  const staged = cli(H, 'event-outreach', ['stage-list', '--event', H.slug]);
  assert.equal(staged.to_stage || 0, 0, JSON.stringify(staged).slice(0, 300));
  assert.equal(saved(H, 'approved').length, 0);
  assert.ok(!entries(H).some((e) => e.type === 'send_released'));
});

test('every saved answer says what was saved, by ID and name, and it matches the record', () => {
  const T = setup({ attendees: ROWS });
  triage(T);
  assert.equal(tgate(T, 'ok').say_to_user, 'Saved: the shortlist as shown (ok).');
  assert.equal(tgate(T, 'keep 3').say_to_user, 'Saved: keep the top 3.');
  assert.equal(tgate(T, 'cap 1').say_to_user, 'Saved: at most 1 per company.');
  const H = ready();
  const e = gate(H, 'edit c003');
  assert.equal(e.say_to_user, `Nothing was approved. Opened for editing c003 "Bo Li".`);
  const a = gate(H, 'approve all except c003');
  const ids = [...new Set(saved(H, 'approved'))];
  for (const id of ids) assert.match(a.say_to_user, new RegExp(`${id} "`), id);
  assert.match(a.say_to_user, /Held back c003 "Bo Li"\./);
  assert.ok(!ids.includes('c003'));
});

// The DIRECT rule, over generated lists and answers: whatever is saved at once is exactly the IDs typed or the people
// whose whole names were typed (each unique, sharing no first name), and the read-back names exactly what was saved.
// Anything else is read back first, and saved only as read back.
const POOL = ['Ana Berg', 'Ana Costa', 'Bo Li', 'Cy Ek', 'Di Fox', 'Ed Gray', 'Jo Cut', 'Bo Thanks', 'Li Wu', 'Taylor Reed', 'Sam Taylor', 'Maria Lopez', 'Ana Maria Lopez', 'Kim Park'];
function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}
test('property: a direct save is exactly what was named; every other reading is shown before it is saved', { timeout: 600000 }, () => {
  const R = rng(7);
  const pick = (xs, n) => [...xs].sort(() => R() - 0.5).slice(0, n);
  for (let round = 0; round < 3; round++) {
    const names = pick(POOL, 5);
    const H = setup({ attendees: `Name,Title,Company,Email\n${names.map((n, i) => `${n},COO,Co${i},p${i}@co${i}.test`).join('\n')}\n` });
    triage(H);
    draftApprove(H, NOW, 'edit c001');
    const rows = JSON.parse(readFileSync(join(H.dir, 'derived', 'compat', 'contacts.json'), 'utf8')).contacts.map((c) => ({ id: c.id, name: c.name }));
    const byName = (n) => rows.find((r) => r.name === n)?.id;
    const answers = [];
    for (let i = 0; i < 10; i++) {
      const who = pick(rows, 1 + Math.floor(R() * 2));
      const as = who.map((r) => (R() < 0.4 ? r.id : R() < 0.7 ? r.name : r.name.split(' ')[0]));
      const verb = ['approve', 'drop', 'approve all except'][Math.floor(R() * 3)];
      answers.push(`${verb} ${as.join(', ')}${R() < 0.15 ? ' please' : ''}`);
    }
    for (const a of answers) {
      const HOME = mkdtempSync(join(tmpdir(), 'fb-prop-'));
      cpSync(H.HOME, HOME, { recursive: true });
      const K = { HOME, slug: H.slug, dir: join(HOME, 'events', H.slug) };
      const n0 = entries(K).length;
      const r = gate(K, a);
      const after = entries(K).slice(n0);
      const done = [...new Set(after.filter((e) => e.type === 'approved' || e.type === 'dropped').map((e) => e.id))];
      const direct = directReading(a, { kind: 'draft', rows, ids: new Set(rows.map((x) => x.id)) });
      if (r.ERROR || r.pending) {
        assert.equal(done.length, 0, `${a}: nothing saved before a yes`);
        if (!r.pending) continue;
        const shownIds = [...r.say_to_user.matchAll(/(?<![\p{L}\d])(c\d{3,}) "/gu)].map((m) => m[1]);
        const n1 = entries(K).length;
        gate(K, 'yes');
        for (const id of entries(K).slice(n1).filter((e) => e.type === 'approved' || e.type === 'dropped').map((e) => e.id)) assert.ok(shownIds.includes(id), `${a}: ${id} saved after yes but never shown`);
        continue;
      }
      assert.ok(direct, `${a}: saved at once, so it must be a DIRECT answer`);
      // Each item named: an ID, or a whole name that is one row's and nobody else's first name.
      const items = a.replace(/^(?:approve all except|approve|drop) /, '').split(/\s*,\s*/);
      const named = items.map((x) => (/^c\d+$/.test(x) ? x : byName(x)));
      assert.ok(named.every(Boolean), `${a}: only IDs and whole names are saved at once`);
      for (const x of items.filter((y) => !/^c\d+$/.test(y))) assert.equal(rows.filter((q) => q.name.split(' ')[0] === x.split(' ')[0]).length, 1, `${a}: ${x} shares a first name`);
      const verb = /^approve all except/.test(a) ? 'except' : a.split(' ')[0];
      if (verb === 'drop') assert.deepEqual(done.sort(), [...new Set(named)].sort(), a);
      if (verb === 'approve') assert.ok(done.every((id) => named.includes(id)), a);
      if (verb === 'except') assert.ok(!done.some((id) => named.includes(id)), a);
      for (const id of done) assert.match(r.say_to_user, new RegExp(`${id} "`), `${a}: ${id} saved but not said`);
    }
  }
});

// Round 4 (review 3). F1: while a reading waits, a word of agreement takes exactly it, never "approve everyone".
const THREE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nJohn Lind,VP,Globex,john@globex.test\nCy Ek,CTO,Initech,cy@initech.test\n';
const readyThree = () => {
  const H = setup({ attendees: THREE });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  return H;
};
const flow = (H, ask, said) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'a.txt');
  writeFileSync(f, said);
  return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', f]);
};
test('F1: an agreement word after a read-back saves exactly that reading, at both gates', () => {
  for (const [first, agree] of [['drop Cy', 'ok'], ['approve all but Cy', 'OK'], ['approve all but Cy', 'yes please'], ['drop Cy', 'sure.'], ['approve all but Cy', 'yep, thanks']]) {
    const H = readyThree();
    assert.equal(gate(H, first).pending, true, first);
    gate(H, agree);
    assert.ok(!saved(H, 'approved').includes('c003'), `${first} → ${agree}: Cy is never approved`);
    if (/drop/.test(first)) assert.deepEqual(saved(H, 'dropped'), ['c003'], `${first} → ${agree}`);
    else assert.deepEqual([...new Set(saved(H, 'approved'))].sort(), ['c001', 'c002'], `${first} → ${agree}`);
  }
  const D = readyThree();
  gate(D, 'approve all but Cy');
  // Round 7: "defaults" is not a yes; it replaces the reading with its own, read back by ID, and only that is saved on yes.
  const d = gate(D, 'defaults');
  assert.equal(d.saved, false);
  assert.match(d.say_to_user, /^The earlier reading was dropped\. This answer reads as: approve c001 "Ana Berg", c002 "John Lind", c003 "Cy Ek"\. Reply yes/);
  assert.equal(saved(D, 'approved').length, 0);
  gate(D, 'yes');
  assert.deepEqual([...new Set(saved(D, 'approved'))].sort(), ['c001', 'c002', 'c003'], 'the reading shown last');
  // With nothing waiting, "ok" is read back by ID too (approving everyone at once takes "approve all"), and a bare yes
  // does nothing.
  const N = readyThree();
  assert.equal(gate(N, 'yes').saved, false);
  assert.equal(gate(N, 'Ok.').pending, true);
  assert.equal(saved(N, 'approved').length, 0);
  assert.equal(gate(N, 'yes').approved, 3);
  // A refusal right after a reading is dropped says so.
  const R = readyThree();
  gate(R, 'drop Cy');
  assert.match(gate(R, 'approve Zed').ERROR || '', /The reading shown before was dropped, since this is a new answer\..*To save that reading, say it again, then "yes"\./s);
  // The shortlist gate.
  for (const agree of ['ok', 'OK', 'yes please', 'okay']) {
    const T = setup({ attendees: THREE });
    triage(T);
    assert.equal(tgate(T, 'drop Cy').pending, true);
    const n0 = entries(T).length;
    tgate(T, agree);
    assert.deepEqual(entries(T).filter((e) => e.type === 'decide' && e.group === 'skip').map((e) => e.id), ['c003'], agree);
    assert.ok(!entries(T).slice(n0).some((e) => e.type === 'answered' && e.ask === 'gate' && e.value === 'ok'), `${agree}: not read as "ok" for everyone`);
  }
  const T = setup({ attendees: THREE });
  triage(T);
  tgate(T, 'drop Cy');
  // Round 7: "defaults" is not a yes: nothing saved, the reading cleared, and the next "ok" is the shortlist as shown.
  assert.match(tgate(T, 'defaults').say_to_user, /^The reading shown before was dropped\. Nothing was saved\. Say the whole answer again/);
  assert.ok(!entries(T).some((e) => e.type === 'decide' && e.group === 'skip' && e.id === 'c003'));
});

test('round 4: IDs with spaces between them stay direct, and a yes works at the held and stuck asks', () => {
  const H = readyThree();
  const r = gate(H, 'approve c002 c003');
  assert.ok(!r.pending && r.approved === 2, JSON.stringify(r).slice(0, 200));
  const K = readyThree();
  assert.equal(gate(K, 'drop Cy').pending, true);
  const y = flow(K, 'approve_held', 'yes');
  assert.ok(!y.ERROR, y.ERROR);
  assert.deepEqual(saved(K, 'dropped'), ['c003']);
  const S = readyThree();
  gate(S, 'drop Cy');
  assert.ok(!flow(S, 'stuck_drafts', 'yes').ERROR);
  assert.deepEqual(saved(S, 'dropped'), ['c003']);
});

test('round 4: any other answer at the approve ask drops the reading, "skip review" too, and yes counts only alone', () => {
  const H = readyThree();
  gate(H, 'drop Cy');
  flow(H, 'approve', 'skip review all');
  // Round 7: the gate keeps only the trace of the reading the skip-review answer replaced.
  assert.equal(JSON.parse(readFileSync(pendingFile(H, 'approval'), 'utf8')).dropped, true, 'skip review all drops it');
  gate(H, 'yes');
  assert.deepEqual(saved(H, 'dropped'), [], 'the reading was never applied');
  // Round 7: a yes beside a skip-review line is no yes to the reading: the skip is done, the earlier reading dropped, and
  // the rest is read back by ID for its own yes.
  const K = readyThree();
  gate(K, 'drop Cy');
  const k = flow(K, 'approve', 'skip review c003\nyes');
  assert.match(JSON.stringify(k), /The earlier reading was dropped\. This answer reads as: approve c001/);
  assert.deepEqual(saved(K, 'dropped'), [], 'not applied by the yes beside a skip-review line');
  assert.deepEqual(saved(K, 'approved'), []);
});

test('round 4: a reading goes stale when the list, a decision or a draft changes; a clock gone back says so', () => {
  const T = setup({ attendees: THREE });
  triage(T);
  assert.equal(tgate(T, 'looks good').pending, true);
  append(join(T.dir, 'ledger.jsonl'), { type: 'decide', who: 'user', id: 'c003', group: 'skip', because: 'left', said: 'left' }, new Date(NOW));
  assert.match(tgate(T, 'yes').ERROR || '', /the list changed since it was read/);
  const K = setup({ attendees: THREE });
  triage(K);
  tgate(K, 'looks good');
  cli(K, 'crm-triage', ['gate', '--event', K.slug, '--answers', 'keep 1']);
  assert.equal(tgate(K, 'yes').saved, false, 'a new answer replaced it');
  const H = readyThree();
  gate(H, 'drop Cy');
  cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', 'c002:1', '--feedback-file', (() => { const f = join(H.HOME, 'fb.txt'); writeFileSync(f, 'shorter'); return f; })()]);
  assert.match(gate(H, 'yes').ERROR || '', /the list changed since it was read/, 'a draft sent back since makes it stale');
  const B = readyThree();
  gate(B, 'drop Cy', at(10));
  assert.match(gate(B, 'yes', at(0)).ERROR || '', /the clock is earlier than when it was read/);
});

test('round 4: names shown back carry no quotes, brackets, commas or anything shaped like an ID, in any script', () => {
  for (const n of ['Zed＂, с002 ＂Bo Li', 'Ana (c00２) Berg', 'Bo «c001» “Li”', 'Cy; c001, Ek']) {
    const out = shown(n);
    assert.doesNotMatch(out.slice(1, -1), /["＂„«»“”()\[\],;]|c\s*[0-9０-９]{3}|с0/u, `${n} → ${out}`);
  }
  assert.equal(shown('frobnicate c002', 80, { keepIds: true }), '"frobnicate c002"', 'the user\'s own words keep their IDs');
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n"Zed＂, с002 ＂Bo Li",VP,Globex,z@globex.test\nBo Li,CTO,Initech,bo@initech.test\n' });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  const r = gate(H, 'approve all except c002');
  assert.doesNotMatch(r.say_to_user, /c002 "[^"]*c002/);
  const u = gate(H, 'approve c001; frobnicate c003');
  assert.match(u.say_to_user || '', /Not read, and not done: "frobnicate c003"/);
});

test('round 4: names made of command words, or written to look like another, never go through at once', () => {
  for (const [rows, said] of [
    [['The Rest', 'Ana Berg', 'Bo Li'], 'approve The Rest'], [['The Others', 'Ana Berg', 'Bo Li'], 'approve The Others'], [['Those Two', 'Ana Berg', 'Bo Li'], 'approve Those Two'], [['First Three', 'Ana Berg', 'Bo Li'], 'approve First Three'],
    [['Paul Fenwick', 'Dr. Paul Stone', 'Bo Li'], 'approve Paul Fenwick'], [['Mary-Ann Lee', 'Mary‐Ann Lee', 'Bo Li'], 'approve Mary-Ann Lee'], [['Mary Ann Lee', 'Mary-Ann Lee', 'Bo Li'], 'approve Mary Ann Lee'],
    [['TOM COX', 'ТОМ СОХ', 'Bo Li'], 'approve Tom Cox'], [['Ana Berg', 'Ana\u00a0Berg', 'Bo Li'], 'approve Ana Berg'], [['Ana Berg', 'Ａｎａ Ｂｅｒｇ', 'Bo Li'], 'approve Ana Berg']
  ]) {
    const H = setup({ attendees: `Name,Title,Company,Email\n${rows.map((n, i) => `"${n}",COO,Co${i},p${i}@co${i}.test`).join('\n')}\n` });
    triage(H);
    draftApprove(H, NOW, 'edit c001');
    const r = gate(H, said);
    assert.ok(r.ERROR || r.pending, `${rows} / ${said}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(saved(H, 'approved').length, 0, said);
  }
});

test('round 4: punctuation alone is no answer, and a reason that names someone is read back as a note', () => {
  const T = setup({ attendees: THREE });
  triage(T);
  const before = entries(T).length;
  for (const a of [';', '·', '.', '…']) assert.match(tgate(T, a).ERROR || '', /No answer was given/, a);
  assert.equal(entries(T).length, before, 'nothing recorded');
  for (const [a, note] of [['skip c001 because duplicates, c002 too', /"duplicates c002 too" is kept as a note, and acts on nobody else/], ['hold c001 until Dana says yes and take out c002', /those words act on nobody else/], ['reach c001 because John Lind said so', /is kept as a note, and acts on nobody else/]]) {
    const r = tgate(T, a);
    assert.equal(r.pending, true, a);
    assert.match(r.say_to_user, note, a);
  }
});

test('round 4: one person approved and held back in one answer is asked; a dropped follow-up is said as that message', () => {
  const H = readyThree();
  for (const a of ['approve all; drop Cy', 'approve all\nhold Cy', 'ok\ndrop c003']) {
    assert.match(gate(H, a).ERROR || '', /both approved and held back|said in this answer/, a);
    assert.equal(saved(H, 'approved').length, 0, a);
  }
  const d = gate(H, 'drop c003:2');
  assert.match(d.say_to_user, /Dropped message 2 only, to c003 "Cy Ek"\./);
  assert.doesNotMatch(d.say_to_user, /^Dropped c003/m);
});

test('round 4: ordinary answers that were refused give a reading now', () => {
  // Each on its own list: one said right after another reading would be agreeing to it.
  const base = readyThree();
  const fresh = () => {
    const HOME = mkdtempSync(join(tmpdir(), 'fb-r4-'));
    cpSync(base.HOME, HOME, { recursive: true });
    return { HOME, slug: base.slug, dir: join(HOME, 'events', base.slug) };
  };
  for (const a of ['okay', 'sure', 'yep, all of them', 'ok, but skip Cy', 'ok but skip Cy', 'everyone but Cy', 'all except Cy', 'remove Cy', 'skip Cy', 'hold Cy']) {
    const r = gate(fresh(), a);
    assert.ok(!r.ERROR, `${a}: ${r.ERROR}`);
    assert.equal(r.pending, true, `${a}: read back, never saved at once`);
  }
  assert.match(gate(fresh(), 'approve the first three').ERROR || '', /use IDs/);
  const T = setup({ attendees: THREE });
  triage(T);
  const tfresh = () => {
    const HOME = mkdtempSync(join(tmpdir(), 'fb-r4-'));
    cpSync(T.HOME, HOME, { recursive: true });
    return { HOME, slug: T.slug, dir: join(HOME, 'events', T.slug) };
  };
  for (const a of ['skip Cy, he left', 'top 3', 'no changes', 'okay', 'sure']) {
    const r = tgate(tfresh(), a);
    assert.ok(!r.ERROR && r.pending, `${a}: ${r.ERROR || JSON.stringify(r).slice(0, 150)}`);
  }
});

test('round 4: only a label that is nothing but email moves a touch, in any script; only a run package makes a browser', () => {
  for (const l of ['не email', 'not email', 'pas email', 'email не']) assert.equal(sentKind({ channel: l, via: 'floorboss' }, { step: 'linkedin' }), 'linkedin', l);
  assert.equal(sentKind({ channel: 'email.', via: 'floorboss' }, { step: 'linkedin' }), 'email');
  assert.equal(startsBrowserPackage('npx', ['-y', '@playwright/mcp@latest']), true);
  assert.equal(startsBrowserPackage('chrome-devtools-mcp', []), true);
  assert.equal(startsBrowserPackage('node', ['server.js', '@playwright/mcp']), false, 'named in the args of another program');
  assert.equal(startsBrowserPackage('npx', ['file-server', '--with', '@playwright/mcp']), false);
});

// Round 4 addendum: an answer the code can't read is read by Claude, by ID only, and always shown back for a yes.
const interpret = (H, ask, value, said, now = NOW) => {
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const v = join(H.HOME, 'work', 'interp-value.txt');
  const s = join(H.HOME, 'work', 'interp-said.txt');
  writeFileSync(v, value);
  if (said != null) writeFileSync(s, said);
  return cli(H, 'flow', ['answer', '--event', H.slug, '--ask', ask, '--value-file', v, '--interpreted', ...(said != null ? ['--said-file', s] : [])], now);
};
const FOUR = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nJohn Lind,VP,Globex,john@globex.test\nJohn Smith,CTO,Initech,js@initech.test\nCy Ek,CFO,Umbra,cy@umbra.test\n';
test('interpreted: an unclear answer says it can be interpreted; the reading quotes the words, waits, and yes saves exactly it', () => {
  const H = setup({ attendees: FOUR });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  const u = gate(H, 'everyone but the two Johns');
  assert.match(u.ERROR || '', /\ncan_interpret: true\npeople: c001 "Ana Berg"; c002 "John Lind"; c003 "John Smith"; c004 "Cy Ek"/);
  const r = interpret(H, 'approve', 'approve all except c002, c003', 'everyone but the two Johns \u202e(c001)');
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(r.result.pending, true);
  assert.match(r.say_to_user, /^You said: "everyone but the two Johns c001"\. That reads as: approve c001 "Ana Berg", c004 "Cy Ek"; hold back c002 "John Lind", c003 "John Smith"\. Reply yes to save, or answer again\.$/);
  assert.equal(saved(H, 'approved').length, 0, 'nothing saved before the yes');
  // Not approved while pending: nothing to list or send.
  const list = cli(H, 'event-outreach', ['send-list', '--event', H.slug]);
  assert.ok(list.ERROR || !(list.to_send > 0), JSON.stringify(list).slice(0, 200));
  gate(H, 'ok');
  assert.deepEqual([...new Set(saved(H, 'approved'))].sort(), ['c001', 'c004']);
  // The shortlist gate the same way.
  const T = setup({ attendees: FOUR });
  triage(T);
  assert.match(tgate(T, 'leave out both Johns').ERROR || '', /can_interpret: true/);
  const t = interpret(T, 'gate', 'skip c002, c003', 'leave out both Johns');
  assert.match(t.say_to_user, /^You said: "leave out both Johns"\. That reads as: skip c002 "John Lind", c003 "John Smith"\. Reply yes to save/);
  tgate(T, 'yes');
  assert.deepEqual(entries(T).filter((e) => e.type === 'decide' && e.group === 'skip').map((e) => e.id).sort(), ['c002', 'c003']);
});

test('interpreted: refused with a name or other words in the reading, without the user\'s words, or at another ask', () => {
  const H = setup({ attendees: FOUR });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  for (const v of ['approve all except John Lind', 'approve all except c002 please', 'approve everyone', 'drop c002 because he left', 'approve c009', 'approve all\nno'])
    assert.match(interpret(H, 'approve', v, 'something they said').ERROR || '', /commands with list IDs only|aren't on this list/, v);
  assert.match(interpret(H, 'approve', 'approve c002', null).ERROR || '', /exact words/);
  assert.match(interpret(H, 'approve', 'approve c002', '   ').ERROR || '', /exact words/);
  assert.match(interpret(H, 'rate', 'approve c002', 'x').ERROR || '', /only/);
  assert.equal(saved(H, 'approved').length, 0);
});

test('property: an interpreted answer is never saved at once, and yes saves exactly the IDs it showed', { timeout: 600000 }, () => {
  const R = rng(11);
  const H = setup({ attendees: FOUR });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  const ids = ['c001', 'c002', 'c003', 'c004'];
  for (let i = 0; i < 12; i++) {
    const pick = [...ids].sort(() => R() - 0.5).slice(0, 1 + Math.floor(R() * 2));
    const verb = ['approve', 'drop', 'approve all except'][Math.floor(R() * 3)];
    const HOME = mkdtempSync(join(tmpdir(), 'fb-int-'));
    cpSync(H.HOME, HOME, { recursive: true });
    const K = { HOME, slug: H.slug, dir: join(HOME, 'events', H.slug) };
    const n0 = entries(K).length;
    const r = interpret(K, 'approve', `${verb} ${pick.join(', ')}`, `words ${i}`);
    assert.ok(!r.ERROR && r.result.pending, `${verb} ${pick}: ${r.ERROR}`);
    assert.equal(entries(K).slice(n0).filter((e) => e.type === 'approved' || e.type === 'dropped').length, 0, 'never saved at once');
    const shownIds = [...r.say_to_user.matchAll(/(?<![\p{L}\d])(c\d{3,}) "/gu)].map((m) => m[1]);
    gate(K, 'yes');
    const after = entries(K).slice(n0);
    for (const id of after.filter((e) => e.type === 'approved' || e.type === 'dropped').map((e) => e.id)) assert.ok(shownIds.includes(id), `${verb} ${pick}: ${id} saved but not shown`);
    if (verb === 'drop') assert.deepEqual([...new Set(after.filter((e) => e.type === 'dropped').map((e) => e.id))].sort(), [...pick].sort());
    if (verb === 'approve all except') assert.ok(!after.some((e) => e.type === 'approved' && pick.includes(e.id)));
  }
});

// Round 5 (review 4). F1: an agreement word beside a "skip review" line, while a reading waits, saves nothing.
test('F1 round 5 (round 7): "ok" beside "skip review" while a reading waits never applies it; the rest is read back by ID', () => {
  const variants = ['ok\nskip review all', 'skip review all\nok', 'ok; skip review all', 'skip review c003; ok', 'skip review c001\nOk.', 'skip review all; defaults', 'sure; skip review all', 'skip review all\nokay', 'skip review c003\nyes please'];
  for (const first of ['drop Cy', 'approve all but Cy', 'approve Ana Berg please'])
    for (const v of variants) {
      const H = readyThree();
      assert.equal(gate(H, first).pending, true, first);
      const r = flow(H, 'approve', v);
      const label = `${first} / ${JSON.stringify(v)}: ${JSON.stringify(r).slice(0, 200)}`;
      assert.equal(saved(H, 'approved').length + saved(H, 'dropped').length, 0, `${label}: nothing saved`);
      // The gate replaced the earlier reading with the rest of this answer, read back by ID for its own yes.
      assert.match(JSON.stringify(r), /The earlier reading was dropped\. This answer reads as: approve c001/, label);
      gate(H, 'yes');
      assert.deepEqual(saved(H, 'dropped'), [], `${label}: the earlier reading is never applied`);
    }
  // A reading dropped by a refused interpreted answer: a bare "ok" next is read back, never saved at once.
  const H = readyThree();
  gate(H, 'drop Cy');
  assert.match(interpret(H, 'approve', 'approve John Lind', 'John only').ERROR || '', /The reading shown before was dropped/);
  const ok = gate(H, 'ok');
  assert.equal(ok.pending, true);
  assert.match(ok.say_to_user, /^The earlier reading was dropped\. This answer reads as: approve c001 "Ana Berg", c002 "John Lind", c003 "Cy Ek"\./);
  assert.equal(saved(H, 'approved').length, 0);
  assert.equal(gate(H, 'ok').approved, 3, 'the next "ok" agrees to the reading it was just shown');
});

// F2: no gate verb moves a held person nearer to being written to without the hold check.
const HELD_CRM = 'Name,Email,Company,Owner,Status,Opted Out\nBo Li,bo@globex.test,Globex,Sam Rivera,Lead,yes\nCy Ek,cy@initech.test,Initech,Jordan Fisk,Lead,no\n';
const heldList = () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP,Globex,bo@globex.test\nCy Ek,CTO,Initech,cy@initech.test\nDi Fox,CFO,Hooli,di@hooli.test\n', crm: HELD_CRM, dnc: 'ana@acme.test\n', settings: { crm_accounts: 'apply', coworker_contacts: 'leave', colleagues: ['Jordan Fisk'] } });
  triage(H);
  return H;
};
const reachedHeld = (H) => entries(H).filter((e) => e.type === 'decide' && ['c001', 'c002', 'c003'].includes(e.id) && !['skip', 'colleague'].includes(e.group));
test('F2: confirm and separate never lift a do-not-contact, opt-out or coworker hold, typed or interpreted', () => {
  const H = heldList();
  for (const a of ['confirm c001, c002', 'confirm c001', 'confirm c002', 'confirm c003', 'separate c002', 'separate c003', 'separate c001', 'reach c001', 'warm c002', 'c003 is mine because I know him', 'reach c003'])
    assert.ok(tgate(H, a).ERROR, a);
  for (const v of ['confirm c001, c002', 'confirm c003', 'separate c002', 'reach c001'])
    assert.ok(interpret(H, 'gate', v, 'the user said so').ERROR, `interpreted ${v}`);
  assert.equal(tgate(H, 'yes').saved, false, 'nothing waits after them');
  assert.deepEqual(reachedHeld(H), [], 'no held person moved toward being written to');
  // A reading that holds one refused action names it up front, and saves only the rest on yes.
  const r = tgate(H, 'reach Di; reach c002');
  assert.equal(r.pending, true);
  assert.match(r.say_to_user, /Not saved even on yes: "reach c002", c002 is held because opted out in the CRM/);
  tgate(H, 'yes');
  assert.deepEqual(reachedHeld(H), []);
  assert.ok(entries(H).some((e) => e.type === 'decide' && e.id === 'c004' && e.group === 'reach'));
  // "hold" for someone nobody holds is asked, never read back as a coworker's hold.
  assert.match(tgate(H, 'hold Di Fox').ERROR || '', /isn't held by a coworker/);
  // "confirm" on a row that does have a CRM record waiting to be confirmed: the record's opt-out still holds them.
  const K = setup({ attendees: 'Full Name,Job Title,Organisation,Email Address\nKate Lindqvist,Partnerships Manager,Tillmoss Labs,kate@tillmoss.example\n', crm: 'Contact Name,Email,Account,Owner,Lifecycle,Notes\nKatherine Lindqvist,k.lindqvist@tillmoss.example,Tillmoss,Ines Moreau,Unsubscribed,\n', settings: { own_company: 'Paylark', own_domains: ['paylark.example'], colleagues: ['Sam Okafor'], crm_user_name: 'Ines Moreau', coworker_contacts: 'leave', crm_accounts: 'apply' } });
  cli(K, 'crm-triage', ['propose-mapping', '--event', K.slug, '--kind', 'attendees']);
  cli(K, 'crm-triage', ['confirm-mapping', '--event', K.slug, '--kind', 'attendees', '--accept']);
  cli(K, 'crm-triage', ['propose-mapping', '--event', K.slug, '--kind', 'crm']);
  const w = join(K.HOME, 'w.txt');
  writeFileSync(w, "Lifecycle is the status column. Unsubscribed means opted out. And there's no opt-out column.");
  cli(K, 'crm-triage', ['confirm-mapping', '--event', K.slug, '--kind', 'crm', '--words-file', w]);
  const load = cli(K, 'crm-triage', ['load', '--event', K.slug]);
  writeFileSync(join(K.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((x) => ({ id: x.id, segment: 'ops-leaders', reason: 'fits', score: 80 }))));
  cli(K, 'crm-triage', ['fit', '--event', K.slug, '--fits-file', join(K.dir, 'fits.json')]);
  const kate = idOf(K, 'Kate Lindqvist');
  const res = () => JSON.parse(readFileSync(join(K.dir, 'derived', 'resolved.json'), 'utf8'))[kate];
  assert.equal(res().rung, 'fuzzy');
  const c1 = tgate(K, `confirm ${kate}`);
  if (c1.pending) tgate(K, 'yes');
  cli(K, 'crm-triage', ['view', '--event', K.slug]);
  assert.equal(res().group, 'skip', `confirmed as the opted-out record, she is held: ${JSON.stringify(res()).slice(0, 200)}`);
  assert.ok(!entries(K).some((e) => e.type === 'decide' && e.id === kate && e.group === 'reach'));
});

test('round 5: a failed draft approved by name is read back as such, never saved at once', () => {
  const H = setup({ attendees: THREE });
  triage(H);
  draftApprove(H, NOW, 'edit c001');
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', 'c003', '--touch', '1', '--text', 'FAIL\n- too long']);
  for (const a of ['approve c003', 'approve all, c003 as it is']) {
    const r = gate(H, a);
    assert.equal(r.pending, true, a);
    assert.match(r.say_to_user, /c003 "Cy Ek", whose draft did not pass the checks: approving sends it as it is/, a);
  }
  const i = interpret(H, 'approve', 'approve c003', 'send Cy anyway');
  assert.match(i.say_to_user, /whose draft did not pass the checks/);
});

test('round 5: the refusal hint is never cut mid-name; the full list has its own command; interpreted words come from a file', () => {
  const many = Array.from({ length: 80 }, (_, i) => `Person${String.fromCharCode(65 + (i % 26))}${i} Surname${i},COO,Co${i},p${i}@co${i}.test`).join('\n');
  const H = setup({ attendees: `Name,Title,Company,Email\n${many}\n` });
  triage(H);
  // Read whole: the test harness cuts an error at 800 characters.
  const full = spawnSync('node', [join(ROOT, 'skills/crm-triage/scripts/cli.mjs'), 'gate', '--event', H.slug, '--answers', 'frobnicate everyone'], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' }).stderr;
  const hintPart = full.slice(full.indexOf('can_interpret'));
  assert.match(hintPart, /; and \d+ more: ask for the full list with crm-triage people --event ev\s*$/, hintPart.slice(-200));
  for (const e of hintPart.replace(/^can_interpret: true\npeople: /, '').split('; ').slice(0, -1)) assert.match(e, /^c\d{3} "[^"]+"$/, e);
  const viaFlow = flow(H, 'gate', 'frobnicate everyone');
  assert.match(viaFlow.ERROR || '', /can_interpret: true\npeople: c001 "/, 'the flow keeps the hint whole');
  const p = cli(H, 'crm-triage', ['people', '--event', H.slug]);
  assert.equal(p.people.length, 80);
  // The user's words starting with "--", and a JSON value claiming to be interpreted: never "true" or "undefined".
  const D = readyThree();
  const dash = interpret(D, 'approve', 'drop c003', '--drop Cy');
  assert.match(dash.say_to_user, /^You said: "drop Cy"\./, "read from the file, never \"true\" (edge hyphens are cleaned like any read-back)");
  mkdirSync(join(D.HOME, 'work'), { recursive: true });
  const jf = join(D.HOME, 'work', 'j.json');
  writeFileSync(jf, JSON.stringify({ interpreted: true, answers: 'drop c003' }));
  const j = cli(D, 'flow', ['answer', '--event', D.slug, '--ask', 'approve', '--value-file', jf]);
  assert.doesNotMatch(JSON.stringify(j), /You said: "(?:undefined|true)"/);
  assert.match(cli(D, 'event-outreach', ['gate', '--event', D.slug, '--answers', 'drop c003', '--interpreted', '--said']).ERROR || '', /exact words/);
});

test('round 5: a bare yes with nothing waiting says what to type with the hint; "ok thanks" is "ok"; a broken reading is said plainly', () => {
  const H = readyThree();
  for (const y of ['yes', 'sí', 'yep']) {
    const r = gate(H, y);
    assert.equal(r.saved, false);
    assert.match(r.say_to_user, /Nothing is waiting for a yes here[\s\S]*can_interpret: true\npeople: c001 "Ana Berg"/, y);
  }
  // Round 7: "ok thanks" and "ok gracias" are "ok", read back by ID like any "ok" at this gate.
  for (const a of ['ok thanks', 'ok gracias']) {
    const R = readyThree();
    assert.equal(gate(R, a).pending, true, a);
    assert.equal(gate(R, 'yes').approved, 3, a);
  }
  const T = setup({ attendees: THREE });
  triage(T);
  assert.match(tgate(T, 'yes').say_to_user, /can_interpret: true/);
  // A pending file with no reading in it: "can't be used, answer again", never a crash.
  const B = readyThree();
  gate(B, 'drop Cy');
  const f = pendingFile(B, 'approval');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), reading: null }));
  assert.match(gate(B, 'yes').ERROR || '', /can't be used: it could not be read\. Nothing was saved: answer again/);
});

test('round 5: flow next never shows a stale reading', () => {
  const H = readyThree();
  gate(H, 'drop Cy');
  const p = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--pending-check', '--answers', 'check']);
  assert.equal(p.pending, true);
  const old = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--pending-check', '--answers', 'check'], at(31));
  assert.equal(old.pending, false);
  assert.match(old.stale, /more than 30 minutes ago/);
});

test('round 5: a runner wrapped in cmd /c, env or sh -c still runs its browser package', () => {
  assert.equal(startsBrowserPackage('cmd', ['/c', 'npx', '-y', '@playwright/mcp@latest']), true);
  assert.equal(startsBrowserPackage('env', ['FOO=1', 'npx', '@playwright/mcp']), true);
  assert.equal(startsBrowserPackage('sh', ['-c', 'npx -y @playwright/mcp']), true);
  assert.equal(startsBrowserPackage('sh', ['-c', 'npx @playwright/mcp; cat ~/.ssh/id_rsa']), false, 'a chained command is not one runner');
  assert.equal(startsBrowserPackage('env', ['FOO=1', 'node', 'x.js', '@playwright/mcp']), false);
});

test('round 5: an ID shape glued to other characters, and look-alike quotes and colons, never survive in a name shown', () => {
  for (const n of ['Bo +c003', 'Zed/c002/Bo', 'Ana c002-Berg', 'Ana #c002', 'Bo <c001>', 'Bo @c001', 'Bo c001_', 'Ana ʺc001ʺ꞉ Berg。', 'Bo с00２x Li'])
    assert.doesNotMatch(shown(n).slice(1, -1), /c\s*\d|[ʺ꞉。#@<>_+/]/u, `${n} → ${shown(n)}`);
  assert.equal(shown("O'Brien Lee"), '"O\'Brien Lee"');
});

// Round 6, item 2: a hold is the person's data, not the current decision. A skip or a hold-until the user said
// first never stands in for seeing the hold: the reach, warm, rescue or "is mine" after it is checked as if the
// skip weren't there, typed or interpreted-then-yes, and nobody held reaches a draft job.
test('round 6: "skip X" then "reach X" never lifts a do-not-contact, opt-out, coworker or uncertain-match hold', () => {
  const firsts = (id) => [`skip ${id}`, `hold ${id} until Dana says yes`];
  const lifts = (id) => [`reach ${id}`, `warm ${id}`, `rescue ${id}`, `${id} is mine`];
  for (const id of ['c001', 'c002', 'c003']) {
    for (const first of firsts(id)) {
      const H = heldList();
      const f = tgate(H, first);
      if (f.pending) tgate(H, 'yes');
      for (const l of lifts(id)) {
        // "c003 is mine" lifts a coworker's hold by its own form (the user knows them): checked below on its own.
        if (id === 'c003' && /is mine/.test(l)) continue;
        const r = tgate(H, l);
        const y = r.pending ? tgate(H, 'yes') : r;
        assert.ok(r.ERROR || y.ERROR || y.saved === false || (y.refused || []).length, `${first} -> ${l}: ${JSON.stringify(y).slice(0, 200)}`);
        const i = interpret(H, 'gate', l, 'the user said so');
        if (i.pending || /pending/.test(JSON.stringify(i))) tgate(H, 'yes');
      }
      assert.deepEqual(reachedHeld(H), [], `${first}: no held person moved toward being written to`);
      assert.ok(!todoJobs(H).jobs.some((j) => j.id === id && j.kind !== 'coordinate'), `${first}: no draft job for ${id}`);
    }
  }
});

test('round 6: the lifts in their own form still work after a skip; a lift said once stays lifted', () => {
  const H = heldList();
  for (const a of ['skip c003', 'reach c003 anyway']) {
    const r = tgate(H, a);
    const y = r.pending ? tgate(H, 'yes') : r;
    assert.ok(!y.ERROR && !(y.refused || []).length, `${a}: ${JSON.stringify(y).slice(0, 300)}`);
  }
  assert.equal(entries(H).filter((e) => e.type === 'decide' && e.id === 'c003').at(-1).group, 'reach');
  // Skipped again, then a plain reach: the "anyway" said before still stands.
  for (const a of ['skip c003', 'reach c003']) {
    const r = tgate(H, a);
    const y = r.pending ? tgate(H, 'yes') : r;
    assert.ok(!y.ERROR && !(y.refused || []).length, `${a}: ${JSON.stringify(y).slice(0, 300)}`);
  }
  // The do-not-contact entry lifts only by the user's own words (decide), and that holds after a later skip too.
  const d = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', 'c001', '--group', 'reach', '--because', 'Ana asked me to write after the call']);
  assert.ok(!d.ERROR, d.ERROR);
  const s = tgate(H, 'skip c001');
  if (s.pending) tgate(H, 'yes');
  const r = tgate(H, 'reach c001');
  const y = r.pending ? tgate(H, 'yes') : r;
  assert.ok(!y.ERROR && !(y.refused || []).length, JSON.stringify(y).slice(0, 300));
  // Someone nobody holds: skip then reach is just the user changing their mind.
  const z = tgate(H, 'skip Di Fox');
  if (z.pending) tgate(H, 'yes');
  const w = tgate(H, 'reach Di Fox');
  const wy = w.pending ? tgate(H, 'yes') : w;
  assert.ok(!wy.ERROR, wy.ERROR);
  assert.equal(entries(H).filter((e) => e.type === 'decide' && e.id === 'c004').at(-1).group, 'reach');
});

test('round 6: an uncertain match skipped first is still settled before a reach', () => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nKate Lindqvist,Partnerships Manager,Tillmoss Labs,kate@tillmoss.example\nDi Fox,CFO,Hooli,di@hooli.test\n', crm: 'Name,Email,Company,Owner,Status,Opted Out\nKatherine Lindqvist,k.lindqvist@tillmoss.example,Tillmoss,Sam Rivera,Lead,yes\n', settings: { crm_user_name: 'Sam Rivera' } });
  triage(H);
  const kate = idOf(H, 'Kate Lindqvist');
  const res = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[kate];
  if (res().rung !== 'fuzzy') return assert.fail(`fixture: Kate should be an uncertain match, is ${JSON.stringify(res()).slice(0, 200)}`);
  const s = tgate(H, `skip ${kate}`);
  if (s.pending) tgate(H, 'yes');
  for (const l of [`reach ${kate}`, `warm ${kate}`, `rescue ${kate}`]) {
    const r = tgate(H, l);
    const y = r.pending ? tgate(H, 'yes') : r;
    assert.ok(r.ERROR || y.ERROR || (y.refused || []).length || y.saved === false, `${l}: ${JSON.stringify(y).slice(0, 200)}`);
  }
  const d = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', kate, '--group', 'reach', '--because', 'met her']);
  assert.match(d.ERROR || '', /uncertain match/);
  assert.ok(!entries(H).some((e) => e.type === 'decide' && e.id === kate && ['reach', 'warm'].includes(e.group)));
  // "separate" is the uncertain match's own lift: settled as someone else, she may then be reached.
  for (const a of [`separate ${kate}`, `reach ${kate}`]) {
    const r = tgate(H, a);
    const y = r.pending ? tgate(H, 'yes') : r;
    assert.ok(!y.ERROR && !(y.refused || []).length, `${a}: ${JSON.stringify(y).slice(0, 300)}`);
  }
  assert.equal(entries(H).filter((e) => e.type === 'decide' && e.id === kate).at(-1).group, 'reach');
});

// Round 6, item 1: "ok;" after a read-back once approved everyone. Every yes test reads the answer as the DIRECT test
// does, and a reading that is only the gate's "ok" is never applied as "ok" while a reading waits or was just dropped.
const OK_DRESS = [(w) => `${w};`, (w) => `${w} ;`, (w) => `;${w}`, (w) => `${w.toUpperCase()};`, (w) => `${w};\n`, (w) => `${w}\n;`, (w) => `${w};​`, (w) => `​${w}.`, (w) => ` ${w} ;; `, (w) => `${w}\r\n`];
test('round 6: the yes tests and the DIRECT reading read every punctuation of an answer the same way', async () => {
  const { isAgreement, isYes, bareOk } = await import('../lib/reading.mjs');
  const rows = [{ id: 'c001', name: 'Ana Berg' }, { id: 'c002', name: 'Bo Li' }];
  const ids = new Set(['c001', 'c002']);
  for (const w of ['ok', 'yes', 'sure', 'defaults', 'ok thanks', 'yes please', 'approve all', 'skip c001', 'nope', 'ok; skip c001'])
    for (const dress of OK_DRESS) {
      const t = dress(w);
      assert.equal(isAgreement(t), isAgreement(w), `isAgreement ${JSON.stringify(t)}`);
      assert.equal(isYes(t), isYes(w), `isYes ${JSON.stringify(t)}`);
      assert.equal(bareOk(t), bareOk(w), `bareOk ${JSON.stringify(t)}`);
      for (const kind of ['draft', 'triage']) assert.deepEqual(directReading(t, { kind, rows, ids }), directReading(w, { kind, rows, ids }), `${kind} ${JSON.stringify(t)}`);
    }
});

test('round 6: "ok;" and every other dressed "ok" after a read-back never approves everyone, at both gates', () => {
  const variants = ['ok;', 'ok ;', ';ok', 'OK;', 'defaults;', 'ok;\n', 'ok\n;', 'ok;​'];
  for (const v of variants) {
    const H = readyThree();
    const r = gate(H, 'drop Cy');
    assert.equal(r.pending, true, 'drop Cy is read back');
    const y = gate(H, v);
    assert.ok(!y.ERROR, `${JSON.stringify(v)}: ${y.ERROR}`);
    assert.deepEqual(saved(H, 'approved'), [], `${JSON.stringify(v)} approved nobody`);
  }
  // The same through the flow, the value a JSON object.
  const J = readyThree();
  gate(J, 'drop Cy');
  mkdirSync(join(J.HOME, 'work'), { recursive: true });
  writeFileSync(join(J.HOME, 'work', 'j.json'), JSON.stringify({ answers: 'ok;' }));
  cli(J, 'flow', ['answer', '--event', J.slug, '--ask', 'approve', '--value-file', join(J.HOME, 'work', 'j.json')]);
  assert.deepEqual(saved(J, 'approved'), []);
  // "skip review all" drops the reading; "ok;" after it is refused, not "approve all".
  const S = readyThree();
  gate(S, 'drop Cy');
  flow(S, 'approve', 'skip review all');
  const s = gate(S, 'ok;');
  assert.equal(s.saved, false);
  // Round 7: read back by ID instead, saying the earlier reading was dropped.
  assert.match(s.say_to_user, /^The earlier reading was dropped\. This answer reads as: approve/);
  assert.deepEqual(saved(S, 'approved'), []);
  // At the shortlist: "skip Cy" read back, then "ok;" saves that skip and nothing else; "defaults;" keeps it waiting.
  for (const v of variants) {
    const T = setup({ attendees: THREE });
    fitAll(T, cli(T, 'crm-triage', ['load', '--event', T.slug]));
    const p = tgate(T, 'skip Cy');
    assert.equal(p.pending, true);
    const y = tgate(T, v);
    assert.ok(!y.ERROR, `${JSON.stringify(v)}: ${y.ERROR}`);
    const okSaved = entries(T).some((e) => e.type === 'answered' && e.ask === 'gate');
    const cySkipped = entries(T).some((e) => e.type === 'decide' && e.id === 'c003' && e.group === 'skip');
    assert.ok(!okSaved, `${JSON.stringify(v)}: the shortlist was never saved as shown`);
    if (v === 'defaults;') assert.match(y.say_to_user, /^The reading shown before was dropped\. Nothing was saved/, 'defaults; is no yes (round 7)');
    else assert.ok(cySkipped, `${JSON.stringify(v)} is a yes to the reading`);
  }
});

// Round 6, item 5: the dropped marker is used up only by the bare "ok" it guards against, or by time.
test('round 6: drop Cy, then an edit with its text, then "ok" approves nothing', () => {
  const H = readyThree();
  assert.equal(gate(H, 'drop Cy').pending, true);
  const e = flow(H, 'approve', 'edit c001: Hi Ana, a shorter note. See you at Test Expo.\n\nBest, Sam');
  assert.ok(!e.ERROR, e.ERROR);
  assert.match(JSON.stringify(e), /The reading shown before was dropped/);
  // Round 7: "ok" is read back by ID, never saved at once; the "ok" after that agrees to what it was shown.
  const ok = gate(H, 'ok');
  assert.equal(ok.pending, true);
  assert.deepEqual(saved(H, 'approved'), []);
  gate(H, 'ok');
  assert.ok(saved(H, 'approved').length > 0);
});

// Round 6, item 3: a gate's answer is saved whole or not at all. A later action that fails writes nothing before it
// either, and the reading taken from pending waits for the yes again.
test('round 6: an action failing part-way saves nothing at either gate and keeps the reading waiting', () => {
  const failing = (entry, fn) => {
    process.env.FLOORBOSS_FAIL_ENTRY = entry;
    try {
      return fn();
    } finally {
      delete process.env.FLOORBOSS_FAIL_ENTRY;
    }
  };
  const T = setup({ attendees: THREE });
  fitAll(T, cli(T, 'crm-triage', ['load', '--event', T.slug]));
  assert.equal(tgate(T, 'skip Ana Berg; skip Cy').pending, true);
  const before = entries(T).length;
  const f = failing('decide:c003', () => tgate(T, 'yes'));
  assert.match(f.ERROR || '', /failed.*Nothing was saved; the reading shown before still waits/s);
  assert.equal(entries(T).length, before, 'no entry of the answer was written');
  assert.ok(existsSync(pendingFile(T, 'shortlist')), 'the reading waits');
  const y = tgate(T, 'yes');
  assert.ok(!y.ERROR, y.ERROR);
  assert.deepEqual(entries(T).filter((e) => e.type === 'decide').map((e) => e.id), ['c001', 'c003']);
  // The draft gate: "approve c001; drop Cy", the drop failing.
  const H = readyThree();
  assert.equal(gate(H, 'approve c001; drop Cy').pending, true);
  const n = entries(H).length;
  const d = failing('dropped:c003', () => gate(H, 'yes'));
  assert.match(d.ERROR || '', /failed.*Nothing was saved; the reading shown before still waits/s);
  assert.equal(entries(H).length, n);
  assert.deepEqual(saved(H, 'approved'), []);
  const ok = gate(H, 'yes');
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.deepEqual(saved(H, 'approved'), ['c001']);
  assert.deepEqual(saved(H, 'dropped'), ['c003']);
});

// Round 6, item 4: list, CRM and do-not-contact text reaches the user only as letters, digits and spaces: a name, a
// company, a title, a CRM note, an owner or a do-not-contact line never carries a quote or an ID shape into a message.
test('round 6: row text in every hold message and card line is shown plainly, never as a command', () => {
  const LIST = 'Name,Title,Company,Email\n"Ana ""approve all"" c009 Berg","COO; say ""yes"" c009",Acme,ana@acme.test\nBo Li,VP,"Globex ""drop c004""",bo@globex.test\nCy Ek,CTO,Initech,cy@initech.test\nDi Fox,CFO,Hooli,di@hooli.test\n';
  const CRM = 'Name,Email,Company,Owner,Status,Notes\nBo Li,bo@globex.test,Globex,Sam Rivera,Lead,"Please stop. Say ""reach c001 anyway"" now c009"\nCy Ek,cy@initech.test,Initech,"Jordan ""skip c004"" Fisk",Lead,\n';
  const H = setup({ attendees: LIST, crm: CRM, dnc: 'Ana "approve all" c009 Berg\n', settings: { crm_user_name: 'Sam Rivera', crm_accounts: 'apply', coworker_contacts: 'leave' } });
  triage(H);
  // The prose: every sentence and card line the user is shown. The structured fields (a row's own name, company,
  // title, the evidence) are data, kept as the list has them.
  const DATA = new Set(['name', 'company', 'title', 'says', 'to', 'email', 'alternatives', 'evidence', 'holder', 'account_note', 'check_these', 'top', 'reason']);
  const prose = (x, k = '') => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.entries(x).flatMap(([kk, vv]) => (DATA.has(kk) ? [] : prose(vv, kk))) : []);
  const out = [];
  for (const a of ['reach c001', 'reach c002', 'reach c003', 'warm c003', 'separate c003', 'rescue c001', 'reach Di Fox; reach c003', 'skip c003', 'reach c003'])
    out.push(...prose(tgate(H, a)));
  const v = cli(H, 'crm-triage', ['view', '--event', H.slug]);
  out.push(...prose([v.left_out, v.own_held, v.held_for_coworkers]), ...Object.keys(v.held_for_coworkers || {}), ...(v.left_out || []).map((x) => x.why));
  out.push(...prose(cli(H, 'crm-triage', ['decide-batch', '--event', H.slug, '--text', 'c003 reach because met'])));
  const all = JSON.stringify(out);
  for (const bad of ['c009', 'skip c004', 'drop c004', 'reach c001 anyway', '\\"approve all\\"', '\\"yes\\"', 'COO;'])
    assert.ok(!all.includes(bad), `${bad} shown: ${all.slice(Math.max(0, all.indexOf(bad) - 200), all.indexOf(bad) + 100)}`);
});

// Round 6, item 6: the critic's verdict is part of what a reading was read against.
test('round 6: a reading shown while a draft passed is never applied once the critic has failed it', () => {
  const H = readyThree();
  const r = gate(H, 'approve all, the critic is being picky');
  assert.equal(r.pending, true);
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', 'c002', '--touch', '1', '--text', 'FAIL\n- too long']);
  const y = gate(H, 'yes');
  assert.match(y.ERROR || '', /can't be used/);
  assert.deepEqual(saved(H, 'approved'), []);
});

// Round 6, item 7: a message number is for the drafts; at the shortlist it is refused and the person's ID suggested.
// The DIRECT test sees an item repeated after a message number.
test('round 6: "c001:1" is refused at the shortlist; a repeated item with a message number is never DIRECT', () => {
  const T = setup({ attendees: THREE });
  fitAll(T, cli(T, 'crm-triage', ['load', '--event', T.slug]));
  for (const a of ['skip c001:1', 'reach c002:1', 'skip c001:1, c002'])
    assert.match(tgate(T, a).ERROR || '', /"c001:1" names one message|"c002:1" names one message/, a);
  assert.equal(interpret(T, 'gate', 'skip c001:1', 'skip Ana').ERROR ? true : false, true);
  assert.ok(!entries(T).some((e) => e.type === 'decide'), 'nothing saved');
  const rows = [{ id: 'c001', name: 'Ana Berg' }];
  const ids = new Set(['c001', 'c002']);
  for (const t of ['drop c001:2, c001:2', 'drop c001:1, c001', 'approve c001 c001', 'drop c002:1; drop c002:1']) assert.equal(directReading(t, { kind: 'draft', rows, ids }), null, t);
  assert.deepEqual(directReading('drop c001:1, c002:2', { kind: 'draft', rows, ids }), ['drop:c001:1,c002:2']);
});

// Round 6, item 8: a runner's -p/--package/-c/--call value is never the package it runs, and a wrapper that chains or
// substitutes another command is never taken for a browser.
test('round 6: browser package checks skip option values and refuse chaining wrappers', () => {
  for (const [c, a] of [['npx', ['-p', '@playwright/mcp', 'evil']], ['npx', ['--package', '@playwright/mcp', 'evil']], ['npx', ['--package=@playwright/mcp', 'evil']], ['npx', ['-c', 'evil', '@playwright/mcp']], ['npx', ['--call', 'evil', '@playwright/mcp']], ['npm', ['exec', '-c', 'evil', '@playwright/mcp']], ['cmd', ['/c', 'npx', '@playwright/mcp', '&', 'evil']], ['cmd', ['/c', 'npx', '@playwright/mcp|evil']], ['env', ['A=1', 'npx', '@playwright/mcp;evil']], ['env', ['A=$(evil)', 'npx', '@playwright/mcp']], ['sh', ['-c', 'npx @playwright/mcp\nevil']], ['cmd', ['/c', 'npx', '`evil`', '@playwright/mcp']]])
    assert.equal(startsBrowserPackage(c, a), false, `${c} ${a.join(' ')}`);
  for (const [c, a] of [['npx', ['-y', '@playwright/mcp@latest']], ['cmd', ['/c', 'npx', '@playwright/mcp']], ['env', ['A=1', 'npx', '@playwright/mcp']], ['sh', ['-c', 'npx @playwright/mcp']]])
    assert.equal(startsBrowserPackage(c, a), true, `${c} ${a.join(' ')}`);
});

// Round 6, item 9: a read-back of "approve all" lists under approve only the drafts it would approve.
test('round 6: a read-back of approve all never lists a draft that is not ready under approve', () => {
  const H = readyThree();
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', 'c003', '--touch', '1', '--text', 'FAIL\n- too long']);
  const r = gate(H, 'approve all, the critic is being picky');
  assert.equal(r.pending, true);
  const approvePart = (/approve ([^;.]*)/.exec(r.say_to_user) || [])[1] || '';
  assert.doesNotMatch(approvePart, /c003/, r.say_to_user);
  assert.match(r.say_to_user, /not approve c003 "Cy Ek", not ready/);
  const y = gate(H, 'yes');
  assert.ok(!saved(H, 'approved').includes('c003'));
  assert.ok(saved(H, 'approved').length > 0, JSON.stringify(y).slice(0, 200));
});

// Round 7, C3: more ways a runner runs something other than the package it names.
test('round 7: --with, aliases, links, --registry, --node-options and NODE_OPTIONS / npm_config_* are never a browser', () => {
  for (const [c, a] of [['uvx', ['--with', '@playwright/mcp', 'evil']], ['uvx', ['--with=@playwright/mcp', 'evil']], ['npx', ['@playwright/mcp@npm:evil']], ['npx', ['git+https://example.test/evil.git']], ['npx', ['https://example.test/evil.tgz']], ['npx', ['file:../evil']], ['npx', ['--registry', 'https://example.test', '@playwright/mcp']], ['npx', ['--registry=https://example.test', '@playwright/mcp']], ['npx', ['--node-options=--require=/tmp/x.js', '@playwright/mcp']], ['env', ['NODE_OPTIONS=--require /tmp/x.js', 'npx', '@playwright/mcp']], ['env', ['npm_config_registry=https://example.test', 'npx', '@playwright/mcp']]])
    assert.equal(startsBrowserPackage(c, a), false, `${c} ${a.join(' ')}`);
  assert.equal(startsBrowserPackage('npx', ['-y', '@playwright/mcp@latest']), true);
});

// Round 7, B1: a reach said before an uncertain match existed never covers it. The match turned up by a later load
// puts the person back on check-these, saying it is new since the reach; nothing is drafted; and the old reach is
// no lift for a skip-then-reach. An uncertain match settled by "separate" is not asked again.
test('round 7: an uncertain match that turns up after a reach puts the person back on check-these', () => {
  const LIST = 'Name,Title,Company,Email\nKate Lindqvist,Partnerships Manager,Tillmoss Labs,kate@tillmoss.example\nDi Fox,CFO,Hooli,di@hooli.test\n';
  const before = 'Name,Email,Company,Owner,Status,Opted Out\nDi Fox,di@hooli.test,Hooli,Sam Rivera,Lead,no\n';
  const H = setup({ attendees: LIST, crm: before, settings: { crm_user_name: 'Sam Rivera' } });
  triage(H);
  const kate = idOf(H, 'Kate Lindqvist');
  const res = () => JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[kate];
  const r = tgate(H, `reach ${kate}`);
  if (r.pending) tgate(H, 'yes');
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.equal(res().group, 'reach');
  writeFileSync(join(H.dir, 'crm.csv'), `${before}Katherine Lindqvist,k.lindqvist@tillmoss.example,Tillmoss,Sam Rivera,Lead,yes\n`);
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.equal(res().rung, 'fuzzy', JSON.stringify(res()).slice(0, 300));
  assert.match(res().says, /new since you said reach/);
  assert.ok(!todoJobs(H).jobs.some((j) => j.id === kate), 'not drafted');
  for (const a of [`skip ${kate}`, `reach ${kate}`]) {
    const x = tgate(H, a);
    if (x.pending) tgate(H, 'yes');
  }
  assert.notEqual(entries(H).filter((e) => e.type === 'decide' && e.id === kate).at(-1).group, 'reach', 'the old reach is no lift');
  // Settled as someone else: not asked again on the next load.
  const s = tgate(H, `separate ${kate}`);
  if (s.pending) tgate(H, 'yes');
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  cli(H, 'crm-triage', ['view', '--event', H.slug]);
  assert.notEqual(res().rung, 'fuzzy', JSON.stringify(res()).slice(0, 300));
});

// Round 7, B2: a coworker's hold behind another rung (a lost deal they own) still needs "anyway".
test('round 7: a coworker hold behind a lost-deal check is not lifted by a plain reach', () => {
  const CRM = 'Contact Name,Email,Company,Job Title,Deal Stage,Contact Owner,Last Activity,Email Opt Out\nDaniel Novak,d.novak@danubia.example,Danubia 3PL,Warehouse Manager,Closed Lost,Priya Shah,2026-10-20,No\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nDaniel Novak,Warehouse Manager,Danubia 3PL,d.novak@danubia.example\nFelix Braun,Site Manager,Kessler Distribution,felix@kessler.example\n', crm: CRM, settings: { crm_user_name: 'Sam Rivera', crm_accounts: 'apply', coworker_contacts: 'leave' } });
  triage(H);
  const dan = idOf(H, 'Daniel Novak');
  const r0 = JSON.parse(readFileSync(join(H.dir, 'derived', 'resolved.json'), 'utf8'))[dan];
  assert.notEqual(r0.group, 'colleague', `fixture: the colleague hold sits behind another rung (${r0.group}/${r0.rung})`);
  assert.ok([r0, ...(r0.alternatives || []).map((a) => ({ group: a.would_be, holder: a.holder }))].some((x) => x.group === 'colleague' && x.holder), JSON.stringify(r0).slice(0, 400));
  const r = tgate(H, `reach ${dan}`);
  const y = r.pending ? tgate(H, 'yes') : r;
  assert.match(r.ERROR || y.ERROR || JSON.stringify(y.refused || ''), /Priya Shah/, JSON.stringify(y).slice(0, 300));
  assert.ok(!entries(H).some((e) => e.type === 'decide' && e.id === dan && e.group === 'reach'));
  const a = tgate(H, `reach ${dan} anyway`);
  const ay = a.pending ? tgate(H, 'yes') : a;
  assert.ok(!ay.ERROR, ay.ERROR);
  assert.ok(entries(H).some((e) => e.type === 'decide' && e.id === dan && e.group === 'reach'));
});

// Round 7, C1: the entries are written before the outbox page is rebuilt; a failure in the page says the answer was
// saved, and the reading it saved is not left waiting.
test('round 7: a page that cannot be rebuilt after a save says saved, and leaves no reading waiting', async () => {
  const { rmSync } = await import('node:fs');
  const H = readyThree();
  assert.equal(gate(H, 'drop Cy').pending, true);
  rmSync(join(H.dir, 'outbox.html'), { force: true });
  mkdirSync(join(H.dir, 'outbox.html', 'blocked'), { recursive: true });
  const y = gate(H, 'yes');
  assert.match(y.ERROR || '', /The answer was saved, but the outbox page could not be rebuilt/);
  assert.doesNotMatch(y.ERROR || '', /still waits/);
  assert.deepEqual(saved(H, 'dropped'), ['c003']);
  assert.ok(!existsSync(pendingFile(H, 'approval')), 'nothing waits');
});
