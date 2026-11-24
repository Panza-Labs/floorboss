// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A simulated beginner's Codex run (2026-11-20), each finding with its test:
// 1. an out-of-office holds a follow-up due while they're away, in hand-send, until the first working day after;
// 2. setup questions in hand-send carry a plain question for the user and the agent's own notes apart;
// 3. a later day's plain `next` picks the one event on this computer and asks what came back first;
// 4. the outbox's email cards in hand-send have Copy address, subject and message, the approved text exactly;
// 5. a reply for someone never sent is said, one time label, a "reach because" keeps its segment, the relative-day
//    check quotes where the word is, and a confirmation waiting is named as one in the summary;
// 6, 7. the Codex skill and the README say what a beginner needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { MOCK, json } from './fixtures/r2.mjs';
import { sentHome, runAs } from './fixtures/codex-sent.mjs';
import { NODES } from '../skills/event-context/scripts/onboarding-tree.mjs';
import { onboardingAsk } from '../skills/flow/scripts/steps/setup.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { checkDraft } from '../skills/event-outreach/scripts/checks.mjs';

const record = (HOME, codex, items, now = null) => {
  const f = join(HOME, 'work', `rec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ items }));
  return runAs(HOME, codex, 'event-outreach', ['record', '--event', MOCK, '--file', f], now ? { FLOORBOSS_NOW: now } : {});
};
const dueOf = (HOME, codex, id) => (runAs(HOME, codex, 'event-outreach', ['summary', '--event', MOCK]).follow_ups_due || []).find((d) => d.id === id)?.due ?? null;
// Runs fn with this process read as Codex (hand-send) or as Claude Code.
function asMode(codex, fn) {
  const keep = { CLAUDECODE: process.env.CLAUDECODE, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID };
  if (codex) {
    delete process.env.CLAUDECODE;
    process.env.CODEX_SESSION_ID = 'codex-sess';
  } else {
    process.env.CLAUDECODE = '1';
    delete process.env.CODEX_SESSION_ID;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// 1. The mock's first follow-ups are due Mon 19 Oct. Away until Wed 21 Oct: in hand-send it waits for Thu 22 Oct.
test('1. hand-send: a follow-up due while they are away waits until the first working day after, and the readback says so', { timeout: 300000 }, () => {
  const { HOME, sent } = sentHome(true);
  const [away, other, gone] = sent;
  assert.equal(dueOf(HOME, true, away), '2026-10-19');
  const r = record(HOME, true, [{ who: away, what: 'away', until: '2026-10-21', said: "I'm away until the 21st" }]);
  assert.ok(!r.ERROR, r.ERROR);
  const line = r.recorded.find((l) => /away until 2026-10-21/.test(l));
  assert.ok(line, r.recorded.join(' | '));
  assert.doesNotMatch(line, /go on as planned/);
  assert.match(line, /no follow-up before Thu 22 Oct/);
  assert.equal(dueOf(HOME, true, away), '2026-10-22', 'held to the first working day after they are back');
  assert.equal(dueOf(HOME, true, other), '2026-10-19', 'nobody else moves');
  const s = runAs(HOME, true, 'event-outreach', ['summary', '--event', MOCK]);
  assert.match(s.away.find((a) => a.id === away).note, /no follow-up before Thu 22 Oct/);
  // Away past the event's last day: no follow-up left for them.
  assert.ok(!record(HOME, true, [{ who: gone, what: 'away', until: '2026-11-04', said: 'back after the show' }]).ERROR);
  assert.equal(dueOf(HOME, true, gone), null);
});

test('1. Claude Code: an out-of-office still leaves the follow-ups on their days, worded as before', { timeout: 300000 }, () => {
  const { HOME, sent } = sentHome(false);
  const r = record(HOME, false, [{ who: sent[0], what: 'away', until: '2026-10-21', said: "I'm away until the 21st" }]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(r.recorded.some((l) => / is away until 2026-10-21: follow-ups go on as planned$/.test(l)), r.recorded.join(' | '));
  assert.equal(dueOf(HOME, false, sent[0]), '2026-10-19');
});

// 2. Setup questions.
const OB = { inv: { items: [], found: {}, writers: [], outbound: 'none', counts: {} }, cfg: {}, ev: null, ans: { setup_level: 'full' }, slots: 0, list: null };
const AGENT_WORDS = /\b(look it up|propose|once they say|ask (whether|which|for|only)|say how many|save it|read their words|json)\b|[{}]/i;
test('2. hand-send: a setup question is a plain question for the user, with the agent\'s notes apart', () => {
  const codex = asMode(true, () => onboardingAsk({ ob: OB }, 'first'));
  assert.equal(codex.ask.id, 'event');
  assert.doesNotMatch(codex.ask.question, AGENT_WORDS, codex.ask.question);
  assert.match(codex.ask.how_to_ask, /plain words/);
  assert.match(codex.ask.how_to_ask, /never ask (the user )?for (a|the) (time )?zone/i);
  assert.match(codex.ask.how_to_ask, /city/);
  // With a name given already, the question is still the user's.
  const hinted = asMode(true, () => onboardingAsk({ ob: { ...OB, ans: { ...OB.ans, event_hint: 'Harbour Expo' } } }, 'first'));
  assert.doesNotMatch(hinted.ask.question, AGENT_WORDS, hinted.ask.question);
  // Claude Code reads as Codex since 2026-11-21 (one product for both hosts): the same plain question for the user, the
  // tree's own wording going to the agent's notes (for_agent) apart from it, plus the same how_to_ask.
  const cc = asMode(false, () => onboardingAsk({ ob: OB }, 'first'));
  assert.equal(cc.ask.question, codex.ask.question);
  assert.doesNotMatch(cc.ask.question, AGENT_WORDS, cc.ask.question);
  assert.equal(cc.ask.how_to_ask, codex.ask.how_to_ask);
  assert.equal(cc.ask.for_agent, NODES.find((n) => n.id === 'event').ask({ ...OB, ans: OB.ans }));
});

test('2. hand-send: every question the beginner hit has a plain wording and a note to turn the answer into its shape', async () => {
  const { HAND_SEND_ASKS } = await import('../skills/flow/scripts/steps/wording.mjs');
  const s = { ...OB, ev: { slug: 'x', name: 'X Expo', city: 'Porto', time_zone: 'Europe/Lisbon' }, cfg: { own_company: 'Acme', goal: 'buyers', drafting_mode: 'floorboss' }, ans: { ...OB.ans, crm_choice: 'export', works_alone: false } };
  for (const id of ['event', 'goal', 'offer', 'free_time', 'dnc', 'team', 'company', 'crm_name', 'samples', 'coworker_contacts']) {
    const h = HAND_SEND_ASKS[id];
    assert.ok(h, id);
    const q = h.question(s);
    assert.ok(q && q.length > 10, id);
    assert.doesNotMatch(q, AGENT_WORDS, `${id}: ${q}`);
    assert.ok(h.how.length > 10, id);
  }
  assert.match(HAND_SEND_ASKS.samples.how, /write the three sample openings yourself/i);
});

// 3. The next day.
function realHome(slugs) {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-days-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true }));
  for (const slug of slugs) {
    const dir = join(HOME, 'events', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ slug, name: `${slug} Expo`, city: 'Porto', time_zone: 'Europe/Lisbon', start_date: '2026-11-03', end_date: '2026-11-04', settings: {} }));
    const L = [
      { at: '2026-10-10T08:00:00Z', type: 'person', who: 'floorboss', id: 'c001', name: 'Ana Lima', email: 'ana@acme.example', company: 'Acme', keys: ['e:ana@acme.example'] },
      { at: '2026-10-10T09:00:00Z', type: 'sent', who: 'user', id: 'c001', touch: 1, date: '2026-10-10', via: 'user', said: 'sent' }
    ];
    writeFileSync(join(dir, 'ledger.jsonl'), L.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return HOME;
}
test('3. hand-send: plain next with one event on this computer goes on with it; with two it asks which', () => {
  const one = realHome(['northgate']);
  const a = runAs(one, true, 'flow', ['next']);
  assert.notEqual(a.step, 'which_event', JSON.stringify(a).slice(0, 300));
  assert.equal(a.event, 'northgate', JSON.stringify(a).slice(0, 300));
  // Claude Code asks, as before.
  assert.equal(runAs(realHome(['northgate']), false, 'flow', ['next']).step, 'which_event');
  assert.equal(runAs(realHome(['northgate', 'southgate']), true, 'flow', ['next']).step, 'which_event');
});

test('3. hand-send: a later day starts with what came back, whether or not anything is due', { timeout: 300000 }, () => {
  const { HOME } = sentHome(true);
  // The day after the sends: nothing is due until 19 Oct.
  const s = runAs(HOME, true, 'flow', ['next', '--event', MOCK], { FLOORBOSS_NOW: '2026-10-13T09:00:00Z' });
  assert.equal(s.step, 'replies_since', JSON.stringify(s).slice(0, 300));
  assert.match(s.ask.question, /^Since 2026-10-12, has anyone you wrote to replied/);
});

// 4. The outbox's copy fallback.
const EV = { name: 'Test Expo', slug: 'ev', city: 'Porto', start_date: '2026-11-10', end_date: '2026-11-12', time_zone: 'Europe/Lisbon' };
const CARD = {
  id: 'c001',
  touch: 1,
  kind: 'message',
  channel: 'email',
  you_send: true,
  name: 'Ana Lima',
  title: 'COO',
  company: 'Acme',
  address: 'ana@acme.example',
  send_to: 'ana@acme.example',
  subject: 'Coffee at "Test Expo" & <booth 4>?',
  body: 'Hi Ana,\n\nCould we meet at Test Expo, Tue 10 Nov at 10:00? bcc: x@evil.example\n\nBest,\nSam\n\nIf this isn\'t relevant, say so and I won\'t follow up.',
  verdict: { verdict: 'PASS', reasons: [] }
};
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const textOf = (html, id) => {
  const m = new RegExp(`<(pre|span)[^>]* id="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? unescape(m[2]) : null;
};
test('4. hand-send: an email card offers Copy address, subject and message, each the approved text exactly', () => {
  const html = renderOutbox({ event: EV, cards: [CARD], counts: {}, generatedAt: 'x', hand_send: true });
  const send = /<div class="send"[\s\S]*?<\/div>/.exec(html)[0];
  assert.match(send, /If the mail-app button doesn't work, copy these three into a new email\./);
  const ids = [...send.matchAll(/<button type="button" class="copy" data-copy="([^"]+)">(Copy [a-z]+)<\/button>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(ids.map((x) => x[0]), ['Copy address', 'Copy subject', 'Copy message']);
  const [to, subject, body] = ids.map(([, id]) => textOf(html, id));
  assert.equal(to, CARD.send_to);
  assert.equal(subject, CARD.subject);
  assert.equal(body, CARD.body);
  // One address, and only that one: nothing else the page copies is a recipient.
  assert.equal((to.match(/@/g) || []).length, 1);
  assert.doesNotMatch(to, /[,;\s]/);
  // Claude Code's card is as it was.
  const cc = renderOutbox({ event: EV, cards: [CARD], counts: {}, generatedAt: 'x' });
  const ccSend = /<div class="send"[\s\S]*?<\/div>/.exec(cc)[0];
  assert.doesNotMatch(ccSend, /data-copy|copy these three/);
});

// 5a, 5b, 5e. Recording.
test('5. a reply from someone never marked sent is said; a booking reads in the event city\'s time; a waiting confirmation is named', { timeout: 300000 }, () => {
  for (const codex of [true, false]) {
    const { HOME, sent } = sentHome(codex);
    const people = json(join(HOME, 'events', MOCK, 'derived', 'contacts.json')).map((p) => p.id);
    const never = people.find((id) => !sent.includes(id));
    const r = record(HOME, codex, [{ who: never, what: 'replied', said: 'thanks, not now' }]);
    assert.ok(!r.ERROR, r.ERROR);
    assert.ok(r.notes.some((n) => /they weren't marked sent; recorded anyway/.test(n)), `${codex}: ${r.notes.join(' | ')}`);
    const r2 = record(HOME, codex, [{ who: sent[1], what: 'replied', said: 'yes' }]);
    assert.ok(!r2.notes.some((n) => /weren't marked sent/.test(n)), r2.notes.join(' | '));
    // The event's city, not the zone's, on the booking (the slots say it so too).
    const evf = join(HOME, 'events', MOCK, 'event.json');
    writeFileSync(evf, JSON.stringify({ ...json(evf), city: 'Porto' }));
    const b = record(HOME, codex, [{ who: sent[2], what: 'booked', time: '2026-11-03 10:00', said: 'Tue 10:00 works' }]);
    assert.ok(!b.ERROR, b.ERROR);
    assert.ok(b.recorded.some((l) => /10:00 Porto time/.test(l)), b.recorded.join(' | '));
    assert.ok(!b.recorded.some((l) => /Lisbon time/.test(l)), b.recorded.join(' | '));
    // Its confirmation, drafted and approved (as the drafting step writes them): the summary names it as one.
    const L = (e) => appendFileSync(join(HOME, 'events', MOCK, 'ledger.jsonl'), JSON.stringify({ at: NOW, ...e }) + '\n');
    const hash = 'ab'.repeat(12);
    L({ type: 'drafted', who: 'floorboss', id: sent[2], touch: 0, kind: 'confirmation', hash, booked_slot: null, checks: [] });
    L({ type: 'approved', who: 'user', id: sent[2], touch: 0, hash, to: 'x@y.example', via: 'you', said: 'approve all' });
    const sum = runAs(HOME, codex, 'event-outreach', ['summary', '--event', MOCK]);
    const w = (sum.in_outbox_to_send || []).find((x) => x.id === sent[2] && x.touch === 0);
    assert.ok(w, JSON.stringify(sum.in_outbox_to_send || sum).slice(0, 400));
    assert.equal(w.what, 'meeting booked: confirmation ready');
  }
});

// 5c. "reach X because …" on someone the fit was unsure of keeps the segment the fit read.
test('5. a "reach because" on an unsure fit keeps its segment', { timeout: 300000 }, () => {
  const { HOME, sent } = sentHome(true);
  const people = json(join(HOME, 'events', MOCK, 'derived', 'contacts.json')).map((p) => p.id);
  const id = people.find((x) => !sent.includes(x) && x !== 'c009');
  const fit = runAs(HOME, true, 'crm-triage', ['fit', '--event', MOCK, '--fits', JSON.stringify([{ id, segment: 'procurement', reason: 'buys freight, not sure', unsure: true }])]);
  assert.ok(!fit.ERROR, fit.ERROR);
  const dec = runAs(HOME, true, 'crm-triage', ['decide', '--event', MOCK, '--id', id, '--group', 'reach', '--because', 'they choose the vendors']);
  assert.ok(!dec.ERROR, dec.ERROR);
  const v = runAs(HOME, true, 'crm-triage', ['view', '--event', MOCK]);
  const row = [...(v.top || []), ...(v.check_these?.people || [])].find((x) => x.id === id);
  assert.ok(row, JSON.stringify(v).slice(0, 300));
  assert.equal(row.segment, 'procurement');
  assert.match(readFileSync(join(HOME, 'events', MOCK, 'derived', 'triage.csv'), 'utf8').split('\n').find((l) => l.startsWith(`${id},`)), /,procurement,/);
});

// 5d. The relative-day check says where the word is.
test('5. the relative-day check quotes the sentence the word is in', () => {
  const p = checkDraft({ subject: 'Records', body: 'Hi Ana,\n\nCould we meet today at the stand?\n\nBest,\nSam' }, { eventName: 'Test Expo' });
  const flag = p.find((x) => /relative time words/.test(x));
  assert.match(flag, /relative time words \(today\) in "Could we meet today at the stand\?"/);
});

// 6, 7. The words.
test('6. the Codex skill: plain questions, research with nothing found, the judge command, ratings, the page path', () => {
  const t = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.match(t, /Never ask the user for JSON/);
  assert.match(t, /"Look it up…", "Propose…" or "Once they say…"/);
  assert.match(t, /write the three sample openings yourself/i);
  assert.match(t, /never ask (the user )?for a time zone/i);
  assert.match(t, /nothing_found/);
  assert.match(t, /\*\*Always run `then`/);
  assert.match(t, /"1: 6 too salesy"/);
  assert.match(t, /double-click/);
});

test('7. README: one install for every shell; the data folder is made in the project, no folder to make first', () => {
  const t = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Superseded: the data folder is <project>/floorboss in Codex (lib/paths.mjs projectHome), so no mkdir or --add-dir.
  assert.match(t, /On macOS, Linux or PowerShell:\n\n```\ngit clone https:\/\/github\.com\/Panza-Labs\/floorboss\.git\ncd floorboss\ncodex --search\n```/);
  assert.ok(!/New-Item -ItemType Directory|mkdir -p ~\/\.floorboss/.test(t));
});
