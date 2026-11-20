// Round 5 (the review of c9a89cb), each case built from data shaped as the real code writes it (lib/drafts.mjs
// saveDraft for the text, the drafted ledger line for the times it offers):
// 1. an offered time already past, or booked by someone else, holds the message; times that can't be read hold it too
//    (never read as "no times");
// 2. "settle --went yes" for a step auto-send never let go records a hand send, so auto-send ends for the rest;
// 3. after a hand send, a later step whose day went by on the outbox is approved again only on the user's word that it
//    wasn't sent;
// 4. the rate_notes question reads in Claude Code as it did at 8e9f440.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { world, approvedLines, addLines, ledgerLines, autosend, said, PEOPLE, NOW, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { TIME_TAKEN } from '../lib/autosend/common.mjs';
import { CODEX_MARKERS } from '../lib/harness.mjs';

const at = (iso) => Date.parse(iso);
const SENTENCE = 'auto-send these sequences';
const waitOf = (r, id) => r.waits.find((w) => w.id === id)?.why || '';
const PAST = { id: 's20261012-0800', start: '2026-10-12T08:00:00Z', end: '2026-10-12T08:30:00Z' };
const LATER = { id: 's20261103-1000', start: '2026-11-03T10:00:00Z', end: '2026-11-03T10:30:00Z' };
const slotsFile = (evDir, slots) => writeFileSync(join(evDir, 'slots.json'), JSON.stringify({ slots }));

// One-message sequences for everyone; Ana's message written again offering `slot_ids` (saveDraft, then its drafted,
// critic and approved lines, as the save and approval steps write them), then the second yes.
function offering(slot_ids, { slots = [PAST, LATER], drafted = (x) => x } = {}) {
  const w = world({ touches: 1 });
  process.env.FLOORBOSS_HOME = w.HOME;
  const m = approvedLines(w.evDir, PEOPLE[0], 1, { at: '2026-10-12T07:30:00Z', extra: ' Tuesday at 10:00 suits?', slot_ids });
  addLines(w.evDir, m.lines.map((e) => (e.type === 'drafted' ? drafted(e) : e)));
  if (slots) slotsFile(w.evDir, slots);
  const rb = readback(w.evDir, at(NOW));
  assert.ok(rb.items.some((x) => x.id === 'c001' && x.hash === m.hash), JSON.stringify(rb.refused));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  return { ...w, hash: m.hash };
}

test('finding 1: the real draft file holds no times; the drafted line does', () => {
  const w = offering([LATER.id]);
  const file = JSON.parse(readFileSync(join(w.evDir, 'drafts', `${w.hash}.json`), 'utf8'));
  assert.equal('slot_ids' in file, false, 'saveDraft writes the text only');
  assert.deepEqual(ledgerLines(w.evDir).filter((e) => e.type === 'drafted' && e.hash === w.hash).pop().slot_ids, [LATER.id]);
  // Offering only a free time ahead: it goes.
  assert.ok(dueNow(w.HOME, at('2026-10-12T09:00:00Z')).due.some((x) => x.id === 'c001'));
});

test('finding 1: an offered time already past holds the message', () => {
  const w = offering([PAST.id, LATER.id]);
  const r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'), 'never sent offering a time already gone');
  assert.match(waitOf(r, 'c001'), /already past/);
  // The others offer no times: they go.
  assert.ok(r.due.some((x) => x.id === 'c002'));
});

test('finding 1: an offered time booked by someone else holds the message', () => {
  const w = offering([LATER.id]);
  addLines(w.evDir, [{ at: '2026-10-12T08:30:00Z', type: 'booked', who: 'user', id: 'c002', slot: LATER.id, start: LATER.start, blocks: [LATER.id], said: 'Bo booked Tuesday 10:00' }]);
  const r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.equal(waitOf(r, 'c001'), TIME_TAKEN);
});

test("finding 1: times that can't be read hold the message, never read as no times", () => {
  const cant = /can't read (the times it offers|its offered times)/;
  // A slot id that isn't in slots.json.
  let w = offering(['s20261103-1400']);
  let r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(r, 'c001'), cant);
  // No slots.json at all.
  w = offering([LATER.id], { slots: null });
  rmSync(join(w.evDir, 'slots.json'), { force: true });
  r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(r, 'c001'), cant);
  // A drafted line with no slot_ids (not as floorboss writes it: it always says, [] for none).
  w = offering([], { drafted: ({ slot_ids, ...rest }) => (void slot_ids, rest) });
  r = dueNow(w.HOME, at('2026-10-12T09:00:00Z'));
  assert.ok(!r.due.some((x) => x.id === 'c001'));
  assert.match(waitOf(r, 'c001'), cant);
  // An empty list is "no times": it goes.
  w = offering([]);
  assert.ok(dueNow(w.HOME, at('2026-10-12T09:00:00Z')).due.some((x) => x.id === 'c001'));
});

test('finding 2: "settle --went yes" for a step auto-send never let go is a hand send: auto-send ends for the rest', () => {
  const w = world({ touches: 2, people: [PEOPLE[0]] });
  process.env.FLOORBOSS_HOME = w.HOME;
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  // Message 1 missed its day (the cloud never ran); the user sent it from Gmail, then said "sent".
  const r = autosend(w.HOME, ['settle', '--event', w.slug, '--id', 'c001', '--touch', '1', '--went', 'yes', '--said-file', said(w.HOME, 'I sent it myself from Gmail')], { now: '2026-10-15T10:00:00Z' });
  assert.ok(!r.ERROR, r.ERROR);
  const sent = ledgerLines(w.evDir).filter((e) => e.type === 'sent');
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].source, 'autosend', 'no release line: never recorded as auto-send');
  for (const d of ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-26']) {
    const p = dueNow(w.HOME, at(`${d}T10:00:00Z`));
    assert.ok(!p.due.some((x) => x.id === 'c001'), d);
  }
  assert.match(waitOf(dueNow(w.HOME, at('2026-10-19T10:00:00Z')), 'c001'), /yours to send/);
});

test('finding 2: the readback and approve name the exact command for a hand send; the skill says record, never settle', () => {
  const w = world({ touches: 2, people: [PEOPLE[0]] });
  process.env.FLOORBOSS_HOME = w.HOME;
  let rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  // Message 1's day and the day after went by: it was the user's on the outbox since.
  const t = at('2026-10-15T08:30:00Z');
  const cli = autosend(w.HOME, ['readback', '--event', w.slug], { now: '2026-10-15T08:30:00Z' });
  assert.ok(!cli.ERROR, cli.ERROR);
  const cmd = /event-outreach\/scripts\/cli\.mjs" record --event harbor-expo --file .*"who":"c001","what":"sent","touch":1/;
  assert.match((cli.hand_sent || []).map((x) => x.record).join('\n'), cmd);
  assert.match(cli.show, /never settle/);
  rb = readback(w.evDir, t);
  assert.throws(() => approve(w.evDir, { digest: rb.digest, said: SENTENCE }, t), (e) => /--not-sent-said/.test(e.message) && cmd.test(e.message));
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  const part = skill.slice(skill.indexOf('## Auto-send from the cloud'));
  assert.match(part, /sent themselves[^.]*`record`[^.]*never `settle`/);
});

test('finding 3: after a hand send, a later step whose day went by on the outbox needs the word it was not sent', () => {
  const w = world({ touches: 3, people: [PEOPLE[0]] });
  process.env.FLOORBOSS_HOME = w.HOME;
  let rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  // Message 1 sent by hand on the 12th (as event-outreach record writes it: no source): auto-send ended for Ana.
  addLines(w.evDir, [{ at: '2026-10-12T10:00:00Z', type: 'sent', who: 'user', id: 'c001', touch: 1, date: '2026-10-12', message_id: 'h1', thread_id: 'ht1' }]);
  // Message 2 sat on the outbox past its day. The readback on the 26th offers it again.
  const t = at('2026-10-26T08:30:00Z');
  rb = readback(w.evDir, t);
  const m2 = rb.items.find((x) => x.touch === 2);
  assert.ok(m2, JSON.stringify(rb.refused));
  assert.equal(m2.missed, true, 'its day went by on the outbox: it may have been sent by hand');
  assert.match(rb.text, /If you sent it/);
  assert.throws(() => approve(w.evDir, { digest: rb.digest, said: SENTENCE }, t), /--not-sent-said/);
  assert.equal(ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved').length, 3, 'nothing written');
  const r = approve(w.evDir, { digest: rb.digest, said: SENTENCE, notSentSaid: "no, I didn't send the second one" }, t);
  assert.equal(r.approved, 2);
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_approved' && e.touch === 2 && e.not_sent_said));
  assert.ok(dueNow(w.HOME, at('2026-10-26T10:00:00Z')).due.some((x) => x.id === 'c001' && x.touch === 2));
});

test('finding 3: a follow-up whose day has not come yet needs no such word', () => {
  const w = world({ touches: 2, people: [PEOPLE[0]] });
  process.env.FLOORBOSS_HOME = w.HOME;
  let rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  addLines(w.evDir, [{ at: '2026-10-15T10:00:00Z', type: 'sent', who: 'user', id: 'c001', touch: 1, date: '2026-10-15' }]);
  const t = at('2026-10-16T08:30:00Z');
  rb = readback(w.evDir, t);
  assert.ok(rb.items.some((x) => x.touch === 2 && !x.missed));
  assert.equal(approve(w.evDir, { digest: rb.digest, said: SENTENCE }, t).approved, 1);
});

test('finding 4: the rate_notes question reads in Claude Code exactly as at 8e9f440', async () => {
  const { rateNotesQuestion } = await import('../skills/flow/scripts/steps/drafting.mjs');
  const saved = { ...process.env };
  const notes = ['too long', 'open with their problem'];
  try {
    for (const k of CODEX_MARKERS) delete process.env[k];
    process.env.CLAUDECODE = '1';
    assert.equal(
      rateNotesQuestion(notes),
      'Your notes: "too long"; "open with their problem". Apply them to every draft, so each is written again to them (and they become rules in your voice file)? Or only the ones you rated: each draft with a note is written again to its own note (anything rated 3 or less already is), and the rest stay as they are?'
    );
    process.env.CODEX_THREAD_ID = 'codex-thread';
    assert.equal(
      rateNotesQuestion(notes),
      'Your notes: "too long"; "open with their problem". Apply them to every draft, so each is written again to them (and floorboss keeps them as rules for how you write, so later drafts follow them too)? Or only the ones you rated: each draft with a note is written again to its own note (anything rated 3 or less already is), and the rest stay as they are?'
    );
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
