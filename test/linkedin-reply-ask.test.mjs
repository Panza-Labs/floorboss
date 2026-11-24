// 0.1.7: floorboss can't read LinkedIn. Before a LinkedIn follow-up the user sends by hand is listed as due, the user
// is asked once whether that person replied there (one question for everyone due), and only a word about LinkedIn
// (or a read of that inbox) clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append, readLedger, fold } from '../lib/ledger.mjs';
import { loadEvent } from '../lib/event.mjs';
import { linkedinReplyStep } from '../skills/flow/scripts/steps/channels.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';

const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\nBo Li,VP,Globex,,https://www.linkedin.com/in/bo\n';
const DUE = '2026-11-05T08:00:00Z';
const mk = () => {
  const H = setup({ attendees: PEOPLE, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true } });
  triage(H);
  assert.ok(!draftApprove(H).gate.ERROR);
  for (const n of ['Ana Berg', 'Bo Li']) add(H, { type: 'sent', id: idOf(H, n), touch: 1, date: '2026-10-12', via: 'outbox', who: 'floorboss' }, NOW);
  return H;
};
const add = (H, e, now) => append(join(H.dir, 'ledger.jsonl'), { who: 'user', said: 'noted', ...e }, new Date(now));
const due = (H, now = DUE) => {
  const r = cli(H, 'event-outreach', ['linkedin-due', '--event', H.slug], now);
  assert.ok(!r.ERROR, r.ERROR);
  return r;
};
function stepAt(H, now = DUE, settings = {}) {
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    const ev = loadEvent(H.slug);
    const { entries } = readLedger(ev.paths.ledger);
    const e = { ...ev, settings: { ...ev.settings, ...settings }, entries, state: fold(entries), today: now.slice(0, 10) };
    return linkedinReplyStep({ now: new Date(now), home: H.HOME, cfg: {} }, e, {});
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
}

test('a LinkedIn follow-up due today waits for the reply question; one not due yet does not ask', () => {
  const H = mk();
  assert.deepEqual(due(H, '2026-10-13T08:00:00Z').ask, []);
  assert.deepEqual(due(H).ask.map((x) => x.name).sort(), ['Ana Berg', 'Bo Li']);
});

test('the flow asks once, about LinkedIn, for everyone due', () => {
  const H = mk();
  const s = stepAt(H);
  assert.equal(s.step, 'no_reply_check');
  assert.equal(s.ask.id, 'no_reply');
  assert.deepEqual(s.ask.channels, ['linkedin']);
  assert.deepEqual(s.ask.people.map((p) => p.name).sort(), ['Ana Berg', 'Bo Li']);
  assert.match(s.ask.question, /LinkedIn/);
  assert.equal(stepAt(H, '2026-10-13T08:00:00Z'), null, 'nothing due: no question');
});

test('the answer about LinkedIn clears it; a word about email does not', () => {
  const H = mk();
  const [ana, bo] = [idOf(H, 'Ana Berg'), idOf(H, 'Bo Li')];
  add(H, { type: 'no_reply_said', ids: [ana, bo], channel: 'email' }, DUE);
  assert.equal(due(H).ask.length, 2, 'email is another inbox');
  add(H, { type: 'no_reply_said', ids: [ana, bo], channel: 'linkedin' }, DUE);
  assert.deepEqual(due(H).ask, []);
  assert.equal(stepAt(H), null, 'asked once');
});

test('someone the user says replied on LinkedIn gets no follow-up listed', () => {
  const H = mk();
  const [ana, bo] = [idOf(H, 'Ana Berg'), idOf(H, 'Bo Li')];
  // What the no_reply saver writes for {"people":[ana, bo],"replied":[ana]} on a step that asked about LinkedIn.
  add(H, { type: 'replied', id: ana, source: 'user' }, DUE);
  add(H, { type: 'no_reply_said', ids: [bo], channel: 'linkedin' }, DUE);
  assert.deepEqual(due(H).ask, []);
  const r = cli(H, 'event-outreach', ['render', '--event', H.slug], DUE);
  assert.ok(!r.ERROR, r.ERROR);
});

test('the outbox lists a LinkedIn follow-up under Due today only once that question is answered', () => {
  const card = { kind: 'message', channel: 'paste', where: 'LinkedIn', id: 'c001', touch: 2, name: 'Ana Berg', company: 'Acme', title: 'COO', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', due_on: '2026-11-05', slots: [] };
  const page = (c) => renderOutbox({ event: { slug: 'ev', name: 'X' }, today: '2026-11-05', cards: [c], counts: {}, slots: [] });
  assert.match(page(card), /id="dueToday"/);
  const waiting = page({ ...card, li_reply_unchecked: true });
  assert.doesNotMatch(waiting, /id="dueToday"/);
  assert.match(waiting, /floorboss asks you first whether Ana Berg replied on LinkedIn/);
});
