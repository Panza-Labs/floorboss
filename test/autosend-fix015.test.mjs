// 0.1.5 review fixes for auto-send through Gmail drafts (lib/autosend/drafts.mjs): the draft's content is read back
// before it is labelled; a label that can't be confirmed puts floorboss/held-check on the draft; no follow-up without
// its first email; the ledger is read again before every search, send and draft step; one open run per event; the
// overdue check counts only days before yesterday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { world, ledgerLines, addLines, draftText, PEOPLE, NOW, OWN, EVENT, SLUG } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { SENTENCE } from '../lib/autosend/common.mjs';
import { draftsNext, draftsAnswer, draftPlan, overdueDays, RUN_OPEN_MS } from '../lib/autosend/drafts.mjs';

const ANA = PEOPLE[0];
const env = (sc) => JSON.stringify({ content: [{ type: 'text', text: 'Action completed.' }], structuredContent: sc, isError: false });
const profile = env({ id: 'u1', name: 'Sam', email: OWN });
const gap = () => 20000;

function setup({ now = NOW, people = [ANA] } = {}) {
  const w = world({ touches: 2, people, event: { ...EVENT, autosend_mode: 'drafts' } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const nowMs = Date.parse(now);
  const r = readback(w.evDir, nowMs);
  approve(w.evDir, { digest: r.digest, said: SENTENCE }, nowMs);
  return { ...w, nowMs, rb: r };
}
const step = (w, s, answer, nowMs = w.nowMs) => {
  writeFileSync(s.write, answer);
  return draftsAnswer(w.HOME, { run: s.run, file: s.write, nowMs });
};
const next = (w, run, nowMs = w.nowMs) => draftsNext(w.HOME, { event: SLUG, run, nowMs, cli: ['node', 'cli.mjs'], gapOf: gap });
const labelsOf = (w, s) => {
  while (s.step === 'create_label') {
    step(w, s, env({ id: `L-${s.args.name}`, name: s.args.name }));
    s = next(w, s.run);
  }
  return s;
};

// Up to the follow-up's draft step (message 1 sent now).
function toDraft(opts) {
  const w = setup(opts);
  let s = next(w, 'new');
  step(w, s, profile);
  s = labelsOf(w, next(w, s.run));
  assert.equal(s.step, 'search');
  step(w, s, env({ emails: [], next_page_token: null }));
  s = next(w, s.run);
  assert.equal(s.step, 'send');
  step(w, s, env({ id: 'm1', thread_id: 't1' }));
  s = next(w, s.run);
  assert.equal(s.step, 'draft');
  step(w, s, env({ id: 'r-5', message: { id: 'm2', thread_id: 't1' } }));
  return { w, run: s.run };
}
const content = (extra = {}) => {
  const t2 = draftText(ANA, 2);
  return env({ id: 'm2', thread_id: 't1', to: [ANA.email], cc: [], bcc: [], subject: t2.subject, body: t2.body, labels: ['DRAFT'], ...extra });
};

test('1. the content is read back before the label: draft, verify, label, verify the label', () => {
  const { w, run } = toDraft();
  let s = next(w, run);
  assert.equal(s.step, 'verify', 'the content is checked before any label');
  assert.deepEqual(s.args, { email_id: 'm2' });
  step(w, s, content());
  s = next(w, run);
  assert.equal(s.step, 'label');
  assert.deepEqual(s.args.label_names, ['floorboss/due-2026-10-19']);
  step(w, s, env({ ok: true }));
  s = next(w, run);
  assert.equal(s.step, 'verify_label');
  assert.match(s.tool, /gmail_read_email$/);
  step(w, s, content({ labels: ['DRAFT', 'floorboss/due-2026-10-19'] }));
  s = next(w, run);
  assert.equal(s.step, 'done');
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_drafted' && e.draft_id === 'r-5'));
});

test('1. a content mismatch stops before any label: the unlabelled draft is named for deleting', () => {
  const { w, run } = toDraft();
  const s = next(w, run);
  const out = step(w, s, content({ body: 'other' }));
  assert.equal(out.step, 'stop');
  assert.match(out.why, /delete the draft r-5/);
  assert.match(out.why, /no due label/);
});

test('1. an unclear label answer, or a label the read-back does not show, puts floorboss/held-check on the draft', () => {
  for (const [which, bad] of [['label', 'not json'], ['verify_label', 'x']]) {
    const { w, run } = toDraft();
    let s = next(w, run);
    step(w, s, content());
    s = next(w, run);
    if (which === 'label') step(w, s, bad);
    else {
      step(w, s, env({ ok: true }));
      s = next(w, run);
      step(w, s, content({ labels: ['DRAFT'] }));
    }
    s = next(w, run);
    assert.equal(s.step, 'hold', which);
    assert.deepEqual(s.args.email_ids, ['m2']);
    assert.deepEqual(s.args.label_names, ['floorboss/held-check']);
    const out = step(w, s, env({ ok: true }));
    assert.equal(out.step, 'stop', which);
    assert.match(out.why, /floorboss\/held-check/);
    assert.match(out.why, /r-5/);
    assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_draft_bad' && e.draft_id === 'r-5'), which);
  }
  // The hold itself unclear: delete it by id.
  const { w, run } = toDraft();
  let s = next(w, run);
  step(w, s, content());
  s = next(w, run);
  step(w, s, 'not json');
  s = next(w, run);
  const out = step(w, s, 'still not json');
  assert.equal(out.step, 'stop');
  assert.match(out.why, /could not be held/);
  assert.match(out.why, /delete the draft r-5/);
});

test('1. the held-check label is made with the due labels', () => {
  const w = setup();
  let s = next(w, 'new');
  step(w, s, profile);
  const names = [];
  s = next(w, s.run);
  while (s.step === 'create_label') {
    names.push(s.args.name);
    step(w, s, env({ id: 'L', name: s.args.name }));
    s = next(w, s.run);
  }
  assert.deepEqual(names, ['floorboss/due-2026-10-19', 'floorboss/held-check']);
});

test('2. no orphan follow-ups: no message 1 in the plan or sent with ids, an unclear send, an earlier bad draft', () => {
  // Message 1 drafted earlier (waiting), message 2 not: message 2 alone is not planned.
  let w = setup();
  addLines(w.evDir, [{ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: 'c001', touch: 1, hash: 'a'.repeat(24), to: ANA.email, due: '2026-10-12', draft_id: 'r-1', message_id: 'm1', thread_id: 't1', threaded: false, run: 'r' }]);
  let p = draftPlan(w.evDir, SLUG, w.nowMs);
  assert.equal(p.people.length, 0);
  assert.match(p.skipped.find((x) => x.id === 'c001').why, /message 1/);
  // An earlier bad draft.
  w = setup();
  addLines(w.evDir, [{ at: NOW, type: 'autosend_draft_bad', who: 'floorboss', id: 'c001', touch: 1, draft_id: null, why: 'x', run: 'r' }]);
  p = draftPlan(w.evDir, SLUG, w.nowMs);
  assert.equal(p.people.length, 0);
  assert.ok(p.skipped.some((x) => x.id === 'c001'));
  // An unsettled unclear send.
  w = setup();
  addLines(w.evDir, [
    { at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: 'a'.repeat(24), to: ANA.email, run: 'r' },
    { at: NOW, type: 'send_unclear', who: 'floorboss', id: 'c001', touch: 1, error: 'x' }
  ]);
  p = draftPlan(w.evDir, SLUG, w.nowMs);
  assert.equal(p.people.length, 0);
  assert.match(p.skipped.find((x) => x.id === 'c001').why, /unclear/);
});

test('3. the ledger is read again before each step: a revoke or a reply recorded mid-run skips the person', () => {
  const w = setup();
  let s = next(w, 'new');
  step(w, s, profile);
  s = labelsOf(w, next(w, s.run));
  assert.equal(s.step, 'search');
  step(w, s, env({ emails: [], next_page_token: null }));
  // Revoked between the search and the send.
  addLines(w.evDir, [{ at: NOW, type: 'autosend_revoked', who: 'user', id: 'c001' }]);
  s = next(w, s.run);
  assert.equal(s.step, 'done');
  assert.deepEqual(s.summary.sent, []);
  assert.ok(s.summary.skipped.some((x) => x.id === 'c001'));
  assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_released'));
});

test('3. a touch already drafted by another run is skipped at its draft step', () => {
  const w = setup({ now: '2026-10-17T10:00:00Z' });
  let s = next(w, 'new');
  step(w, s, profile);
  s = labelsOf(w, next(w, s.run));
  assert.equal(s.step, 'draft');
  assert.equal(s.args.subject, draftText(ANA, 1).subject);
  step(w, s, env({ draft_id: 'r-1', message_id: 'm1', thread_id: 't1' }));
  s = next(w, s.run);
  step(w, s, env({ to: [ANA.email], subject: draftText(ANA, 1).subject, body: draftText(ANA, 1).body, labels: [] }));
  s = next(w, s.run);
  step(w, s, env({}));
  s = next(w, s.run);
  step(w, s, env({ to: [ANA.email], labels: ['floorboss/due-2026-10-19'] }));
  addLines(w.evDir, [{ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: 'c001', touch: 2, hash: 'a'.repeat(24), to: ANA.email, due: '2026-10-19', draft_id: 'r-x', message_id: 'mx', thread_id: 'tx', threaded: false, run: 'other' }]);
  s = next(w, s.run);
  assert.equal(s.step, 'done');
  assert.deepEqual(s.summary.drafted.map((x) => x.touch), [1]);
  assert.match(s.summary.skipped.find((x) => x.id === 'c001').why, /already drafted/);
});

test('3. --run new refuses while another run for the event is open, unless it expired', () => {
  const w = setup();
  const s = next(w, 'new');
  assert.throws(() => next(w, 'new'), /already open/);
  const later = next(w, 'new', w.nowMs + RUN_OPEN_MS + 1000);
  assert.equal(later.step, 'profile');
  assert.notEqual(later.run, s.run);
});

test('9. the overdue check counts only due days before yesterday', () => {
  const w = setup();
  addLines(w.evDir, [{ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: 'c001', touch: 2, hash: 'a'.repeat(24), to: ANA.email, due: '2026-10-19', draft_id: 'r-1', message_id: 'm2', thread_id: 't1', threaded: true, run: 'r' }]);
  assert.deepEqual(overdueDays(w.evDir, Date.parse('2026-10-20T08:00:00Z')), [], 'the morning after: not yet');
  assert.deepEqual(overdueDays(w.evDir, Date.parse('2026-10-21T08:00:00Z')), ['2026-10-19']);
});

test('6. a first email whose approved day went by: the run refuses; approve again', () => {
  // Approved Saturday 17th for Monday 19th; the run is first asked for on Tuesday 20th.
  const w = setup({ now: '2026-10-17T10:00:00Z' });
  assert.throws(() => next(w, 'new', Date.parse('2026-10-20T09:00:00Z')), /this approval's first day has passed; approve again/);
});

test('6. send_now is recorded; message 1 promised now but hours closed: stop, nothing drafted', () => {
  const w = setup();
  assert.equal(w.rb.items.find((x) => x.touch === 1).send_now, true);
  const L = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  assert.equal(L.find((e) => e.touch === 1).send_now, true);
  // 19:00 in Lisbon the same day: sending hours closed.
  assert.throws(() => next(w, 'new', Date.parse('2026-10-12T18:00:00Z')), /message 1 can't go now; nothing was drafted; run again when sending hours are open/);
  assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_drafted'));
});

test('8. the readback says unthreaded follow-ups arrive as separate emails with a "Re:" subject', () => {
  const w = setup({ now: '2026-10-17T10:00:00Z' });
  assert.match(w.rb.text, /Its follow-ups arrive as separate emails with the subject "Re: At Harbor Expo, Ana", not in its thread/);
});

test('5. daily-task: the zone defaults to the drafts events’ zone, and a different one is refused', async () => {
  const { autosend, said } = await import('./fixtures/autosend-world.mjs');
  const w = world({ touches: 2, people: [ANA] });
  autosend(w.HOME, ['on', '--event', SLUG, '--said-file', said(w.HOME, 'yes'), '--own', OWN, '--mode', 'drafts']);
  const d = autosend(w.HOME, ['daily-task']);
  assert.equal(d.zone, 'Europe/Lisbon', JSON.stringify(d).slice(0, 300));
  assert.equal(autosend(w.HOME, ['daily-task', '--zone', 'Europe/Lisbon']).zone, 'Europe/Lisbon');
  assert.match(autosend(w.HOME, ['daily-task', '--zone', 'America/New_York']).ERROR, /Europe\/Lisbon/);
  // A second drafts event in another zone: refused, whatever the --zone.
  const ev2 = { ...EVENT, slug: 'second-expo', time_zone: 'America/New_York' };
  world({ touches: 2, people: [ANA], event: ev2, home: w.HOME });
  autosend(w.HOME, ['on', '--event', 'second-expo', '--said-file', said(w.HOME, 'yes'), '--own', OWN, '--mode', 'drafts']);
  assert.match(autosend(w.HOME, ['daily-task']).ERROR, /different time zones/);
  assert.match(autosend(w.HOME, ['daily-task', '--zone', 'Europe/Lisbon']).ERROR, /different time zones/);
});

test('7. the daily task: any hold labels every floorboss draft to that address; rule e defers behind any earlier draft', async () => {
  const { dailyTaskText } = await import('../lib/autosend/dailytask.mjs');
  const t = dailyTaskText({ time: '9:00', zone: 'Europe/Lisbon', after: '2026-11-19' });
  assert.match(t, /Whenever this run applies any floorboss\/held- label to a draft, apply the same label to every other floorboss draft to the same address too \(due or not\), and send none of them/);
  assert.match(t, /e\. Order: if any other floorboss draft to the same address, held or not, has an earlier due date, skip this one for today \(deferred, no label\)\./);
  assert.match(t, /Otherwise, if it is a follow-up \(it is in a thread with an earlier email from me, or its subject starts with "Re:"\), search in:sent to:<that address>\. It sends only if there is an earlier sent email to that address and the latest one went out at least 1 calendar day before TODAY/);
});

test('7. the daily task’s reply and bounce searches are the laptop reply check’s, from one builder', async () => {
  const { dailyTaskText, STOP_CHECKS } = await import('../lib/autosend/dailytask.mjs');
  const { fromTerm, bounceTerm, DSN_SUBJECTS, query } = await import('../lib/autosend/replycheck.mjs');
  const t = dailyTaskText({ time: '9:00', zone: 'Europe/Lisbon', after: '2026-11-19' });
  const A = ['<that address>', '<its base address>'];
  assert.ok(t.includes(`search Gmail for ${fromTerm(A)} in:anywhere -in:sent -in:drafts after:2026/11/19`), t);
  assert.ok(t.includes(`search Gmail for ${bounceTerm(A)} in:anywhere after:2026/11/19`));
  for (const s of DSN_SUBJECTS) assert.ok(t.includes(`"${s}"`), s);
  assert.match(t, /its base address is that address with any \+tag removed and, for a gmail\.com or googlemail\.com address, the dots before the @ removed/);
  // The laptop's own query is made from the same two terms.
  const q = query({ to: 'ana.ito+x@gmail.com', since_ms: Date.parse('2026-11-20T00:00:00Z') });
  assert.ok(q.includes(fromTerm(['ana.ito+x@gmail.com', 'anaito@gmail.com'])), q);
  assert.ok(q.includes(bounceTerm(['ana.ito+x@gmail.com', 'anaito@gmail.com'])), q);
  assert.equal(STOP_CHECKS.length, 2);
});

const draftedLine = (touch = 2, draft = 'r-1', msg = 'm2') => ({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: 'c001', touch, hash: 'a'.repeat(24), to: ANA.email, due: '2026-10-19', draft_id: draft, message_id: msg, thread_id: 't1', threaded: true, run: 'r' });

test('4. a revoke or a recorded reply: floorboss labels the person’s queued drafts floorboss/held-check', async () => {
  const { revoke } = await import('../lib/autosend/approval.mjs');
  const { toHold } = await import('../lib/autosend/drafts.mjs');
  for (const how of ['revoke', 'reply']) {
    const w = setup();
    addLines(w.evDir, [draftedLine()]);
    assert.equal(toHold(w.evDir, w.nowMs).length, 0, 'nothing to hold while auto-send stands');
    if (how === 'revoke') revoke(w.evDir, { ids: 'c001', said: 'stop' }, w.nowMs);
    else addLines(w.evDir, [{ at: NOW, type: 'replied', who: 'user', id: 'c001', outcome: 'replied', text: 'yes' }]);
    assert.deepEqual(toHold(w.evDir, w.nowMs).map((x) => x.draft_id), ['r-1'], how);
    let s = next(w, 'hold');
    assert.equal(s.step, 'profile', how);
    step(w, s, profile);
    s = next(w, s.run);
    assert.deepEqual(s.args, { name: 'floorboss/held-check' });
    step(w, s, env({ id: 'Lh', name: 'floorboss/held-check' }));
    s = next(w, s.run);
    assert.equal(s.step, 'hold_drafted', how);
    assert.deepEqual(s.args.email_ids, ['m2']);
    assert.deepEqual(s.args.label_names, ['floorboss/held-check']);
    step(w, s, env({ ok: true }));
    s = next(w, s.run);
    assert.equal(s.step, 'done', how);
    assert.deepEqual(s.summary.held_drafts.map((x) => x.draft_id), ['r-1']);
    assert.equal(s.summary.say, undefined);
    assert.equal(toHold(w.evDir, w.nowMs).length, 0, 'held once');
  }
});

test('4. a hold that can’t be confirmed says which drafts to delete by hand', async () => {
  const { revoke } = await import('../lib/autosend/approval.mjs');
  const w = setup();
  addLines(w.evDir, [draftedLine()]);
  revoke(w.evDir, { ids: 'c001', said: 'stop' }, w.nowMs);
  let s = next(w, 'hold');
  step(w, s, profile);
  s = next(w, s.run);
  step(w, s, env({ id: 'Lh', name: 'floorboss/held-check' }));
  s = next(w, s.run);
  step(w, s, 'not json');
  s = next(w, s.run);
  assert.equal(s.step, 'done');
  assert.match(s.summary.say, /delete these drafts by hand in Gmail.s Drafts folder: r-1 \(to ana@north\.example/);
});

test('4. the CLI: revoke on a drafts event gives the hold run', async () => {
  const { autosend, said } = await import('./fixtures/autosend-world.mjs');
  const w = world({ touches: 2, people: [ANA] });
  autosend(w.HOME, ['on', '--event', SLUG, '--said-file', said(w.HOME, 'yes'), '--own', OWN, '--mode', 'drafts']);
  const rb = autosend(w.HOME, ['readback', '--event', SLUG]);
  autosend(w.HOME, ['approve', '--event', SLUG, '--digest', rb.digest, '--said-file', said(w.HOME, SENTENCE)]);
  addLines(w.evDir, [draftedLine()]);
  const r = autosend(w.HOME, ['revoke', '--event', SLUG, '--ids', 'c001', '--said-file', said(w.HOME, 'stop')]);
  assert.match(r.drafts_hold, /drafts next --event harbor-expo --run hold/, JSON.stringify(r));
  assert.match(r.next, /floorboss\/held-check/);
});

test('4. holdWords: what a laptop stop (record, revoke) says on a drafts event with queued drafts', async () => {
  const { holdWords } = await import('../lib/autosend/drafts.mjs');
  const w = setup();
  addLines(w.evDir, [draftedLine()]);
  assert.equal(holdWords(w.evDir, SLUG, w.nowMs), null);
  addLines(w.evDir, [{ at: NOW, type: 'stop', who: 'user', id: 'c001', said: 'not interested' }]);
  const h = holdWords(w.evDir, SLUG, w.nowMs);
  assert.equal(h?.drafts_hold, 'drafts next --event harbor-expo --run hold', JSON.stringify(h));
  assert.match(h.say, /1 queued Gmail draft is still labelled to send/);
});
