// A whole campaign as a Codex user runs it (lib/harness.mjs: Codex markers, no CLAUDECODE): the mock event to approved
// messages with no connected-tool step at all, an outbox whose email cards open in the user's mail app with the exact
// approved text, then sends, a reply and a no recorded by the user's word, and the follow-up that comes due, timed
// from the recorded send and only for the one who didn't answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { drive, simplePersona, ROOT } from './lib/driver.mjs';
import { readLedger, fold } from '../../lib/ledger.mjs';
import { CODEX_MARKERS } from '../../lib/harness.mjs';

const SLUG = 'mock-harbour-haul';
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const cardsOf = (html) =>
  [...html.matchAll(/<article class="card[^"]*" data-id="([^"]+)" data-touch="(\d+)"[\s\S]*?<\/article>/g)].map((m) => ({ id: m[1], touch: Number(m[2]), html: m[0] }));
const mailto = (card) => {
  const m = /href="(mailto:[^"]*)"/.exec(card.html);
  if (!m) return null;
  const u = new URL(unescape(m[1]));
  return { to: u.pathname, subject: u.searchParams.get('subject'), body: u.searchParams.get('body') };
};
const pre = (card, part) => {
  const m = new RegExp(`<pre id="${card.id}-t${card.touch}-${part}">([\\s\\S]*?)</pre>`).exec(card.html);
  return m ? unescape(m[1]) : null;
};

test('Codex: a whole campaign by hand, with no connected-tool step and send buttons on the outbox', { timeout: 1200000 }, () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-codex-'));
  mkdirSync(join(HOME, 'work'), { recursive: true });
  mkdirSync(join(HOME, 'scan-home'), { recursive: true });
  const env = { ...process.env, FLOORBOSS_HOME: HOME, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home'), CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
  delete env.CLAUDECODE;
  // A Claude Code setup on the same machine left a send connection and sending on: Codex must not use either.
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': { server: 'claude_ai_Gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}' } } }, sending: { channels: ['email'], followups: 'scheduled' } }));
  const day = (d) => `${d}T09:00:00Z`;
  const now = day('2026-10-12');
  execFileSync('node', [join(ROOT, 'examples/mock-event/load.mjs'), '--goal', 'buyers', '--now', now], { env });
  const steps = [];
  const per = simplePersona({ slug: SLUG, asks: { replies_since: 'none', check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n') } });
  const onStep = (s) => steps.push(s);
  const run = drive({ HOME, now, env: { ...env, FLOORBOSS_NOW: now } }, per, { maxSteps: 200, onStep });
  assert.ok(run.last.done);
  // Not one step asked for a connected tool, a send or a browser.
  assert.deepEqual(steps.filter((s) => s.call).map((s) => s.step), []);
  assert.ok(!steps.some((s) => /send|stage|browser|crm_log_window|test_call/.test(s.step)), steps.map((s) => s.step).join(' '));
  // The review is in the chat: the approval's run_first is flow review (a sample, the total, one read-only document),
  // never the review page.
  const ap = steps.find((s) => s.step === 'approve');
  assert.ok(ap, 'an approval step');
  assert.equal(ap.run_first[2], 'review');
  assert.doesNotMatch(JSON.stringify(ap), /review page|--review|outbox\.html/);
  assert.ok(ap.accepts.includes('review_feedback'));
  const rv = JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), ...ap.run_first.slice(2)], { env: { ...env, FLOORBOSS_NOW: now }, encoding: 'utf8' }));
  assert.ok(rv.total >= 10, String(rv.total));
  assert.ok(rv.sample.length >= 2 && rv.sample.length <= 4, String(rv.sample.length));
  assert.ok(rv.sample.every((m) => m.subject && m.body && m.to));
  assert.equal(new Set(rv.sample.map((m) => m.id)).size, rv.sample.length, 'different people');
  assert.match(ap.ask.question, new RegExp(`Approve all ${rv.total} messages`));
  assert.match(rv.approval_line, new RegExp(`^Approve all ${rv.total} messages`));
  const doc = readFileSync(rv.document, 'utf8');
  assert.equal((doc.match(/^### Message /gm) || []).length, rv.total, 'every message in the document');

  const dir = join(HOME, 'events', SLUG);
  const html = readFileSync(join(dir, 'outbox.html'), 'utf8');
  const cards = cardsOf(html);
  const st = fold(readLedger(join(dir, 'ledger.jsonl')).entries);
  const optout = "If this isn't relevant, say so and I won't follow up.";
  let withButtons = 0;
  for (const c of cards) {
    const m = mailto(c);
    if (!m) continue;
    withButtons++;
    // The link's text is the card's text: the approved subject and body, CRLF line breaks, the opt-out line kept.
    assert.equal(m.body, pre(c, 'body').replace(/\n/g, '\r\n'), c.id);
    assert.equal(m.subject, pre(c, 'subject'), c.id);
    assert.ok(m.body.trimEnd().endsWith(optout), `${c.id}: opt-out line last`);
    assert.equal(m.to.toLowerCase(), String(st.people[c.id].touches[c.touch].approved?.to || '').toLowerCase() || m.to.toLowerCase(), c.id);
    // And its .eml is next to the page.
    assert.ok(existsSync(join(dir, 'mail', `${c.id}-t${c.touch}.eml`)), c.id);
  }
  assert.ok(withButtons >= 10, `cards with send buttons: ${withButtons}`);
  assert.equal(readdirSync(join(dir, 'mail')).length, withButtons, 'one .eml per card with buttons, no more');
  // Nobody on the do-not-contact list or opted out has a card.
  const stopped = Object.entries(st.people).filter(([, p]) => p.stopped || p.suppressed).map(([id]) => id);
  for (const id of stopped) assert.ok(!cards.some((c) => c.id === id), id);

  // The user sends three from their mail app and says so.
  const emailed = cards.filter((c) => mailto(c)).slice(0, 3).map((c) => c.id);
  assert.equal(emailed.length, 3);
  const cli = (args, at) => JSON.parse(execFileSync('node', [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), ...args], { env: { ...env, FLOORBOSS_NOW: at }, encoding: 'utf8' }));
  const rec = (items, at) => {
    const f = join(HOME, 'work', `rec-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ items }));
    return cli(['record', '--event', SLUG, '--file', f], at);
  };
  const sent = rec(emailed.map((who) => ({ who, what: 'sent', date: '2026-10-12', channel: 'email' })), day('2026-10-12'));
  assert.equal(sent.applied, true, JSON.stringify(sent));
  const after = cardsOf(readFileSync(join(dir, 'outbox.html'), 'utf8'));
  for (const id of emailed) {
    assert.ok(!after.some((c) => c.id === id && c.touch === 1), `${id}: its sent message is no longer offered`);
    assert.ok(!existsSync(join(dir, 'mail', `${id}-t1.eml`)), `${id}: its .eml is gone`);
  }

  // Three days on, one replied (no time in it) and one said no, in the user's words.
  const [quiet, answered, no] = emailed;
  const r = rec(
    [
      { who: answered, what: 'replied', said: 'thanks, will come by the stand', date: '2026-10-15' },
      { who: no, what: 'declined', said: 'not interested', date: '2026-10-15' }
    ],
    day('2026-10-15')
  );
  assert.equal(r.applied, true, JSON.stringify(r));
  const st2 = fold(readLedger(join(dir, 'ledger.jsonl')).entries);
  assert.ok(st2.people[answered].replied, 'reply recorded');
  assert.ok(st2.people[no].declined || st2.people[no].replied || st2.people[no].stopped, 'no recorded');

  // A follow-up is due a gap after the recorded send, not before: on 2026-10-15 nothing is due for anyone sent on the
  // 12th; on 2026-10-19 (seven days on: the event is three weeks off) the quiet one's follow-up is, and only theirs.
  const todoOn = (at) => JSON.parse(readFileSync(cli(['todo', '--event', SLUG], at).todo_file, 'utf8'));
  const dueFor = (t, id) => (t.jobs || []).filter((j) => j.id === id && j.touch > 1);
  const early = todoOn(day('2026-10-15'));
  for (const id of emailed) assert.deepEqual(dueFor(early, id), [], `${id}: nothing due three days after the send`);
  const due = todoOn(day('2026-10-19'));
  assert.equal(dueFor(due, quiet).length, 1, `${quiet}: a follow-up due seven days after the send: ${JSON.stringify((due.jobs || []).map((j) => `${j.id}:${j.touch}`))}`);
  assert.deepEqual(dueFor(due, answered), [], 'no follow-up after a reply');
  assert.deepEqual(dueFor(due, no), [], 'no follow-up after a no');
  for (const k of CODEX_MARKERS.slice(0, 2)) assert.ok(env[k], 'ran as Codex throughout');
});
