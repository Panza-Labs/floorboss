// 0.1.7, the owner's rule for the LinkedIn reply check (it replaces the per-name question):
// 1. With a CRM task tool: no question. The task carries the check; the follow-up is due on its day, nothing held.
// 2. Without a CRM: one short question a day, a count and no names ("show me the list" gives the names); held until answered.
// 3. LinkedIn inbox reading allowed: no question, floorboss reads it; if that read fails, back to 2.
// 4. A reply reported later still cancels that person's follow-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { setup, cli, triage, draftApprove, idOf, NOW } from './fixtures/harness.mjs';
import { append, readLedger, fold } from '../lib/ledger.mjs';
import { loadEvent } from '../lib/event.mjs';
import { linkedinReplyStep, replyQuestion } from '../skills/flow/scripts/steps/channels.mjs';
import { DRAFTS_SAVERS } from '../skills/flow/scripts/savers/drafts.mjs';

const DUE = '2026-11-05T08:00:00Z';
const TASKS = { 'crm.create_task': { server: 'crm-a', tool: 'create_task', args: { title: '{title}', body: '{body}', due: '{due}', contact: '{contact_ref}' } } };
const add = (H, e, now) => append(join(H.dir, 'ledger.jsonl'), { who: 'user', said: 'noted', ...e }, new Date(now));
function mk(config = null) {
  const H = setup({ attendees: 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,,https://www.linkedin.com/in/ana\nBo Li,VP,Globex,,https://www.linkedin.com/in/bo\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['linkedin', 'linkedin'], linkedin_messages: true } });
  if (config) writeFileSync(join(H.HOME, 'config.json'), JSON.stringify(config));
  triage(H);
  assert.ok(!draftApprove(H).gate.ERROR);
  for (const n of ['Ana Berg', 'Bo Li']) add(H, { type: 'sent', id: idOf(H, n), touch: 1, date: '2026-10-12', via: 'outbox', who: 'floorboss' }, NOW);
  return H;
}
const due = (H) => cli(H, 'event-outreach', ['linkedin-due', '--event', H.slug], DUE).ask;
function stepAt(H, settings = {}, failed = null) {
  const prev = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    const ev = loadEvent(H.slug);
    const { entries } = readLedger(ev.paths.ledger);
    const state = fold(entries);
    if (failed) state.tool_failed = { ...(state.tool_failed || {}), [failed]: { at: DUE } };
    return linkedinReplyStep({ now: new Date(DUE), home: H.HOME, cfg: {} }, { ...ev, settings: { ...ev.settings, ...settings }, entries, state, today: DUE.slice(0, 10) }, {});
  } finally {
    if (prev === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = prev;
  }
}
const page = (H) => {
  assert.ok(!cli(H, 'event-outreach', ['render', '--event', H.slug], DUE).ERROR);
  return readFileSync(join(H.dir, 'outbox.html'), 'utf8');
};

test('1. with a CRM task tool: no question, and the follow-ups are due with Copy and Sent', () => {
  const H = mk({ connectors: TASKS });
  assert.deepEqual(due(H), []);
  assert.equal(stepAt(H), null);
  const html = page(H);
  assert.match(html, /id="dueToday"/);
  assert.doesNotMatch(html, /floorboss asks you first/);
});

test('2. without a CRM: one short question with a count, no names', () => {
  const H = mk();
  const s = stepAt(H);
  assert.equal(s.ask.id, 'no_reply');
  assert.equal(s.ask.question, '2 LinkedIn follow-ups are due today. Did any of them reply on LinkedIn? Name them, say "none", or say "show me the list".');
  assert.doesNotMatch(s.ask.question, /Ana|Bo Li/);
  assert.match(page(H), /floorboss asks you first/, 'held until answered');
});

test('2. one person: the question names them, yes or no', () => {
  assert.equal(replyQuestion([{ id: 'c001', name: 'Ana Berg' }]), 'A LinkedIn follow-up is due today for Ana Berg. Did Ana Berg reply on LinkedIn? Say "no", or "yes".');
});

test('2. 250 people due: still one short line', () => {
  const people = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, name: `Person Number${i}` }));
  const q = replyQuestion(people);
  assert.equal(q, '250 LinkedIn follow-ups are due today. Did any of them reply on LinkedIn? Name them, say "none", or say "show me the list".');
  assert.ok(q.length < 140);
});

test('2. "show me the list" gives the names and points to Due today, records nothing, and the question comes again', () => {
  const H = mk();
  const s = stepAt(H);
  const r = DRAFTS_SAVERS.no_reply('show me the list', { event: { slug: H.slug } }, s);
  assert.equal(r.recorded, 0);
  assert.match(r.say_to_user, /Ana Berg, Bo Li/);
  assert.match(r.say_to_user, /Due today/);
  assert.ok(stepAt(H), 'asked again');
});

test('3. LinkedIn inbox reading allowed: floorboss reads it; if that read failed, the question', () => {
  const H = mk();
  assert.equal(stepAt(H, { inbox_read: { linkedin: true } }).step, 'check_inbox');
  assert.equal(stepAt(H, { inbox_read: { linkedin: true } }, 'inbox.linkedin').step, 'no_reply_check');
});

test('4. a reply reported later cancels that follow-up, with or without a CRM', () => {
  for (const cfg of [null, { connectors: TASKS }]) {
    const H = mk(cfg);
    add(H, { type: 'replied', id: idOf(H, 'Ana Berg'), source: 'user' }, DUE);
    const html = page(H);
    const sec = /<section[^>]*id="dueToday"[\s\S]*?<\/section>/.exec(html)?.[0] || '';
    assert.doesNotMatch(sec, /Ana Berg/);
    assert.doesNotMatch(html, /data-id="c001" data-touch="2"/);
  }
});
