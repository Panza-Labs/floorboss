// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The live beginner test in Codex (2026-11-20), its setup and review findings:
// 1. the home time zone comes from the computer: no city, no zone question; meeting times are the show's own;
// 2. the sign-off isn't asked: "Best," and the first name the agent knows;
// 3. plain answers are saved without a read-back (the Codex skill);
// 4. each setup question left says in a clause why it's asked;
// 5. "check these" with no match to name asks only write or skip;
// 6. the availability question asks days, times not free and scheduling rules, and the slot finder applies them;
// 7. company research starts without a question, saying what and how long, and "skip" stops it;
// 8. review happens in the chat: a varied sample, the total, one read-only document, feedback through revise;
// 9. a list reloaded with only new addresses doesn't reopen the shortlist, and the approval names what changed.
// Claude Code's questions stay as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/harness.mjs';
import { makeHome, drive, simplePersona, cli } from './sims/lib/driver.mjs';
import { buildSlots } from '../skills/slot-finder/scripts/slots.mjs';
import * as WORDING from '../skills/flow/scripts/steps/wording.mjs';
const HAND_SEND_WHY = WORDING.HAND_SEND_WHY || {};
import { checkTheseQuestion } from '../skills/flow/scripts/steps/triage.mjs';

const ATT = (emails = ['ana@ana.example', 'bob@bob.example', 'cal@cal.example']) =>
  `Name,Title,Company,Email\nAna Test,Owner,Ana Guns,${emails[0]}\nBob Test,Range manager,Bob Range,${emails[1]}\nCal Test,Buyer,Cal Outdoors,${emails[2]}\n`;
const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
const ZONE = 'America/Chicago';

function homeFor(codex) {
  const H = makeHome({ attendees: ATT() });
  H.env = { ...H.env, TZ: ZONE, ...(codex ? CODEX : { CLAUDECODE: '1' }) };
  if (codex) delete H.env.CLAUDECODE;
  return H;
}
function persona(H, over = {}) {
  return simplePersona({
    asks: {
      setup_level: 'quick',
      list_source: join(H.HOME, 'inputs', 'attendees.csv'),
      goal: { goal: 'gun store owners and counter managers', goal_type: 'selling', meetings_wanted: 7, segments: [{ name: 'owners', who: 'store owners and counter managers' }] },
      offer: { one_sentence: 'point-of-sale and compliance software for independent gun stores' },
      check_these: (s) => s.ask.people.map((p) => `${p.id} reach because they run a retail counter`).join('\n'),
      company_research: 'skip',
      rate: 'skip',
      free_time: {
        days: [
          { date: '2026-11-10', from: '09:00', to: '17:00', except: [{ from: '12:00', to: '13:00' }] },
          { date: '2026-11-11', from: '09:00', to: '12:00' }
        ],
        meeting_minutes: 20,
        buffer_minutes: 10,
        max_in_row: 4,
        said: 'Tue all day, Wed until noon, not over lunch; 20-minute meetings, no more than 4 back to back, 10 minutes between'
      },
      ...(over.asks || {})
    },
    judge: {
      fit: (rows) => rows.map((r, i) => (i === 0 ? { id: r.id, segment: 'owners', reason: 'owner', score: 80 } : { id: r.id, segment: null, unsure: true, reason: 'vague title', score: 50 })),
      'onboarding:about_you': () => ({ first_name: 'Gary', from: 'account' }),
      ...(over.judge || {})
    }
  });
}
// Drives the flow, keeping every step; stops before the first step `stop` matches (it isn't done).
function run(H, per, stop = null) {
  const steps = [];
  const STOP = new Error('stop');
  try {
    const r = drive(H, per, { maxSteps: 160, onStep: (s) => { if (stop && stop(s)) throw STOP; steps.push(s); } });
    return { steps, last: r.last, slug: r.slug };
  } catch (e) {
    if (e !== STOP) throw e;
    return { steps, last: null };
  }
}
const asked = (steps) => steps.filter((s) => s.ask).map((s) => s.ask);
const voiceOf = (H) => readFileSync(join(H.HOME, 'context', cfgOf(H).context_profile, 'voice', 'SKILL.md'), 'utf8');
const cfgOf = (H) => JSON.parse(readFileSync(join(H.HOME, 'config.json'), 'utf8'));

let CODEX_RUN = null;
const codexRun = () => {
  if (CODEX_RUN) return CODEX_RUN;
  const H = homeFor(true);
  CODEX_RUN = { H, ...run(H, persona(H), (s) => s.step === 'approve') };
  return CODEX_RUN;
};
// The approve step itself (the run stops before it).
const approveStep = (H) => cli(H, 'flow', ['next', '--event', 'test-expo']);

test('1, 2. hand-send: no sign-off, city or time-zone question; the zone is the computer\'s and the sign-off "Best," and the first name', { timeout: 600000 }, () => {
  const { H, steps } = codexRun();
  const asks = asked(steps);
  assert.deepEqual(asks.filter((a) => ['about_you', 'home_tz'].includes(a.id)).map((a) => a.id), []);
  for (const a of asks) assert.doesNotMatch(String(a.question), /which city|time zone|another zone|how do you sign/i, a.id);
  assert.equal(cfgOf(H).home_tz, ZONE, 'the computer\'s own zone');
  // The sign-off is the agent's judgement of the first name it knows, never a question.
  const sign = steps.find((s) => s.step === 'onboarding:about_you');
  assert.ok(sign?.judge, 'a judge step, not an ask');
  assert.match(sign.judge.how, /Best,/);
  assert.match(sign.judge.how, /account/i);
  assert.match(sign.judge.how, /local part/i);
  const voice = voiceOf(H);
  assert.match(voice, /\*\*Sign-off:\*\* Best, Gary/);
  assert.match(voice, /\*\*Sender name:\*\* Gary/);
  // Meeting times are the show's: the availability question never asks which zone.
  const ft = asks.find((a) => a.id === 'free_time');
  assert.doesNotMatch(ft.question + ft.how_to_ask, /say if you mean another zone/i);
  assert.match(ft.how_to_ask, /never ask which (time )?zone/i);
});

test('2. hand-send: a first name from the email\'s local part is said back; the sign-off can still be changed', { timeout: 600000 }, () => {
  const H = homeFor(true);
  run(H, persona(H, { judge: { 'onboarding:about_you': () => ({ first_name: 'Gary', from: 'email' }) } }), (s) => s.ask?.id === 'free_time');
  // The answer the step saved, saved again: its reply says the name back, naming where it came from.
  const r = cli(H, 'flow', ['answer', '--event', 'test-expo', '--ask', 'about_you', '--value-file', join(H.HOME, 'work', 'about-you.json')]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.match(r.say_to_user, /Best, Gary/);
  assert.match(r.say_to_user, /your email address/);
  // The user changes it whenever they bring it up.
  writeFileSync(join(H.HOME, 'work', 'sign.json'), JSON.stringify({ sign_off: 'Thanks,\nGary Holt', sender_name: 'Gary Holt, Counterline' }));
  const ok = cli(H, 'flow', ['answer', '--event', 'test-expo', '--ask', 'about_you', '--value-file', join(H.HOME, 'work', 'sign.json')]);
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.match(voiceOf(H), /\*\*Sign-off:\*\* Thanks, Gary Holt/);
  assert.equal(cfgOf(H).home_tz, ZONE, 'changing the sign-off leaves the zone alone');
});

test('3. the Codex skill reads back only an answer it had to interpret, guess, or that looks odd', () => {
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /read it back in a line or two, and save it on their yes/);
  assert.match(skill, /save a plain answer as it is/i);
  assert.match(skill, /only when you had to interpret or guess/i);
  assert.match(skill, /looks odd/);
});

test('4. hand-send: each setup question still asked says why it is asked', { timeout: 600000 }, () => {
  const { steps } = codexRun();
  const setup = asked(steps).filter((a) => HAND_SEND_WHY[a.id]);
  assert.ok(setup.length >= 6, setup.map((a) => a.id).join(' '));
  for (const a of setup) assert.ok(String(a.question).includes(HAND_SEND_WHY[a.id]), `${a.id}: ${a.question}`);
  for (const id of ['setup_level', 'event', 'goal', 'list_source', 'company', 'dnc', 'free_time', 'offer'])
    assert.ok(setup.some((a) => a.id === id), `${id} asked, with its why`);
});

test('5. hand-send with no match to name: check_these asks only write or skip', { timeout: 600000 }, () => {
  const { steps } = codexRun();
  const ct = asked(steps).find((a) => a.id === 'check_these');
  assert.equal(ct.question, "floorboss isn't sure these people are buyers: write to them or skip? A word on why helps.");
  assert.doesNotMatch(ct.answer_format, /same-person|different-person|not-in-crm/);
  for (const p of ct.people) assert.deepEqual(p.answers, ['reach', 'skip']);
  // A person with a match to name keeps the matching question; Claude Code keeps its own words.
  assert.match(checkTheseQuestion({ ob: { ans: {} } }, CODEX, [{ rung: 'fuzzy' }]), /same person as the one shown beside them/);
  assert.match(checkTheseQuestion({ ob: { ans: {} } }, { CLAUDECODE: '1' }, [{ rung: 'fit' }]), /^For each person in check-these: same-person/);
});

test('6. hand-send availability: days, times not free and scheduling rules; slots follow them', { timeout: 600000 }, () => {
  const { H, steps } = codexRun();
  const ft = asked(steps).find((a) => a.id === 'free_time');
  assert.match(ft.question, /which days/i);
  assert.match(ft.question, /not free/i);
  assert.match(ft.question, /how long/i);
  assert.match(ft.question, /back to back/i);
  assert.match(ft.question, /between meetings/i);
  assert.match(ft.answer_format, /meeting_minutes/);
  assert.match(ft.answer_format, /max_in_row/);
  assert.match(ft.answer_format, /buffer_minutes/);
  const cfg = cfgOf(H);
  assert.equal(cfg.meeting_minutes, 20);
  assert.equal(cfg.buffer_minutes, 10);
  assert.equal(cfg.max_in_row, 4);
  const slots = JSON.parse(readFileSync(join(H.HOME, 'events', 'test-expo', 'slots.json'), 'utf8')).slots;
  assert.ok(slots.length > 4, String(slots.length));
  const wall = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  for (const s of slots) {
    assert.equal(s.minutes, 20);
    assert.match(wall(s.start), /:(00|30)$/, wall(s.start));
  }
  assert.ok(!slots.some((s) => wall(s.start) === '12:00' || wall(s.start) === '12:30'), 'nothing over lunch');
  // At most four in a row: a gap longer than the 10-minute buffer after every fourth.
  let row = 1;
  for (let i = 1; i < slots.length; i++) {
    const gap = (Date.parse(slots[i].start) - Date.parse(slots[i - 1].end)) / 60000;
    row = gap <= 10 ? row + 1 : 1;
    assert.ok(row <= 4, `five in a row at ${wall(slots[i].start)}`);
    if (gap < 10 && slots[i].day === slots[i - 1].day) assert.fail(`no buffer before ${wall(slots[i].start)}`);
  }
});

test('6. slot finder: buffer, at most N in a row, and starts on :00 or :30', () => {
  const day = '2026-11-10';
  const Z = 'Europe/Amsterdam';
  const now = new Date('2026-10-01T00:00:00Z');
  const hhmm = (s) => new Intl.DateTimeFormat('en-GB', { timeZone: Z, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s.start));
  // The default (30 minutes, no buffer, no cap) from a range on the hour is as it was.
  assert.deepEqual(buildSlots([{ date: day, start: 9 * 60, end: 11 * 60 }], { eventZone: Z, now }).slots.map(hhmm), ['09:00', '09:30', '10:00', '10:30']);
  // A range starting at :15 starts its first slot at :30.
  assert.deepEqual(buildSlots([{ date: day, start: 9 * 60 + 15, end: 11 * 60 }], { eventZone: Z, now }).slots.map(hhmm), ['09:30', '10:00', '10:30']);
  // 45-minute meetings: each start is moved up to the next :00 or :30.
  assert.deepEqual(buildSlots([{ date: day, start: 9 * 60, end: 12 * 60 }], { eventZone: Z, meetingMinutes: 45, now }).slots.map(hhmm), ['09:00', '10:00', '11:00']);
  // 20 minutes, 10 between, at most 4 in a row: a break of at least one meeting after the fourth.
  const r = buildSlots([{ date: day, start: 9 * 60, end: 13 * 60 }], { eventZone: Z, meetingMinutes: 20, bufferMinutes: 10, maxInRow: 4, now }).slots;
  assert.deepEqual(r.map(hhmm), ['09:00', '09:30', '10:00', '10:30', '11:30', '12:00', '12:30']);
  assert.ok(r.every((s) => s.minutes === 20));
  // A buffer alone: 30-minute meetings with 15 between start on the hour.
  assert.deepEqual(buildSlots([{ date: day, start: 9 * 60, end: 12 * 60 }], { eventZone: Z, bufferMinutes: 15, now }).slots.map(hhmm), ['09:00', '10:00', '11:00']);
});

test('7. hand-send: company research starts without a question, says what and how long, and "skip" stops it', { timeout: 600000 }, () => {
  const H = homeFor(true);
  const r = run(H, persona(H), (s) => s.step === 'company_briefs');
  assert.ok(!asked(r.steps).some((a) => a.id === 'company_research'), 'no question first');
  const s = cli(H, 'flow', ['next', '--event', 'test-expo']);
  assert.equal(s.step, 'company_briefs');
  assert.match(s.tell_user, /Looking up the 3 shortlisted companies/);
  assert.match(s.tell_user, /About \d+ minutes?\./);
  assert.match(s.tell_user, /"skip"/);
  assert.ok(s.accepts.includes('company_research'));
  writeFileSync(join(H.HOME, 'work', 'skip.txt'), 'skip');
  const a = cli(H, 'flow', ['answer', '--event', 'test-expo', '--ask', 'company_research', '--value-file', join(H.HOME, 'work', 'skip.txt')]);
  assert.ok(!a.ERROR, a.ERROR);
  // No web research: each company gets its "not researched" brief and drafting goes on.
  const after = cli(H, 'flow', ['next', '--event', 'test-expo']);
  assert.ok(['company_skip', 'draft'].includes(after.step), after.step);
});

test('8. hand-send review in the chat: a varied sample, the total, one read-only document; feedback goes through revise', { timeout: 600000 }, () => {
  const { H } = codexRun();
  const s = approveStep(H);
  assert.equal(s.step, 'approve');
  assert.match(s.run_first[1], /skills\/flow\/scripts\/cli\.mjs$/);
  assert.equal(s.run_first[2], 'review');
  assert.doesNotMatch(JSON.stringify(s), /review page|outbox\.html|open --review/);
  assert.match(s.ask.question, /Approve all 3 messages/);
  assert.ok(s.accepts.includes('review_feedback'));
  const rv = cli(H, 'flow', s.run_first.slice(2));
  assert.ok(!rv.ERROR, rv.ERROR);
  assert.equal(rv.total, 3);
  assert.ok(rv.sample.length >= 2 && rv.sample.length <= 4, String(rv.sample.length));
  assert.equal(new Set(rv.sample.map((x) => x.id)).size, rv.sample.length, 'different people');
  for (const m of rv.sample) {
    assert.ok(m.subject && m.body, 'full subject and body');
    assert.ok(m.name && m.to);
  }
  assert.match(rv.approval_line, /^Approve all 3 messages/);
  assert.ok(existsSync(rv.document) && /all-messages\.md$/.test(rv.document));
  const doc = readFileSync(rv.document, 'utf8');
  for (const n of ['Ana Test', 'Bob Test', 'Cal Test']) assert.match(doc, new RegExp(n));
  assert.match(doc, /read-only/i);
  // Feedback in the chat: every affected draft is sent back through revise, then drafted again.
  writeFileSync(join(H.HOME, 'work', 'fb.json'), JSON.stringify({ feedback: 'Open with their store, not with me.', ids: 'all' }));
  const f = cli(H, 'flow', ['answer', '--event', 'test-expo', '--ask', 'review_feedback', '--value-file', join(H.HOME, 'work', 'fb.json')]);
  assert.ok(!f.ERROR, f.ERROR);
  assert.equal(f.result.revised.length, 3);
  const led = readFileSync(join(H.HOME, 'events', 'test-expo', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(led.filter((x) => x.type === 'revise').length, 3);
  assert.equal(cli(H, 'flow', ['next', '--event', 'test-expo']).step, 'draft');
});

test('9. hand-send: new addresses in a reloaded list don\'t reopen the shortlist; the approval names what changed, once', { timeout: 600000 }, () => {
  const H = homeFor(true);
  const r = run(H, persona(H));
  assert.ok(r.last?.done || r.last?.step === 'waiting', r.last?.step);
  // Two hours on, the user gives the list again with three new addresses.
  H.now = '2026-10-12T10:00:00Z';
  H.env = { ...H.env, FLOORBOSS_NOW: H.now };
  const f = join(H.HOME, 'inputs', 'attendees-2.csv');
  writeFileSync(f, ATT(['ana@ana2.example', 'bob@bob2.example', 'cal@cal2.example']));
  const imp = cli(H, 'crm-triage', ['inputs', '--event', 'test-expo', '--kind', 'attendees', '--file', f]);
  assert.ok(!imp.ERROR, imp.ERROR);
  const after = run(H, persona(H), (s) => s.step === 'approve');
  assert.ok(!after.steps.some((s) => s.step === 'gate'), after.steps.map((s) => s.step).join(' '));
  const s = approveStep(H);
  assert.equal(s.step, 'approve');
  assert.match(s.tell_user, /What changed since your last yes: a new address for Ana Test, Bob Test and Cal Test/);
  assert.match(s.tell_user, /One yes covers the 3 messages/);
  // The drafts it asks about go to the new addresses.
  const rv = cli(H, 'flow', s.run_first.slice(2));
  for (const m of rv.sample) assert.match(m.to, /2\.example$/, m.to);
});

test('Claude Code: the setup questions, check_these and the research question are as they were', { timeout: 600000 }, () => {
  const H = homeFor(false);
  const r = run(H, persona(H, { asks: { about_you: { sign_off: 'Best, Gary', sender_name: 'Gary', city: 'Austin' }, company_research: 'skip' } }), (s) => s.step === 'approve');
  const asks = asked(r.steps);
  const q = (id) => asks.find((a) => a.id === id)?.question;
  assert.match(q('about_you'), /^How do you sign your messages \(your name, and company if you add it\), and which city do you live in\?/);
  assert.equal(q('check_these'), 'For each person in check-these: same-person (name the CRM row), different-person, not-in-crm (the CRM lookup gave no answer and the CRM has nobody for them), reach, warm or skip, with a word on why.');
  assert.match(q('company_research'), /^Before drafting, floorboss looks up each shortlisted company on the web/);
  assert.match(q('free_time'), /^When are you free to meet\? Say it the way you'd say it \(times are event time; say if you mean another zone\)\.$/);
  assert.equal(cfgOf(H).home_tz, 'America/Chicago', 'from the city they gave');
  const s = approveStep(H);
  assert.deepEqual(s.run_first.slice(2), ['open', '--event', 'test-expo', '--review', '--no-open']);
});
