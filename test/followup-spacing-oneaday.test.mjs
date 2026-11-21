// One message a day to one person, held against floorboss's own commands (a hand record dating a step earlier, a
// send-outcome, a resend), against two calls at once with a cleared marker standing, against odd marker files, a
// ledger that can't be written, and a second event writing to the same address; the stage check; the summary; an
// event whose dates can't be read; and a send date that isn't a date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, symlinkSync, chmodSync, appendFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setup, cli, idOf, todoJobs, ROOT, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { stageRefusal } from '../hooks/guard/sends.mjs';
import { takeMarker } from '../hooks/guard/daymark.mjs';
import { eventEnded, eventStateAt, eventRecord } from '../lib/sendcheck.mjs';
import { lentAbout } from '../lib/lent.mjs';
import { eventDayState, followupDay, noDayWhy, UNREADABLE_DATES } from '../lib/spacing.mjs';
import { parseGap } from '../lib/gap-words.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const at = (day, hh = '08:00') => `${day}T${hh}:00Z`;
const file = (H, data) => { const f = join(H.dir, `f${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, JSON.stringify(data)); return f; };
const guard = (H, input, now) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now }, encoding: 'utf8' });
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';

function ready({ route = ['email', 'email', 'email'], event = {}, gap = [1], sending = true, home = null } = {}) {
  const H = setup({ attendees: PEOPLE, event, home, settings: { ...(sending ? { sending: { channels: ['email'], followups: 'scheduled' } } : {}), route } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE }, ...(gap ? { followup_gap: gap } : {}) }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
function approveRounds(H, now = NOW) {
  for (let i = 0; i < 6; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => (x.kind === 'message' || x.kind === 'confirmation') && !x.waits_for_previous)) {
      const d = j.kind === 'confirmation' ? { subject: 'Re: Test Expo', body: `Hi Ana, confirming ${(j.slot_labels || []).join('')}. See you at Test Expo.\n\nBest, Sam` } : draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: d.subject || 'Test Expo', body: d.body, brief: 'x, no research profile', ...(d.structure ? { structure: d.structure, fact_source: d.fact_source } : {}), ...(d.insight ? { insight: d.insight } : {}) })], now);
      if (j.kind !== 'confirmation') cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
// Listed as send-list lists it: with what the other events lend about the person when it was listed (item.elsewhere,
// lib/lent.mjs), which the send check reads again.
function itemFor(H, id, touch, now) {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t${touch}.json`), 'utf8'));
  process.env.FLOORBOSS_HOME = H.HOME;
  const elsewhere = lentAbout(H.dir, { ...(eventRecord(H.dir).folded.people[id] || {}), emails: ['ana@acme.test'] });
  return { id, touch, name: 'Ana Berg', via: 'email.send', to: 'ana@acme.test', subject: d.subject || '', body: d.body, listed_at: now, elsewhere };
}
const writeList = (H, items) => writeFileSync(join(H.dir, 'derived', 'send-list.json'), JSON.stringify(items));
const record = (H, items, now) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, { items })], now);
const sentReceipt = (H, id, touch, now) => cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, { sends: [{ id, touch, message_id: `m${touch}` }] })], now);
// The real hook on one approved step, listed as a session could list it.
function hook(H, id, touch, now) {
  nobody(H, now);
  const it = itemFor(H, id, touch, now);
  writeList(H, [it]);
  return guard(H, { to: it.to, subject: it.subject, body: it.body }, now);
}
// Gap 1, three emails: planned Mon 12, Tue 13, Wed 14 Oct. Message 1 goes on the 12th.
function started(opts = {}) {
  const H = ready(opts);
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  assert.equal(hook(H, ana, 1, NOW).status, 0);
  sentReceipt(H, ana, 1, NOW);
  return { H, ana };
}
const D14 = at('2026-10-14');

test('N1: a hand record dating a released step earlier does not free the day, and --resend refuses a step recorded as sent', () => {
  const { H, ana } = started();
  // Wed 14: message 2 (planned Tue 13) is let through late, and no receipt is saved.
  assert.equal(hook(H, ana, 2, D14).status, 0, 'message 2 goes');
  // The user records message 2 as sent on Tue 13: message 3 (gap 1, planned Wed 14) now looks due today.
  assert.equal(record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-13', said: 'I sent it yesterday' }], D14).applied, true);
  // send-list --resend can't clear a step recorded as sent.
  const r = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--resend', `${ana}:2`, '--said', 'send it again', '--no-reply-check', 'nothing connected; nobody answered'], D14);
  assert.match(r.ERROR || '', /isn't waiting on an unclear send/);
  // The hook on message 3 the same day: refused, the release of message 2 today counts for today.
  const g = hook(H, ana, 3, D14);
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /already went or is going today/);
  // And send-list agrees: message 3 isn't listed today.
  nobody(H, D14);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], D14);
  const listed = existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [];
  assert.ok(!listed.some((x) => x.id === ana && x.touch === 3), JSON.stringify(listed));
  // The next day it goes.
  assert.equal(hook(H, ana, 3, at('2026-10-15')).status, 0);
});

test('N1: --resend refuses a step never let through', () => {
  const { H, ana } = started();
  const r = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--resend', `${ana}:3`, '--said', 'send it again', '--no-reply-check', 'nothing connected; nobody answered'], D14);
  assert.match(r.ERROR || '', /isn't waiting on an unclear send/);
});

test('N1: after send-outcome --went no, only that same step may go again that day', () => {
  const { H, ana } = started();
  assert.equal(hook(H, ana, 2, D14).status, 0);
  assert.equal(cli(H, 'event-outreach', ['send-outcome', '--event', H.slug, '--id', ana, '--touch', '2', '--went', 'no', '--said', "it isn't in my Sent folder"], D14).recorded, 'not sent');
  // Then a hand record dates message 2 earlier: message 3 still can't go today.
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-13', said: 'actually I sent it myself yesterday' }], D14);
  const g = hook(H, ana, 3, D14);
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /already went or is going today/);
});

test('N1: the legitimate path: a send that failed, --went no, the same step again that day goes; another step does not', () => {
  const { H, ana } = started();
  assert.equal(hook(H, ana, 2, D14).status, 0);
  assert.equal(cli(H, 'event-outreach', ['send-outcome', '--event', H.slug, '--id', ana, '--touch', '2', '--went', 'no', '--said', "it isn't in my Sent folder"], D14).recorded, 'not sent');
  // A cleared release frees the day for that same step only (the day marker): message 3 can't take it.
  const other = hook(H, ana, 3, D14);
  assert.equal(other.status, 2, 'another step is refused');
  const again = hook(H, ana, 2, D14);
  assert.equal(again.status, 0, again.stderr);
});

test('N2: one message a day to an address across two events in one home', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-two-'));
  const A = ready({ home: HOME });
  const aana = idOf(A, 'Ana Berg');
  approveRounds(A);
  // A second event with the same person approved (a copy of the first: once one event has her approved, a new one's
  // list holds her for a decision, so the guard is the only check left to test).
  const B = { HOME, slug: 'ev2', dir: join(HOME, 'events', 'ev2') };
  cpSync(A.dir, B.dir, { recursive: true });
  const ev = JSON.parse(readFileSync(join(B.dir, 'event.json'), 'utf8'));
  writeFileSync(join(B.dir, 'event.json'), JSON.stringify({ ...ev, slug: 'ev2', name: 'Other Expo' }));
  const bana = aana;
  // Event A's first message to Ana goes; event B's first message to the same address the same day is refused.
  assert.equal(hook(A, aana, 1, NOW).status, 0);
  writeList(A, []);
  const g = hook(B, bana, 1, NOW);
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /already went or is going today/);
  // Without the home folder's address marker, the other event's ledger still says so (the check reads both).
  rmSync(join(HOME, 'released'), { recursive: true, force: true });
  const g2 = hook(B, bana, 1, NOW);
  assert.equal(g2.status, 2, g2.stderr);
  assert.match(g2.stderr, /already went or is going today, for ev\b/);
  // The next day it goes.
  assert.equal(hook(B, bana, 1, at('2026-10-13')).status, 0);
});

test('N3: a ledger that can\'t be written gives the day back: the retry the same day goes', () => {
  const H = ready();
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  nobody(H, NOW);
  const it = itemFor(H, ana, 1, NOW);
  writeList(H, [it]);
  const ledger = join(H.dir, 'ledger.jsonl');
  chmodSync(ledger, 0o444);
  let g;
  try {
    g = guard(H, { to: it.to, subject: it.subject, body: it.body }, NOW);
  } finally {
    chmodSync(ledger, 0o644);
  }
  assert.equal(g.status, 2, 'blocked while the release can\'t be written');
  assert.equal(guard(H, { to: it.to, subject: it.subject, body: it.body }, NOW).status, 0, 'the same day, once it can');
});

// The marker unit: two different steps racing with a cleared marker standing, in separate processes.
const MARK = join(ROOT, 'hooks/guard/daymark.mjs');
const racer = `import { takeMarker } from ${JSON.stringify(MARK)};
const [path, owner, go] = process.argv.slice(1);
while (Date.now() < Number(go)) {}
const r = takeMarker(path, owner, (o) => (o.id === 'c001' && o.touch === 2 ? 1 : 0));
process.stdout.write(r ? 'Y' : 'N');`;
function race(path, owners) {
  const go = Date.now() + 400;
  return Promise.all(
    owners.map(
      (o) =>
        new Promise((res) => {
          const p = spawn('node', ['--input-type=module', '-e', racer, path, o, String(go)], { encoding: 'utf8' });
          let out = '';
          p.stdout.on('data', (d) => (out += d));
          p.on('close', () => res(out));
        })
    )
  );
}
for (const n of [5, 20])
  test(`N3: ${n} processes, two different steps, a cleared marker standing: at most one takes the day (30 times)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-mark-'));
    for (let rep = 0; rep < 30; rep++) {
      const path = join(dir, `c001-day-${rep}`);
      // Message 2's release was cleared once since it took the day (resets 0): message 2 may take it again, message 3 never.
      writeFileSync(path, 'ev:c001:2:0');
      const owners = Array.from({ length: n }, (_, i) => (i % 2 ? 'ev:c001:3:0' : 'ev:c001:2:1'));
      const got = await race(path, owners);
      const yes = got.map((x, i) => (x === 'Y' ? owners[i] : null)).filter(Boolean);
      assert.ok(yes.length <= 1, `rep ${rep}: ${yes.join(', ')}`);
      assert.deepEqual(yes, ['ev:c001:2:1'], `rep ${rep}: the cleared step takes it again`);
    }
  });

test('N4: a symlinked or malformed marker reads as taken, and is never written through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-mark-'));
  const cleared = () => 5;
  const target = join(dir, 'elsewhere');
  writeFileSync(target, 'ev:c001:2:0');
  symlinkSync(target, join(dir, 'link'));
  assert.equal(takeMarker(join(dir, 'link'), 'ev:c001:2:1', cleared), null);
  assert.equal(readFileSync(target, 'utf8'), 'ev:c001:2:0');
  for (const bad of ['', 'garbage', 'ev:c001:2:0\n', 'ev:c001:2', 'EV:c001:2:0', ' ev:c001:2:0']) {
    const p = join(dir, `bad${Math.random().toString(36).slice(2)}`);
    writeFileSync(p, bad);
    assert.equal(takeMarker(p, 'ev:c001:2:1', cleared), null, JSON.stringify(bad));
  }
  // A symlink at the next link in the chain reads as taken too.
  const p = join(dir, 'chain');
  writeFileSync(p, 'ev:c001:2:0');
  symlinkSync(target, `${p}~1`);
  assert.equal(takeMarker(p, 'ev:c001:2:1', cleared), null);
  // A plain cleared marker is taken again by the same step only.
  const q = join(dir, 'plain');
  writeFileSync(q, 'ev:c001:2:0');
  assert.equal(takeMarker(q, 'ev:c001:3:0', cleared), null);
  assert.equal(takeMarker(q, 'ev:c001:2:1', () => 0), null, 'not cleared: taken');
  assert.equal(takeMarker(q, 'ev:c001:2:1', () => 1), `${q}~1`);
  assert.equal(takeMarker(q, 'ev:c001:2:1', () => 1), null, 'once');
});

test('N5: the stage check refuses a follow-up whose earlier step is unsent, a step already staged, and anything after the event', () => {
  const H = ready({ sending: false });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  process.env.FLOORBOSS_HOME = H.HOME;
  const item = (t, now) => ({ id: ana, touch: t, to: 'ana@acme.test', listed_at: now });
  // Message 2 with message 1 unsent (and on a day message 2 would be due): refused.
  assert.match(stageRefusal(H.dir, item(2, D14), Date.parse(D14)) || '', /the message before it hasn't gone/);
  // Message 1 already staged (its receipt saved): refused.
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: NOW, type: 'staged', who: 'user', id: ana, touch: 1, draft_id: 'd1' })}\n`);
  assert.match(stageRefusal(H.dir, item(1, NOW), Date.parse(NOW)) || '', /already in your drafts/);
  // After the event: an unsent first message is refused, at the check and in the list.
  const after = at('2026-11-13');
  assert.match(stageRefusal(H.dir, item(1, after), Date.parse(after)) || '', /the event is over/);
  assert.equal(cli(H, 'event-outreach', ['stage-list', '--event', H.slug], after).to_stage, 0);
});

test('N5: calls at the same moment put one draft per person per step into the drafts (10 calls, 5 times)', async () => {
  const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
  for (let rep = 0; rep < 5; rep++) {
    const H = ready({ sending: false, route: ['email', 'email'] });
    writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { stage_draft: STAGE }, followup_gap: [1] }));
    approveRounds(H);
    const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], NOW);
    const [it] = JSON.parse(readFileSync(sl.file, 'utf8'));
    // (Each call with its own tool_use_id, as Claude Code gives it: a staged draft call with none is refused.)
    const input = (n) => JSON.stringify({ tool_name: 'mcp__gmail__create_draft', tool_input: { to: it.to, subject: it.subject, body: it.body }, session_id: 's1', tool_use_id: `toolu_n5_${rep}_${n}` });
    const one = (_, n) =>
      new Promise((res) => {
        const p = spawn('node', [join(ROOT, 'hooks/guard.mjs')], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW } });
        p.on('close', (code) => res(code));
        p.stdin.end(input(n));
      });
    const codes = await Promise.all(Array.from({ length: 10 }, one));
    assert.equal(codes.filter((c) => c === 0).length, 1, `rep ${rep}: ${codes.join(',')}`);
  }
});

test('N5: a confirmation is not staged after the event, at the check or in the list', () => {
  const H = ready({ sending: false, route: ['email', 'email'] });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 1, date: '2026-10-12', said: 'sent' }], NOW);
  record(H, [{ who: 'Ana Berg', what: 'booked', time: '2026-11-10 10:00', said: 'Tuesday at ten works' }], NOW);
  approveRounds(H);
  process.env.FLOORBOSS_HOME = H.HOME;
  const before = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], NOW);
  assert.ok(JSON.parse(readFileSync(before.file, 'utf8')).some((x) => x.id === ana && x.touch === 0), 'listed before the event');
  const after = at('2026-11-13');
  assert.equal(cli(H, 'event-outreach', ['stage-list', '--event', H.slug], after).to_stage, 0);
  assert.match(stageRefusal(H.dir, { ...itemFor(H, ana, 0, after), listed_at: after }, Date.parse(after)) || '', /the event is over/);
});

test('N5: a later step sent: the earlier one is refused by the guard, the card list and the stage check', () => {
  const H = ready({ sending: true });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  // Message 2 recorded as sent on Mon 12 (by hand), message 1 never went.
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-12', said: 'I sent the second one myself' }], NOW);
  const day = at('2026-10-13');
  const g = hook(H, ana, 1, day);
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /a later message already went/);
  nobody(H, day);
  const l = cli(H, 'event-outreach', ['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], day);
  const listed = existsSync(l.file || '') ? JSON.parse(readFileSync(l.file, 'utf8')) : [];
  assert.ok(!listed.some((x) => x.id === ana && x.touch === 1), JSON.stringify(listed));
  // The outbox page (the card list) shows no message 1 to copy or send.
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], day);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.doesNotMatch(html, new RegExp(`data-id="${ana}" data-touch="1"`));
  process.env.FLOORBOSS_HOME = H.HOME;
  assert.match(stageRefusal(H.dir, { ...itemFor(H, ana, 1, day), listed_at: day }, Date.parse(day)) || '', /a later message already went/);
});

test('N6: the summary does not list a passed-over step as waiting', () => {
  const H = ready({ sending: false });
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  record(H, [{ who: 'Ana Berg', what: 'sent', touch: 2, date: '2026-10-12', said: 'I sent the second one myself' }], NOW);
  const s = cli(H, 'event-outreach', ['summary', '--event', H.slug], at('2026-10-13'));
  assert.ok(!s.ERROR, s.ERROR);
  assert.ok(!(s.in_outbox_to_send || []).some((w) => w.id === ana && w.touch === 1), JSON.stringify(s.in_outbox_to_send));
});

const ODD = [['end_date', '2026-11-12 '], ['end_date', '2026-11-12T00:00:00Z'], ['end_date', 20261112], ['start_date', '12/11/2026'], ['end_date', ''], ['time_zone', ''], ['time_zone', undefined], ['time_zone', 'Mars/Olympus']];
test('N7: an event whose dates can\'t be read: refused at the guard, said on the page and in the summary, never "over" and never thrown', () => {
  const H = ready();
  const ana = idOf(H, 'Ana Berg');
  approveRounds(H);
  const good = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  for (const [k, v] of ODD) {
    const ev = { ...good, [k]: v };
    if (v === undefined) delete ev[k];
    writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
    const label = `${k}=${JSON.stringify(v)}`;
    assert.equal(eventStateAt(H.dir, Date.parse(NOW)).state, 'unreadable', label);
    const g = hook(H, ana, 1, NOW);
    assert.equal(g.status, 2, label);
    assert.match(g.stderr, /can't read this event's dates/, label);
    assert.doesNotMatch(g.stderr, /Invalid time zone|the event is over/, label);
    const sm = cli(H, 'event-outreach', ['summary', '--event', H.slug], NOW);
    assert.ok(!sm.ERROR, `${label}: ${sm.ERROR}`);
    assert.match(sm.note, /can't read this event's dates/, label);
    for (const cmd of [['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], ['todo', '--event', H.slug], ['task-list', '--event', H.slug]]) {
      const r = cli(H, 'event-outreach', cmd, NOW);
      assert.doesNotMatch(r.ERROR || '', /Invalid time zone|Invalid time value/, `${label} ${cmd[0]}`);
    }
    const o = cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], NOW);
    assert.doesNotMatch(o.ERROR || '', /Invalid time zone|Invalid time value/, label);
    if (!o.ERROR) {
      const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
      const card = html.slice(html.indexOf(`data-id="${ana}"`), html.indexOf('</article>', html.indexOf(`data-id="${ana}"`)));
      assert.match(card, /can(?:'|&#39;|&#x27;)t read this event(?:'|&#39;|&#x27;)s dates/, label);
    }
  }
});

test('N7: the one "is the event over" helper: an unreadable file, no date, and the end date (not the start) when both are set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-ev-'));
  const n = Date.parse(NOW);
  assert.equal(eventEnded(dir, n), true, 'no event.json');
  writeFileSync(join(dir, 'event.json'), '{not json');
  assert.equal(eventStateAt(dir, n).why, UNREADABLE_DATES);
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ time_zone: 'UTC' }));
  assert.equal(eventEnded(dir, n), true, 'no date');
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ time_zone: 'UTC', start_date: '2026-10-01', end_date: '2026-10-20' }));
  assert.equal(eventEnded(dir, n), false, 'started, not over: the end date decides');
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ time_zone: 'UTC', start_date: '2026-10-01' }));
  assert.equal(eventEnded(dir, n), true, 'no end date: nothing goes');
  // floorboss's setup always writes both dates, and the guard already refused a follow-up with no end date as
  // "can't read this event's dates": a start-only event is unreadable everywhere (it was "ok" for the readers before,
  // while todo and the gap answer threw on it).
  assert.equal(eventDayState({ time_zone: 'UTC', start_date: '2026-10-12' }, n).state, 'unreadable');
  assert.equal(eventDayState({ time_zone: 'UTC', start_date: '2026-10-12', end_date: null }, n).state, 'unreadable');
  assert.equal(eventDayState({ time_zone: 'UTC', start_date: '2026-10-11', end_date: '2026-10-12' }, n).state, 'ok');
  assert.equal(eventDayState({ time_zone: 'UTC', start_date: '2026-10-10', end_date: '2026-10-11' }, n).state, 'over');
});

test('N10: a send date that isn\'t a date skips the step after it with a note, and nothing throws', () => {
  const { H, ana } = started();
  // A hand-edited ledger line: message 2 sent "13/10/2026".
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: at('2026-10-13'), type: 'sent', who: 'user', id: ana, touch: 2, date: '13/10/2026' })}\n`);
  const r = followupDay({}, { time_zone: 'UTC', start_date: '2026-11-10', end_date: '2026-11-12' }, { prevSent: '13/10/2026', touch: 3, today: '2026-10-14' });
  assert.equal(r.day, null);
  assert.match(noDayWhy(r), /13\/10\/2026/);
  for (const cmd of [['send-list', '--event', H.slug, '--no-reply-check', 'nothing connected; nobody answered'], ['summary', '--event', H.slug], ['todo', '--event', H.slug], ['task-list', '--event', H.slug], ['open', '--event', H.slug, '--no-open']]) {
    const x = cli(H, 'event-outreach', cmd, D14);
    assert.ok(!x.ERROR, `${cmd[0]}: ${x.ERROR}`);
  }
  const g = hook(H, ana, 3, D14);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /13\/10\/2026/);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html, /13\/10\/2026/);
});

test('N8: two weeks in any wording beside a bare number is refused, and a dangling article is refused', () => {
  for (const s of ['a fortnight then 3', 'a couple of weeks, then 2', 'every other week then 1', 'quince días, luego 3', '3, a fortnight', '3 days, a', 'a day, a', 'a, a day'])
    assert.throws(() => parseGap(s), undefined, s);
  for (const [s, v] of [['a fortnight', [14]], ['a couple of weeks', [14]], ['every other week', [14]], ['quince días', [14]], ['a fortnight, then 3 days', [14, 3]], ['a gap of 3 days', [3]]])
    assert.deepEqual(parseGap(s), v, s);
});
