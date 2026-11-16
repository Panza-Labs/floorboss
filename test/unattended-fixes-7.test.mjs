// The seventh round of the unattended email drafts review (verify3, fix round 5, 2026-11-15): one test per item, each
// failing on the code with its fix taken out (FIX-REPORT.md in the session's unattended-fix5 scratchpad says how each
// was shown). Through the real guard, flow, launcher and the gmail-real stand-in (over MCP stdio) in throwaway homes;
// nothing here starts Claude Code, launchctl or a real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { world, clone, ticket, start, inRun, afterRun, hook, logOf, ledgerOf, text, bashCall, scriptCmd, gcall, G, OWN, ANA, D13, ROOT } from './fixtures/unattended-world.mjs';
import { cli } from './fixtures/harness.mjs';
import { mailFromWitness, mailWitness } from '../hooks/guard/witness.mjs';
import { approvalHash } from '../lib/sendcheck.mjs';
import { attendedDraftIn } from '../lib/unattended-drafts.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';

const GBASE = world({ gmail: true });
const tool = (n) => `mcp__${G}__${n}`;
const fill = (args, values) => JSON.parse(JSON.stringify(args).replace(/\{([a-z_]+)\}/g, (m, k) => values[k] ?? m));
const flat = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\n\s*(>\s*)?/g, ' ').replace(/\s+/g, ' ');
function inHome(H, fn) {
  const was = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = H.HOME;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = was;
  }
}
function next(H, t, now = H.now) {
  const was = process.env.FLOORBOSS_UNATTENDED;
  process.env.FLOORBOSS_UNATTENDED = t.token;
  try {
    return cli(H, 'flow', ['next', '--unattended'], now);
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_UNATTENDED;
    else process.env.FLOORBOSS_UNATTENDED = was;
  }
}
// A Gmail run as its model makes it (as in unattended-fixes-6). answer(tool, args, real): the tool_response the guard's
// post hook gets (real: the stand-in's own answer).
async function grun(H, { answer = (n, args, real) => text(real), items = null } = {}) {
  const t = await ticket(H, items ? { items } : {});
  if (!t.items.length) return { t, empty: true };
  assert.equal(start(H, t).code, 0);
  for (let i = 0; i < 8; i++) {
    const n = next(H, t);
    if (n.step === 'read_mail' || n.step === 'read_mail_from') {
      const args = fill(n.call.recipe.args, n.call.values);
      const pre = inRun(H, t, tool(n.call.recipe.tool), args, { id: `r${i}` });
      if (pre.decision !== 'allow') return { t, refused: pre };
      afterRun(H, t, tool(n.call.recipe.tool), args, answer(n.call.recipe.tool, args, gcall(H, n.call.recipe.tool, args)), { id: `r${i}` });
    } else if (n.step === 'stage_one') {
      const it = n.call.item;
      const args = { to: [it.to], subject: it.subject, body: it.body, replyToMessageId: it.reply_to_message_id };
      const pre = inRun(H, t, tool('create_draft'), args, { id: `s${i}` });
      if (pre.decision !== 'allow') return { t, refused: pre };
      afterRun(H, t, tool('create_draft'), args, text(gcall(H, 'create_draft', args)), { id: `s${i}` });
      return { t, allowed: true };
    } else return { t, last: n };
  }
  return { t };
}
const releases = (H, touch = 2) => ledgerOf(H).filter((e) => e.type === 'stage_released' && e.touch === touch);
const heldWhy = (H) => logOf(H).filter((e) => e.type === 'held').map((e) => e.why).join(' | ');

// The search's start in the Gmail world: 15 minutes before the guard let message 1 through (12 Oct 08:00Z).
const SO = { own: [OWN], contact: ANA, sinceMs: Date.parse('2026-10-12T07:45:00Z'), ownId: 'm1', ownThread: 'T1' };
const msg = (id, sender, date, to = [ANA], labels = ['SENT']) => ({ id, sender, toRecipients: to, ccRecipients: [], bccRecipients: [], date, labelIds: labels });
const th = (id, messages, count = messages.length) => ({ id, messageCount: count, messages });
const M1 = msg('m1', OWN, '2026-10-12T08:00:00Z');
// A reply from Ana whose date text reads 15 minutes before the search's start (it matched after: because it came in since).
const SKEW = msg('sk1', `Ana <${ANA}>`, '2026-10-12T07:30:00Z', [OWN], ['INBOX']);
const FROM_THEM = /your mailbox shows 1 conversation with something from them since your last message/;

test('F6-S2-1: a message from them in any other conversation the search matched holds, whatever its date and whatever else it shows', () => {
  const later = {
    'your email to someone else dated later': msg('f1', OWN, '2026-10-12T15:00:00Z', ['lee@lanecraft.example']),
    'your draft to them dated later': msg('d1', OWN, '2026-10-12T15:00:00Z', [ANA], ['DRAFT']),
    'nothing else': null
  };
  for (const [label, other] of Object.entries(later)) {
    for (const reply of [SKEW, { ...SKEW, id: 'sk2', labelIds: ['SPAM'] }, { ...SKEW, id: 'sk3', date: '2026-09-01T10:00:00Z' }]) {
      const w = mailFromWitness(text({ threads: [th('T1', [M1]), th('T2', other ? [reply, other] : [reply])] }), SO);
      assert.equal(w.readable, true, `${label}: ${JSON.stringify(w)}`);
      assert.equal(w.inbound, 1, `${label} ${reply.id}: ${JSON.stringify(w)}`);
    }
  }
  // Someone else's message dated before the start, in another conversation the search matched, holds too.
  const bo = mailFromWitness(text({ threads: [th('T1', [M1]), th('T3', [msg('b1', 'bo@acme.test', '2026-10-01T10:00:00Z', [ANA, OWN], ['INBOX'])])] }), SO);
  assert.equal(bo.others, 1, JSON.stringify(bo));
  // A message counts in the conversation the answer lists it under: its own threadId naming your thread never moves it.
  const moved = mailFromWitness(text({ threads: [th('T1', [M1]), th('T2', [{ ...SKEW, threadId: 'T1' }])] }), SO);
  assert.equal(moved.inbound, 1, JSON.stringify(moved));
  // Your own thread: only what is dated since the start counts (get_thread reads it whole).
  const own = mailFromWitness(text({ threads: [th('T1', [msg('o1', `Ana <${ANA}>`, '2026-10-01T10:00:00Z', [OWN], ['INBOX']), M1])] }), SO);
  assert.equal(own.readable, true, JSON.stringify(own));
  assert.equal(own.inbound, 0, JSON.stringify(own));
  // Another conversation that shows none of its messages can't be read.
  const empty = mailFromWitness(text({ threads: [th('T1', [M1]), th('T9', [], 0)] }), SO);
  assert.equal(empty.readable, false, JSON.stringify(empty));
});

test('F6-S2-1 e2e: the guard holds a reply from them in a new conversation beside a later forward or draft of yours', async () => {
  for (const other of [msg('f1', OWN, '2026-10-12T15:00:00Z', ['lee@lanecraft.example']), msg('d1', OWN, '2026-10-12T15:00:00Z', [ANA], ['DRAFT'])]) {
    const H = clone(GBASE);
    const r = await grun(H, { answer: (n, args, real) => text(n === 'search_threads' ? { threads: [...real.threads, th('T2', [SKEW, other])] } : real) });
    assert.ok(!r.allowed, `the draft went in beside ${other.id}`);
    assert.equal(releases(H).length, 0);
    assert.match(heldWhy(H), FROM_THEM);
  }
});

// A new text of follow-up 1, the critic and the approval, written as unattended-fixes-6 writes them.
function newText(H, at) {
  const old = ledgerOf(H).filter((e) => e.type === 'approved' && e.touch === 2).pop();
  const d = JSON.parse(readFileSync(join(H.dir, 'drafts', `${old.hash}.json`), 'utf8'));
  const nd = { ...d, body: d.body.replace(/\.(\s|$)/, ', really.$1') };
  const hash = approvalHash(nd, old.to);
  assert.notEqual(hash, old.hash);
  writeFileSync(join(H.dir, 'drafts', `${hash}.json`), JSON.stringify(nd));
  const wc = join(H.dir, 'work', 'drafts', `${H.ana}-t2.json`);
  if (existsSync(wc)) writeFileSync(wc, JSON.stringify({ ...JSON.parse(readFileSync(wc, 'utf8')), body: nd.body }));
  for (const e of [
    { type: 'drafted', who: 'floorboss', id: H.ana, touch: 2, kind: 'message', hash, checks: [], planned_due: '2026-10-13', planned_gap: '1' },
    { type: 'critic', who: 'floorboss', id: H.ana, touch: 2, hash, verdict: 'PASS', reasons: [] },
    { type: 'approved', who: 'user', id: H.ana, touch: 2, hash, to: old.to, via: 'email.send', said: 'approve all' }
  ])
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at, ...e })}\n`);
  return hash;
}
const UNSURE = /a draft of this same follow-up was tried in a session with you there and floorboss has no receipt for it, so it may or may not be in your drafts folder/;
const BATCH = 'a'.repeat(24);
// The marks the guard's own hooks write for an attended draft of follow-up 1 (hooks/guard/after-call.mjs): the batch's
// went-in mark, the call mark's .done, or its .failed.
const MARKS = {
  'went in': (H) => [`stage-${H.ana}-2-${BATCH}`],
  'call ran': (H) => [`stage-call-${H.ana}-2-${BATCH}-1`, `stage-call-${H.ana}-2-${BATCH}-1.done`],
  'call failed': (H) => [`stage-call-${H.ana}-2-${BATCH}-1`, `stage-call-${H.ana}-2-${BATCH}-1.failed`]
};

test('F6-S2-2: an attended draft of an older text with no receipt holds the new text until a receipt or your word', async () => {
  for (const [label, names] of Object.entries(MARKS)) {
    const H = clone(GBASE);
    H.now = '2026-10-12T12:00:00Z';
    mkdirSync(join(H.dir, 'released'), { recursive: true });
    // The attended draft, of the text approved then, at 09:00; the new text is approved at 12:00.
    for (const f of names(H)) writeFileSync(join(H.dir, 'released', f), '2026-10-12T09:00:00.000Z');
    const hash = newText(H, '2026-10-12T12:00:00Z');
    const au = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug), { now: '2026-10-12T12:05:00Z', session: 's-att2' });
    assert.equal(au.pre.decision, 'ask', au.pre.stderr);
    hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att2' }, { now: '2026-10-12T12:06:00Z' });
    H.now = D13;
    // The launcher holds it with the plain reason.
    const due = inHome(H, () => followupsDue(Date.parse(D13), []));
    assert.deepEqual(due.items, [], label);
    assert.match(due.held.map((x) => x.why).join(' '), UNSURE, label);
    // A ticket made anyway (the launcher's list in a copy of the home with no marks) is held by the guard.
    const H0 = clone(H);
    for (const f of names(H)) unlinkSync(join(H0.dir, 'released', f));
    const forced = (await ticket(H0, { now: D13 })).items;
    assert.deepEqual(forced.map((x) => `${x.id}:${x.touch}:${x.hash}`), [`${H.ana}:2:${hash}`], label);
    const b = await grun(H, { items: forced });
    assert.ok(!b.allowed, `${label}: a second draft of follow-up 1 went in`);
    assert.equal(releases(H).length, 0, label);
    assert.match(heldWhy(H), UNSURE, label);
    // You say it isn't there (draft-missing): it can go in.
    const dm = bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts'), { session: 's-att4', now: D13 });
    assert.equal(dm.pre.decision, 'ask', `${label}: ${dm.pre.stderr || dm.pre.reason}`);
    assert.match(dm.pre.reason, /In a session with you there, a draft of it was tried \(for its text now or an earlier one\), and floorboss has no receipt for it\./, label);
    assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.id === H.ana && e.touch === 2), `${label}: ${String(dm.stdout).slice(0, 300)}`);
    hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att4' }, { now: D13 });
    const again = inHome(H, () => followupsDue(Date.parse(D13), [])).items;
    assert.deepEqual(again.map((x) => `${x.id}:${x.touch}`), [`${H.ana}:2`], label);
    H.now = '2026-10-13T09:00:00Z';
    const c = await grun(H, { items: again });
    assert.ok(c.allowed, `${label}: ${JSON.stringify(c.refused?.stderr || c.last || heldWhy(H)).slice(0, 400)}`);
    assert.equal(releases(H).length, 1, label);
    assert.equal(releases(H)[0].hash, hash, label);
  }
});

test('F6-S2-2b: attendedDraftIn is keyed by person and step, and a receipt or your word after the mark clears it', () => {
  const ev = mkdtempSync(join(tmpdir(), 'fb-att-'));
  mkdirSync(join(ev, 'released'));
  writeFileSync(join(ev, 'released', `stage-call-c001-2-${BATCH}-1.failed`), '2026-10-12T09:00:00.000Z');
  const L = (type, at, extra = {}) => ({ at, type, id: 'c001', touch: 2, ...extra });
  assert.match(attendedDraftIn(ev, 'c001', 2, [])?.why || '', UNSURE);
  // Whatever text it was for: a later approval doesn't clear it.
  assert.ok(attendedDraftIn(ev, 'c001', 2, [L('drafted', '2026-10-12T12:00:00Z', { hash: 'B' }), L('approved', '2026-10-12T12:00:00Z', { hash: 'B' })]));
  assert.equal(attendedDraftIn(ev, 'c001', 2, [L('staged', '2026-10-12T10:00:00Z', { draft_id: 'd1' })]), null);
  assert.equal(attendedDraftIn(ev, 'c001', 2, [L('stage_cleared', '2026-10-12T10:00:00Z')]), null);
  // A receipt from before the mark, or one for another step or person, doesn't.
  assert.ok(attendedDraftIn(ev, 'c001', 2, [L('staged', '2026-10-12T08:00:00Z', { draft_id: 'd0' })]));
  assert.ok(attendedDraftIn(ev, 'c001', 2, [{ ...L('staged', '2026-10-12T10:00:00Z'), touch: 3 }, { ...L('stage_cleared', '2026-10-12T10:00:00Z'), id: 'c002' }]));
  assert.equal(attendedDraftIn(ev, 'c001', 3, []), null);
  assert.equal(attendedDraftIn(ev, 'c002', 2, []), null);
});

test('F6-docs: the search is said as every folder but Spam, as SECURITY.md says it; your word gives the step its day back', () => {
  const SENT = /searches every folder but Spam, which Gmail leaves out, and floorboss can only show that the search covered your own last email and the time since, not that it matched mail from them/i;
  for (const f of ['README.md', 'CHANGELOG.md', 'commands/unattended.md']) {
    assert.match(flat(f), SENT, f);
    assert.doesNotMatch(flat(f), /Spam and Trash|search in every folder|searches every folder for/, f);
  }
  const sec = flat('SECURITY.md');
  assert.doesNotMatch(sec, /search in every folder|searched Spam and Trash|Gmail's own search does both/);
  assert.match(sec, /a search of every folder but Spam for anything from them or to them/);
  assert.match(sec, /Its own description says `in:anywhere` covers Trash but leaves out Spam/);
  assert.match(sec, /`resultCountEstimate`, never read\), such as `omittedContent`/);
  assert.match(sec, /Gmail's message count includes a thread's drafts, which it never shows/);
  assert.match(sec, /every message from them or from anyone else but you holds the draft, whatever its date says/);
  assert.doesNotMatch(sec, /one that shows only older dates matched on a message/);
  assert.match(sec, /holds that step's unattended draft as "may or may not be in your drafts", in the launcher and the guard, whatever text it was for/);
  // V-R2-3 (owner's call, kept): after your word the step's next draft may go in the same day, and SECURITY.md says so.
  assert.match(sec, /gives that step its day back, so its next draft can go in the same day as the one you said isn't there/);
  const sr = flat('examples/standins/README.md');
  assert.match(sr, /answers as real calls to the claude\.ai Gmail connector answered \(15 November 2026\)/);
});

// ---------- the real claude.ai Gmail connector's answers (scratchpad gmail-real-shapes-2026-11-15.md) ----------
// The answers as the real connector gave them, with the addresses as this world's.
const REAL_MSG = (o = {}) => ({
  addressDisplayNames: [{ displayName: 'Owen', emailAddress: OWN }],
  date: '2026-10-12T08:00:00Z',
  historyId: '28133',
  id: 'm1',
  internalDate: String(Date.parse('2026-10-12T08:00:00Z')),
  labelIds: ['SENT'],
  sender: OWN,
  sizeEstimate: 903,
  threadId: 'T1',
  toRecipients: [ANA],
  viewUrl: 'https://mail.google.com/x',
  ...o
});
const REAL_THREAD = (messages, count = messages.length) => ({ id: 'T1', messageCount: count, messages, viewUrl: 'https://mail.google.com/x' });

test('F6-G1: a search answer with Gmail\'s resultCountEstimate reads clean; omittedContent or any other key beside it holds', () => {
  const ok = mailFromWitness(text({ resultCountEstimate: '1', threads: [REAL_THREAD([REAL_MSG()])] }), SO);
  assert.deepEqual([ok.readable, ok.found_by, ok.inbound, ok.others, ok.own_after], [true, 'id', 0, 0, 0], JSON.stringify(ok));
  // Its value is never read: a wrong guess changes nothing.
  for (const v of ['0', '201', 7]) assert.equal(mailFromWitness(text({ resultCountEstimate: v, threads: [REAL_THREAD([REAL_MSG()])] }), SO).readable, true, String(v));
  for (const extra of [{ omittedContent: true }, { omittedContent: 'filtered' }, { resultCountEstimate: { n: 1 } }, { resultCountEstimate: null }, { resultSizeEstimate: 1 }, { nextPage: 'x' }]) {
    const w = mailFromWitness(text({ resultCountEstimate: '1', threads: [REAL_THREAD([REAL_MSG()])], ...extra }), SO);
    assert.equal(w.readable, false, `${JSON.stringify(extra)}: ${JSON.stringify(w)}`);
  }
  // The stand-in answers as the real connector did.
  const H = clone(GBASE);
  const real = gcall(H, 'search_threads', { query: `in:anywhere {from:${ANA} to:${ANA}} after:${Math.floor(Date.parse('2026-10-12T07:45:00Z') / 1000)}`, pageSize: 50 });
  assert.deepEqual(Object.keys(real), ['resultCountEstimate', 'threads']);
  assert.equal(real.resultCountEstimate, '1');
  assert.deepEqual(Object.keys(real.threads[0]), ['id', 'messageCount', 'messages', 'viewUrl']);
  assert.deepEqual(Object.keys(real.threads[0].messages[0]), ['addressDisplayNames', 'date', 'historyId', 'id', 'internalDate', 'labelIds', 'sender', 'sizeEstimate', 'threadId', 'toRecipients', 'viewUrl']);
  assert.equal(real.threads[0].messages[0].sender, OWN);
  assert.match(real.threads[0].messages[0].date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(real.threads[0].messages[0].internalDate, /^\d{13}$/);
});

test('F6-G1 e2e: a whole run over the stand-in\'s real search answer puts the draft in', async () => {
  const H = clone(GBASE);
  const seen = [];
  const r = await grun(H, { answer: (n, args, real) => (seen.push(Object.keys(real).join(',')), text(real)) });
  assert.ok(r.allowed, JSON.stringify(r.refused?.stderr || r.last || heldWhy(H)).slice(0, 400));
  assert.ok(seen.includes('resultCountEstimate,threads'), seen.join(' | '));
  assert.equal(releases(H).length, 1);
});

test('F6-G2: messageCount counts drafts: no hold in your own thread or the thread read; another conversation with more than it shows holds', () => {
  // get_thread with a draft in it: messageCount 2, one message.
  const g = mailWitness(text(REAL_THREAD([REAL_MSG()], 2)), { own: [OWN], sinceMs: Date.parse('2026-10-11T00:00:00Z'), thread: true });
  assert.deepEqual([g.readable, g.inbound, g.own_ids], [true, 0, ['m1']], JSON.stringify(g));
  // A count below what it shows, or not a whole number, isn't an answer floorboss can read.
  for (const c of [0, '2', 1.5, -1]) assert.equal(mailWitness(text(REAL_THREAD([REAL_MSG()], c)), { own: [OWN], sinceMs: Date.parse('2026-10-11T00:00:00Z'), thread: true }).readable, false, String(c));
  // The search: your own thread with a draft in it reads clean.
  const own = mailFromWitness(text({ resultCountEstimate: '1', threads: [REAL_THREAD([REAL_MSG()], 2)] }), SO);
  assert.equal(own.readable, true, JSON.stringify(own));
  // Another conversation with them that counts more than it shows (a draft of yours to them, or a message not shown) holds.
  const other = { id: 'T5', messageCount: 2, messages: [REAL_MSG({ id: 'h5', threadId: 'T5', date: '2026-10-12T12:00:00Z', internalDate: String(Date.parse('2026-10-12T12:00:00Z')), toRecipients: ['bo@acme.test'] })], viewUrl: 'x' };
  const w = mailFromWitness(text({ resultCountEstimate: '2', threads: [REAL_THREAD([REAL_MSG()], 2), other] }), SO);
  assert.equal(w.readable, false, JSON.stringify(w));
  assert.match(w.why, /shows 1 of the 2 messages/);
});

test('F6-G2 e2e: a draft of yours already in the thread (the stand-in counts it) doesn\'t hold the run', async () => {
  const H = clone(GBASE);
  // A draft reply the user made by hand in the thread of message 1: the stand-in's get_thread and search count it.
  gcall(H, 'create_draft', { to: [ANA], subject: 'Re: x', body: 'my own note', replyToMessageId: H.m1.id });
  const th = gcall(H, 'get_thread', { threadId: H.m1.threadId, messageFormat: 'METADATA_ONLY' });
  assert.deepEqual([th.messageCount, th.messages.length], [2, 1]);
  const r = await grun(H);
  assert.ok(r.allowed, JSON.stringify(r.refused?.stderr || r.last || heldWhy(H)).slice(0, 400));
  assert.equal(releases(H).length, 1);
});

test('F6-G3: the draft\'s messageId and threadId from create_draft\'s answer are what floorboss records', async () => {
  const H = clone(GBASE);
  const r = await grun(H);
  assert.ok(r.allowed, JSON.stringify(r.refused?.stderr || r.last || heldWhy(H)).slice(0, 400));
  const drafts = JSON.parse(readFileSync(join(H.HOME, 'standin.json.drafts.json'), 'utf8'));
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].id, /^r\d{19}$/);
  const staged = ledgerOf(H).find((e) => e.type === 'staged' && e.touch === 2);
  assert.deepEqual([staged.draft_id, staged.message_id, staged.thread_id], [drafts[0].id, drafts[0].message_id, H.m1.threadId]);
  assert.notEqual(staged.message_id, staged.draft_id);
});

test('F6-G4: what the real calls confirmed: send_message\'s id is its new thread\'s, a bare sender, ISO dates with an internalDate text, delete_draft answers {}', () => {
  // Message 1's answer, as the guard's post hook recorded it.
  assert.deepEqual(Object.keys(GBASE.m1), ['id', 'threadId', 'viewUrl']);
  assert.equal(GBASE.m1.id, GBASE.m1.threadId);
  assert.ok(ledgerOf(GBASE).some((e) => e.type === 'call_result' && e.kind === 'send' && e.message_id === GBASE.m1.id && e.thread_id === GBASE.m1.id));
  // The real get_thread message, read whole: its sender is the bare address and its time is its date's.
  const g = mailWitness(text(REAL_THREAD([REAL_MSG(), REAL_MSG({ id: 'r1', sender: ANA, addressDisplayNames: [{ displayName: 'Ana', emailAddress: ANA }], toRecipients: [OWN], labelIds: ['INBOX'], date: '2026-10-12T15:00:00Z', internalDate: String(Date.parse('2026-10-12T15:00:00Z')) })])), { own: [OWN], sinceMs: Date.parse('2026-10-11T00:00:00Z'), thread: true });
  assert.deepEqual([g.readable, g.inbound, g.inbound_from[0]?.from, g.inbound_from[0]?.at], [true, 1, ANA, '2026-10-12T15:00:00.000Z'], JSON.stringify(g));
  const H = clone(GBASE);
  const d = gcall(H, 'create_draft', { to: [ANA], subject: 'Re: x', body: 'x', replyToMessageId: H.m1.id });
  assert.deepEqual(Object.keys(d), ['id', 'messageId', 'threadId', 'viewUrl']);
  assert.equal(d.threadId, H.m1.threadId);
  assert.deepEqual(gcall(H, 'delete_draft', { draftId: d.id }), {});
  assert.equal(gcall(H, 'get_thread', { threadId: H.m1.threadId, messageFormat: 'METADATA_ONLY' }).messageCount, 1);
});
