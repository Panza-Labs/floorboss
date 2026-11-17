// The sixth round of the unattended email drafts review (verify3, fix round 4, round 2, 2026-11-15): one test per item,
// each failing on the code with its fix taken out (FIX-2.md in the session's unattended-fix4 scratchpad says how each was
// shown). Through the real guard, flow, launcher and the gmail-real stand-in (over MCP stdio) in throwaway homes;
// nothing here starts Claude Code, launchctl or a real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { world, clone, ticket, start, inRun, afterRun, hook, logOf, ledgerOf, text, bashCall, scriptCmd, gcall, gdata, G, OWN, ANA, ROOT } from './fixtures/unattended-world.mjs';
import { cli } from './fixtures/harness.mjs';
import { mailFromWitness, SEARCH_UNPROVEN, YOU_WROTE } from '../hooks/guard/witness.mjs';
import { approvalHash } from '../lib/sendcheck.mjs';
import { olderDraftOf } from '../lib/unattended-drafts.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';

const GBASE = world({ gmail: true });
const D14 = '2026-10-14T08:00:00Z';
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
// A Gmail run as its model makes it (as in unattended-fixes-5). answer(tool, args, real): the tool_response the guard's
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The search's start in the Gmail world: 15 minutes before the guard let message 1 through (12 Oct 08:00Z).
const SO = { own: [OWN], contact: ANA, sinceMs: Date.parse('2026-10-12T07:45:00Z'), ownId: 'm1', ownThread: 'T1' };
const msg = (id, sender, date, to = [ANA], labels = ['SENT']) => ({ id, sender, toRecipients: to, ccRecipients: [], bccRecipients: [], date, labelIds: labels });
const th = (id, messages, count = messages.length) => ({ id, messageCount: count, messages });
const M1 = msg('m1', OWN, '2026-10-12T08:00:00Z');
const HAND = msg('h1', OWN, '2026-10-13T06:00:00Z');
const T_HAND = [{ thread_id: 't-hand', message_id: 'm-hand', to: ANA, subject: 'One more thing', sent_at: '2026-10-12T12:00:00Z' }];

test('F5-NP1a: with message 1\'s id recorded, an email you wrote by hand never stands in for it in the search\'s proof', () => {
  // Message 1 missing, only a later email of yours shown: no proof, the plain hold.
  const w = mailFromWitness(text({ threads: [th('T4', [HAND])] }), SO);
  assert.equal(w.readable, false, JSON.stringify(w));
  assert.equal(w.plain, true);
  assert.equal(w.why, SEARCH_UNPROVEN);
  // Message 1 shown: it is the proof, and your hand-written email counts as one you wrote yourself.
  const w2 = mailFromWitness(text({ threads: [th('T1', [M1]), th('T4', [HAND])] }), SO);
  assert.equal(w2.readable, true, JSON.stringify(w2));
  assert.equal(w2.found_by, 'id');
  assert.equal(w2.own_after, 1);
  // No id recorded: the earliest own message since the start is still the proof (as before).
  const w3 = mailFromWitness(text({ threads: [th('T4', [HAND])] }), { ...SO, ownId: null });
  assert.equal(w3.readable, true, JSON.stringify(w3));
  assert.equal(w3.found_by, 'date');
});

test('F5-NP1a e2e: the search shows only your hand-written email to Ana, not message 1: held as a search floorboss can\'t trust', async () => {
  const H = clone(GBASE);
  gdata(H, (d) => ({ ...d, mail: { ...d.mail, threads: T_HAND } }));
  const r = await grun(H, { answer: (n, args, real) => text(n === 'search_threads' ? { threads: (real.threads || []).filter((x) => x.id === 't-hand') } : real) });
  assert.ok(!r.allowed, 'the draft went in');
  assert.equal(releases(H).length, 0);
  assert.match(heldWhy(H), new RegExp(esc(SEARCH_UNPROVEN)));
  // Control: both shown, held as an email you wrote them yourself.
  const H2 = clone(GBASE);
  gdata(H2, (d) => ({ ...d, mail: { ...d.mail, threads: T_HAND } }));
  const r2 = await grun(H2);
  assert.ok(!r2.allowed);
  assert.equal(releases(H2).length, 0);
  assert.match(heldWhy(H2), new RegExp(esc(YOU_WROTE)));
});

test('F5-S1-5: your thread shows five older messages and not message 1; a hand-written email elsewhere is no proof', () => {
  const shown = [1, 2, 3, 4, 5].map((i) => msg(`old${i}`, i % 2 ? OWN : ANA, `2026-09-0${i}T10:00:00Z`, i % 2 ? [ANA] : [OWN], i % 2 ? ['SENT'] : ['INBOX']));
  const hand = msg('h1', OWN, '2026-10-12T12:00:00Z');
  const w = mailFromWitness(text({ threads: [th('T1', shown, 7), th('T4', [hand])] }), SO);
  assert.equal(w.readable, false, JSON.stringify(w));
  assert.equal(w.why, SEARCH_UNPROVEN);
  // An email of yours with message 1's own date, under another id, counts as yours too.
  const twin = msg('h2', OWN, '2026-10-12T08:00:00Z');
  const w2 = mailFromWitness(text({ threads: [th('T1', [M1]), th('T5', [twin])] }), SO);
  assert.equal(w2.own_after, 1, JSON.stringify(w2));
});

// (Fix round 5: the owner's simpler rule replaces the older-dates check. A message from them in another conversation
// the search matched holds whatever its date: test/unattended-fixes-7.test.mjs F6-S2-1.)
test('F5-S1-3: a conversation the search matched that shows only dates before its start holds the draft', async () => {
  const skew = th('t-skew', [msg('sk1', `Ana <${ANA}>`, '2026-10-12T07:30:00Z', [OWN], ['INBOX'])]);
  const w = mailFromWitness(text({ threads: [th('T1', [M1]), skew] }), SO);
  assert.equal(w.readable, true, JSON.stringify(w));
  assert.equal(w.inbound, 1, JSON.stringify(w));
  // Your own thread may show older messages (the thread read reads it whole).
  const w2 = mailFromWitness(text({ threads: [th('T1', [msg('o1', ANA, '2026-10-01T10:00:00Z', [OWN], ['INBOX']), M1])] }), SO);
  assert.equal(w2.readable, true, JSON.stringify(w2));
  // Through the guard: the stand-in's own answer plus that conversation.
  const H = clone(GBASE);
  const r = await grun(H, { answer: (n, args, real) => text(n === 'search_threads' ? { threads: [...real.threads, { ...skew, viewUrl: 'x' }] } : real) });
  assert.ok(!r.allowed, 'the draft went in');
  assert.equal(releases(H).length, 0);
  assert.match(heldWhy(H), /your mailbox shows 1 conversation with something from them since your last message/);
});

test('F5-S1-4: a message count that is not a whole number makes the search unreadable', () => {
  const old = msg('o1', ANA, '2026-10-01T10:00:00Z', [OWN], ['INBOX']);
  for (const c of ['', false, [], ' ', true, '1', 1.5, -1, 6, null]) {
    const w = mailFromWitness(text({ threads: [th('T1', [M1]), { id: 'T7', messageCount: c, messages: [old, msg('n1', OWN, '2026-10-12T09:00:00Z', ['bo@acme.test'])] }] }), SO);
    assert.equal(w.readable, false, `${JSON.stringify(c)}: ${JSON.stringify(w)}`);
  }
  const ok = mailFromWitness(text({ threads: [th('T1', [M1]), { id: 'T7', messageCount: 2, messages: [old, msg('n1', OWN, '2026-10-12T09:00:00Z', ['bo@acme.test'])] }] }), SO);
  assert.equal(ok.readable, true, JSON.stringify(ok));
});

// After an unattended draft of follow-up 1 went in, a new text of it, the critic and the approval, written as
// unattended-drafts.test.mjs writes them, with the work copy updated.
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
const OLDER = /an older draft of this follow-up \(draft [\w-]+\), for its text before you changed it, may be in your drafts folder: delete it, then tell floorboss it's gone \(outreach draft-missing\)/;

test('F5-S1-1: a new text approved and authorised again after an unattended draft went in waits until you say the old draft is gone', async () => {
  const H = clone(GBASE);
  const a = await grun(H);
  assert.ok(a.allowed, JSON.stringify(a.refused?.stderr || a.last));
  const first = ledgerOf(H).filter((e) => e.type === 'staged' && e.touch === 2);
  assert.equal(first.length, 1);
  const at = '2026-10-13T12:00:00Z';
  const hash = newText(H, at);
  assert.deepEqual(
    olderDraftOf(ledgerOf(H), H.ana, 2, hash),
    { at: first[0].at, hash: releases(H)[0].hash, draft_id: first[0].draft_id, count: 1 }
  );
  // Authorised again with you there: the prompt names the older draft.
  const au = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug), { now: at, session: 's-att2' });
  assert.equal(au.pre.decision, 'ask', au.pre.stderr);
  assert.match(au.pre.reason, OLDER);
  assert.ok(au.pre.reason.includes(`draft ${first[0].draft_id}`));
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att2' }, { now: at });
  // Wed 14: the launcher holds it up front; a ticket made anyway is refused by the guard.
  H.now = D14;
  const due = inHome(H, () => followupsDue(Date.parse(D14), []));
  assert.deepEqual(due.items, []);
  assert.match(due.held.map((x) => x.why).join(' '), OLDER);
  // The ticket as the launcher would have made it without that hold (the same home with your word written in a copy).
  const H0 = clone(H);
  appendFileSync(join(H0.dir, 'ledger.jsonl'), `${JSON.stringify({ at: D14, type: 'stage_cleared', who: 'user', id: H.ana, touch: 2, said: 'x' })}\n`);
  const forced = (await ticket(H0, { now: D14 })).items;
  assert.deepEqual(forced.map((x) => `${x.id}:${x.touch}:${x.hash}`), [`${H.ana}:2:${hash}`]);
  // You deleted the old draft but haven't told floorboss yet. (With it still in the thread, the thread read holds on its
  // own: its count is above the messages it shows, test/unattended-fixes-8.)
  writeFileSync(join(H.HOME, 'standin.json.drafts.json'), '[]');
  const b = await grun(H, { items: forced });
  assert.ok(b.t.items.length && !b.empty);
  assert.ok(!b.allowed, 'a second draft of follow-up 1 went in');
  assert.equal(releases(H).length, 1);
  assert.match(heldWhy(H), OLDER);
  // You say it's gone (draft-missing, with its prompt naming the older draft): it can go in.
  const dm = bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'deleted-the-old-one'), { session: 's-att4', now: D14 });
  assert.equal(dm.pre.decision, 'ask', dm.pre.stderr);
  assert.match(dm.pre.reason, /A draft of its text before you changed it went into your drafts folder \(draft [\w-]+\)\. Allow this only once you deleted it\./);
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.id === H.ana && e.touch === 2), String(dm.stdout).slice(0, 300));
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att4' }, { now: D14 });
  assert.equal(olderDraftOf(ledgerOf(H), H.ana, 2, hash), null);
  const again = inHome(H, () => followupsDue(Date.parse(D14), [])).items;
  assert.deepEqual(again.map((x) => `${x.id}:${x.touch}`), [`${H.ana}:2`]);
  // (Today's earlier hold keeps them off today's tickets by design: the ticket is the launcher's list without that log.)
  H.now = '2026-10-14T09:00:00Z';
  const c = await grun(H, { items: again });
  assert.ok(c.allowed, JSON.stringify(c.refused?.stderr || c.last || heldWhy(H)).slice(0, 400));
  assert.equal(releases(H).length, 2);
  assert.equal(releases(H)[1].hash, hash);
});

test('F5-S1-1b: olderDraftOf reads a release with no receipt, two older texts, and the same text drafted again', () => {
  const L = (type, extra) => ({ at: '2026-10-13T08:00:00Z', type, id: 'c001', touch: 2, ...extra });
  // A release whose receipt never came, then a new text: still an older draft (stale_staged would not have it).
  assert.deepEqual(olderDraftOf([L('drafted', { hash: 'A' }), L('stage_released', { hash: 'A' }), L('drafted', { hash: 'B' })], 'c001', 2, 'B'), { at: '2026-10-13T08:00:00Z', hash: 'A', draft_id: null, count: 1 });
  // Two older texts in the drafts folder.
  const two = [L('drafted', { hash: 'A' }), L('staged', { draft_id: 'dA' }), L('drafted', { hash: 'B' }), L('staged', { draft_id: 'dB' }), L('drafted', { hash: 'C' })];
  assert.equal(olderDraftOf(two, 'c001', 2, 'C').count, 2);
  assert.equal(olderDraftOf(two, 'c001', 2, 'C').draft_id, 'dB');
  // Cleared by your word; the same text drafted again; another step or person: none.
  assert.equal(olderDraftOf([...two, L('stage_cleared', {})], 'c001', 2, 'C'), null);
  assert.equal(olderDraftOf([L('drafted', { hash: 'A' }), L('stage_released', { hash: 'A' }), L('drafted', { hash: 'A' })], 'c001', 2, 'A'), null);
  assert.equal(olderDraftOf(two, 'c001', 3, 'C'), null);
  assert.equal(olderDraftOf(two, 'c002', 2, 'C'), null);
});

test('F5-docs: SECURITY.md says what the search proves; README and the command ask for Spam and Trash without promising it', () => {
  const sec = flat('SECURITY.md');
  assert.match(sec, /What this proves is that the search covered your own email: the `after:` start, sent mail and the `to:` half of the group\. It can't show that `from:` matched inside the group/);
  // (Fix round 5: the real calls were made; SECURITY.md says what they showed, test/unattended-fixes-7.test.mjs F6-docs.)
  assert.match(sec, /Real calls to the claude\.ai Gmail connector \(15 November 2026\) took the grouping, `from:`, `to:`, `in:anywhere` and `after:` in epoch seconds/);
  assert.match(sec, /by its message id when floorboss has one, and then no other email of yours stands in for it/);
  assert.match(sec, /A draft of an older text of a follow-up .* holds that follow-up's unattended draft, in the launcher and the guard, until you say it isn't in your drafts folder/);
  for (const f of ['README.md', 'commands/unattended.md']) {
    // (Fix round 5: one plain sentence of what the code can show, test/unattended-fixes-7.test.mjs F6-docs.)
    assert.match(flat(f), /searches every folder but Spam, which Gmail leaves out, and floorboss can only show that the search covered your own last email and the time since, not that it matched mail from them/i, f);
    assert.doesNotMatch(flat(f), /in every folder, Spam and Trash included \(`search_threads`\)|in any thread, Spam and Trash included, which/, f);
  }
});
