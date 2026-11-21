// The independent behaviour review of the integrated branch (2026-11-17): one test per item and per surviving
// mutant, each failing on the code with its fix taken out, or with the mutant put in (FIX-REPORT.md in the session's
// integrate/fix-sec scratchpad says how each was shown). Through the real CLIs, launcher and guard in throwaway homes;
// nothing here starts Claude Code, launchctl or a real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, mkdtempSync, existsSync, renameSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { world, clone, ticket, start, readMail, stageItem, stage, ledgerOf, ANA, ROOT } from './fixtures/unattended-world.mjs';
import { setup, cli, idOf, todoJobs, NOW } from './fixtures/harness.mjs';
import { draftFor } from './sims/lib/driver.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { followupDueDay } from '../lib/sendcheck.mjs';
import { withLock } from '../lib/lock.mjs';

const BASE = world();
function inHome(H, fn, now) {
  const was = [process.env.FLOORBOSS_HOME, process.env.FLOORBOSS_NOW];
  process.env.FLOORBOSS_HOME = H.HOME;
  if (now) process.env.FLOORBOSS_NOW = now;
  try {
    return fn();
  } finally {
    if (was[0] === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = was[0];
    if (was[1] === undefined) delete process.env.FLOORBOSS_NOW;
    else process.env.FLOORBOSS_NOW = was[1];
  }
}
// A second event in the same home with Ana on its list; lines: more of its ledger.
function second(H, lines = []) {
  const ev2 = join(H.HOME, 'events', 'ev2');
  mkdirSync(ev2, { recursive: true });
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  writeFileSync(join(ev2, 'event.json'), JSON.stringify({ ...ev, slug: 'ev2', name: 'Other Expo' }));
  const all = [{ at: '2026-09-01T00:00:00Z', type: 'person', who: 'floorboss', id: 'c001', name: 'Ana Berg', company: 'Acme', email: ANA, keys: [] }, ...lines];
  writeFileSync(join(ev2, 'ledger.jsonl'), all.map((e) => `${JSON.stringify(e)}\n`).join(''));
}
const released = (at) => ({ at, type: 'send_released', who: 'guard', id: 'c001', touch: 1, via: 'email.send', to: ANA });

// ---------- F1: the morning page and the launcher ----------
// Follow-up 1 went on LinkedIn Tue 13; follow-up 2 (email, authorised) is due Wed 14. The brief runs at 05:00Z.
function brief(H) {
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-13T08:00:00Z', type: 'sent', who: 'user', id: H.ana, touch: 2, date: '2026-10-13', via: 'user', channel: 'LinkedIn', source: 'user', said: 'sent it on LinkedIn' })}\n`);
  const opener = join(H.HOME, 'opener.sh');
  writeFileSync(opener, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/scheduled.mjs'), 'brief'], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: '2026-10-14T05:00:00Z', FLOORBOSS_TEST: '1', FLOORBOSS_OPENER: opener }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return existsSync(join(H.HOME, 'today.html')) ? readFileSync(join(H.HOME, 'today.html'), 'utf8') : '';
}
test('B-F1: the morning page names only people the launcher puts on a ticket that day', () => {
  // Control: nothing at another event. She is named, and the launcher has her at 08:00.
  const H0 = clone(BASE);
  const page0 = brief(H0);
  assert.match(page0, /Follow-ups going into your drafts on their own/);
  assert.match(page0, /Ana Berg \(LinkedIn\)/);
  assert.deepEqual(inHome(H0, () => followupsDue(Date.parse('2026-10-14T08:00:00Z')).items.map((x) => [x.id, x.touch]), '2026-10-14T08:00:00Z'), [['c001', 3]]);
  // Another event let a send to her through at 04:30Z: the launcher waits on her, and the page doesn't name her.
  const H = clone(BASE);
  second(H, [released('2026-10-14T04:30:00Z')]);
  const page = brief(H);
  assert.doesNotMatch(page, /Ana Berg/);
  assert.deepEqual(inHome(H, () => followupsDue(Date.parse('2026-10-14T08:00:00Z')).items, '2026-10-14T08:00:00Z'), []);
});

// ---------- F2: waiting means waiting for you ----------
test('B-F2: a follow-up held by a message to them today says it waits for you, never "for another day"', () => {
  const H = clone(BASE);
  second(H, [released('2026-10-13T06:30:00Z')]);
  const d = inHome(H, () => followupsDue(Date.parse('2026-10-13T09:00:00Z')), '2026-10-13T09:00:00Z');
  const why = d.waiting.map((w) => w.why).join(' | ');
  assert.match(why, /another message to Ana Berg \(ana@acme\.test\) already went or is going today, for ev2\. One message a day to one person, across all your events, so it waits for you/);
  assert.doesNotMatch(why, /another day/);
  // The next day it is held for you, as said.
  const d2 = inHome(H, () => followupsDue(Date.parse('2026-10-14T09:00:00Z')), '2026-10-14T09:00:00Z');
  assert.deepEqual(d2.items, []);
  assert.match(d2.held.map((w) => w.why).join(' | '), /at your event ev2, a message to them went or is going/);
  // The same rule at this event.
  const src = readFileSync(join(ROOT, 'scripts/scheduled.mjs'), 'utf8');
  assert.doesNotMatch(src, /so it waits for another day/);
});

// ---------- F3, F4: two events sharing a person on one day ----------
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const STAGE = { server: 'gmail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const PEOPLE = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana\n';
function ready({ event = {}, home = null } = {}) {
  const H = setup({ attendees: PEOPLE, event, home, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE, stage_draft: STAGE }, followup_gap: [1] }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  return H;
}
function approveRounds(H, now = NOW) {
  for (let i = 0; i < 6; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => x.kind === 'message' && !x.waits_for_previous)) {
      const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: d.subject || 'Test Expo', body: d.body, brief: 'x, no research profile', ...(d.structure ? { structure: d.structure, fact_source: d.fact_source } : {}), ...(d.insight ? { insight: d.insight } : {}) })], now);
      cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
const nobody = (H, now) => cli(H, 'event-outreach', ['status', '--event', H.slug, '--none', '--said', 'nobody replied'], now);
test('B-F3, B-F4: an approved first message held by the other event is listed as waiting; the summary marks only what is due today "not today"', () => {
  const HOME = mkdtempSync(join(tmpdir(), 'fb-rib-'));
  const A = ready({ home: HOME });
  const ana = idOf(A, 'Ana Berg');
  approveRounds(A);
  const B = ready({ home: HOME, event: { slug: 'ev2', name: 'Other Expo' } });
  cli(B, 'crm-triage', ['gate', '--event', B.slug, '--answers', `reach ${ana} because she asked about both shows`]);
  approveRounds(B);
  const t9 = '2026-10-12T09:00:00Z';
  nobody(A, t9);
  // F4: A's message 1 isn't listed (she is in touch through B): it is in waiting with its reason, never gone unsaid.
  const sl = cli(A, 'event-outreach', ['send-list', '--event', A.slug], t9);
  assert.equal(JSON.parse(readFileSync(sl.file, 'utf8')).filter((x) => x.id === ana).length, 0);
  const w1 = (sl.waiting || []).find((w) => w.id === ana && w.touch === 1);
  assert.ok(w1, `message 1 is said: ${JSON.stringify(sl.waiting)}`);
  assert.match(w1.why, /^not sent: already in touch/);
  // F3: A lets message 1 through under its warm reason; B's summary marks only B's message 1 (due today) not today.
  cli(A, 'crm-triage', ['gate', '--event', A.slug, '--answers', `warm ${ana} because we met at Other Expo`], t9);
  nobody(A, t9);
  const sl2 = cli(A, 'event-outreach', ['send-list', '--event', A.slug], t9);
  const it = JSON.parse(readFileSync(sl2.file, 'utf8')).find((x) => x.id === ana);
  assert.ok(it, 'listed after warm');
  const g = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: { to: it.to, subject: it.subject, body: it.body }, tool_use_id: 'tu-a1' }), env: { ...process.env, FLOORBOSS_HOME: A.HOME, FLOORBOSS_NOW: t9 }, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const rf = join(A.dir, 'r1.json');
  writeFileSync(rf, JSON.stringify({ sends: [{ id: ana, touch: 1, message_id: 'm1' }] }));
  cli(A, 'event-outreach', ['sent', '--event', A.slug, '--receipts-file', rf], t9);
  const t10 = '2026-10-12T10:00:00Z';
  nobody(B, t10);
  const sm = cli(B, 'event-outreach', ['summary', '--event', B.slug], t10);
  const mine = (sm.in_outbox_to_send || []).filter((w) => w.id === ana);
  assert.match(mine.find((w) => w.touch === 1)?.not_today || '', /another message to Ana Berg \(ana@acme\.test\) already went or is going today, for ev/);
  assert.ok(mine.some((w) => w.touch === 2), JSON.stringify(mine));
  for (const w of mine.filter((x) => x.touch > 1)) assert.equal(w.not_today, undefined, `touch ${w.touch} isn't due today: ${JSON.stringify(w)}`);
});

// ---------- F5, M03: what an outbox card offers ----------
const card = (extra) => ({ id: 'c001', touch: 2, name: 'Ana', title: 'COO', company: 'Acme', kind: 'message', channel: 'email', address: ANA, subject: 'Re: Test Expo', body: 'Hi Ana', slots: [], earliest: '', ...extra });
const render = (extra) => renderOutbox({ event: { name: 'Test' }, cards: [card(extra)], slots: [], counts: {} });
test('B-F5: a follow-up already in your drafts folder offers no Copy, and says to send it from there', () => {
  assert.match(render({}), /data-copy="c001-t2-body"/, 'control: an approved email offers Copy');
  for (const [extra, own] of [[{ staged: true }, ''], [{ staged: true, staged_unattended: true }, ', put there on its own']]) {
    const html = render(extra);
    assert.doesNotMatch(html, /data-copy=/, JSON.stringify(extra));
    assert.ok(html.includes(`It is in your mailbox drafts${own}: send it from your drafts folder, not a copy of it.`), JSON.stringify(extra));
  }
});
test('M03: a LinkedIn message floorboss let through, which may have gone, is never in the LinkedIn queue', () => {
  const li = { channel: 'paste', profile_url: 'https://www.linkedin.com/in/ana', address: undefined };
  assert.match(render(li), /data-li="1"/, 'control: a LinkedIn step is in the queue');
  assert.doesNotMatch(render({ ...li, may_have_gone: 'yes' }), /data-li="1"/);
});

// ---------- M04, M05: the card of a draft an unattended run let through ----------
test('M04, M05: a follow-up an unattended run let into the drafts (no receipt yet) is shown as in your drafts, put there on its own', async () => {
  const H = clone(BASE);
  const t = await ticket(H);
  assert.equal(start(H, t).code, 0);
  assert.equal(readMail(H, t).pre.decision, 'allow');
  assert.equal(stage(H, t, stageItem(H, t), { post: false }).pre.decision, 'allow');
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_released') && !ledgerOf(H).some((e) => e.type === 'staged'));
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--no-open'], H.now);
  const html = readFileSync(join(H.dir, 'outbox.html'), 'utf8');
  assert.match(html, /<span class="chip">in your mailbox drafts, put there on its own<\/span>/);
  assert.doesNotMatch(html, /data-copy="c001-t2-body"/);
});

// ---------- M06: the unattended stage list stages follow-ups only ----------
test('M06: with email sending on, the unattended stage list never lists a first message', async () => {
  const H = clone(BASE);
  // Message 1 recorded as not sent after all: approved, unsent, on email.
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-13T07:00:00Z', type: 'sent_undone', who: 'user', id: H.ana, touch: 1 })}\n`);
  const t = await ticket(H, { items: [{ event: H.slug, id: H.ana, touch: 2 }] });
  const was = process.env.FLOORBOSS_UNATTENDED;
  process.env.FLOORBOSS_UNATTENDED = t.token;
  let sl;
  try {
    sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug, '--unattended'], H.now);
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_UNATTENDED;
    else process.env.FLOORBOSS_UNATTENDED = was;
  }
  assert.ok(sl.file, JSON.stringify(sl));
  const list = JSON.parse(readFileSync(sl.file, 'utf8'));
  assert.deepEqual(list.filter((x) => x.touch === 1), [], JSON.stringify(list));
});

// ---------- M10: a follow-up whose draft has a receipt is sent from the drafts folder ----------
test('M10: a follow-up whose draft has a receipt (no unattended release) is not sent by floorboss: it goes from your drafts', () => {
  const H = clone(BASE);
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-13T07:00:00Z', type: 'staged', who: 'floorboss', id: H.ana, touch: 2, draft_id: 'd9' })}\n`);
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: H.now, type: 'reply_checked', id: H.ana, source: 'mailbox', who: 'mailbox' })}\n`);
  const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug], H.now);
  assert.equal(JSON.parse(readFileSync(sl.file, 'utf8')).filter((x) => x.id === H.ana && x.touch === 2).length, 0, JSON.stringify(sl));
  assert.match(JSON.stringify(sl.waiting || []), /its draft is already in your drafts folder: send it from there/);
});

// ---------- M11: an event whose dates can't be read says so ----------
test('M11: a follow-up at an event whose zone can\'t be read has no day, and says the dates can\'t be read', () => {
  const d = mkdtempSync(join(tmpdir(), 'fb-m11-'));
  writeFileSync(join(d, 'event.json'), JSON.stringify({ slug: 'ev', name: 'X', time_zone: 'Mars/Base', start_date: '2026-11-10', end_date: '2026-11-12' }));
  const r = followupDueDay(d, { followup_gap: [1, 2], touches: 3 }, [], { sent: { 1: '2026-11-09' } }, { id: 'c001', touch: 2 }, Date.parse('2026-11-11T09:00:00Z'));
  assert.equal(r.day, undefined);
  assert.match(r.why || '', /can't read this event's dates/);
});

// ---------- M12: a lock's beat never touches a lock that isn't this call's ----------
test('M12: once this call\'s lock was broken and another call took it, beat() leaves the new lock\'s time alone', () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-m12-'));
  const was = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H;
  try {
    withLock('beat-test', ({ owned, beat }) => {
      const lock = join(H, 'beat-test.lock');
      // Broken as stale under it, and a new lock taken by another process.
      renameSync(lock, `${lock}.stale-000000000000`);
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '999999');
      const old = new Date(Date.now() - 3600 * 1000);
      utimesSync(lock, old, old);
      assert.equal(owned(), false);
      beat();
      assert.ok(Math.abs(statSync(lock).mtimeMs - old.getTime()) < 1000, "the other call's lock keeps its time");
    });
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = was;
  }
});

// ---------- F6: the CRM-owner say-back is word for word ----------
test('B-F6: the CRM owner answer is said back word for word, as the Save line has it', () => {
  const crm = 'First Name,Last Name,Email,Company,Deal Owner,Stage,Last Activity Date,Email Opt Out\nLucas,Visser,lucas.visser@koelhuis.example,Koelhuis,"Pat Doe",Opportunity,10/02/2026,No\nFemke,Bakker,femke.bakker@vrachtlijn.example,Vrachtlijn,"Lee Roe",Opportunity,10/02/2026,No\n';
  const H = setup({ attendees: 'Name,Title,Company,Email\nLucas Visser,COO,Koelhuis,lucas.visser@koelhuis.example\nFemke Bakker,COO,Vrachtlijn,femke.bakker@vrachtlijn.example\n', crm });
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  delete ev.settings.crm_user_name;
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify(ev));
  cli(H, 'crm-triage', ['load', '--event', H.slug]);
  const f = join(H.dir, 'crm_name.txt');
  writeFileSync(f, 'sam.lee@lanecraft-ai.test');
  const r = JSON.parse(execFileSync('node', [join(ROOT, 'skills/flow/scripts/cli.mjs'), 'answer', '--event', H.slug, '--ask', 'crm_name', '--value-file', f], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(r.say_to_user.includes('You said: "sam.lee@lanecraft-ai.test".'), r.say_to_user);
  assert.ok(r.say_to_user.includes('Save "sam.lee@lanecraft-ai.test" as you in the CRM? (yes or no)'), r.say_to_user);
});
