// Unattended drafts with the claude.ai Gmail connector, in its published shapes (examples/standins/gmail-real.mjs,
// called over MCP stdio): message 1 goes through its send_message and the guard records the message id and thread
// its answer gives; the run reads the whole thread (get_thread) and searches for anything from the person
// (search_threads), each read pinned exactly; the draft goes in by create_draft's replyToMessageId. Nothing here
// starts Claude Code or a real mail tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { world, clone, ticket, start, inRun, afterRun, stageItem, ledgerOf, logOf, text, gcall, gdata, G, OWN, ANA, ROOT, NOW } from './fixtures/unattended-world.mjs';
import { cli } from './fixtures/harness.mjs';
import { mailWitness, mailFromWitness, mailMessages, SEARCH_UNPROVEN } from '../hooks/guard/witness.mjs';

const BASE = world({ gmail: true });
const tool = (n) => `mcp__${G}__${n}`;
const fill = (args, values) => JSON.parse(JSON.stringify(args).replace(/\{([a-z_]+)\}/g, (m, k) => values[k] ?? m));
const refused = (r, re) => {
  assert.equal(r.code, 2, `expected a refusal, got ${r.code} ${r.decision} ${r.stderr}`);
  if (re) assert.match(r.stderr, re);
};
function next(H, t) {
  const was = process.env.FLOORBOSS_UNATTENDED;
  process.env.FLOORBOSS_UNATTENDED = t.token;
  try {
    return cli(H, 'flow', ['next', '--unattended'], H.now);
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_UNATTENDED;
    else process.env.FLOORBOSS_UNATTENDED = was;
  }
}
// The run as its model makes it: each step the flow gives, the call through the guard, the stand-in's answer to the
// guard's post hook. wrap: how the answer reaches the hook (one text block, structuredContent, or both).
async function run(H, { wrap = text, draft = (it) => ({ to: [it.to], subject: it.subject, body: it.body, replyToMessageId: it.reply_to_message_id }) } = {}) {
  const t = await ticket(H);
  assert.equal(start(H, t).code, 0);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const n = next(H, t);
    seen.push(n.step);
    if (n.step === 'read_mail' || n.step === 'read_mail_from') {
      const args = fill(n.call.recipe.args, n.call.values);
      const pre = inRun(H, t, tool(n.call.recipe.tool), args, { id: `r${i}` });
      if (pre.decision !== 'allow') return { t, seen, refused: pre };
      seen.push(`${n.call.recipe.tool} ${JSON.stringify(args)}`);
      afterRun(H, t, tool(n.call.recipe.tool), args, wrap(gcall(H, n.call.recipe.tool, args)), { id: `r${i}` });
    } else if (n.step === 'stage_one') {
      const args = draft(n.call.item);
      const pre = inRun(H, t, tool('create_draft'), args, { id: `s${i}` });
      if (pre.decision !== 'allow') return { t, seen, refused: pre };
      const answer = gcall(H, 'create_draft', args);
      seen.push(`create_draft ${JSON.stringify(answer)}`);
      afterRun(H, t, tool('create_draft'), args, wrap(answer), { id: `s${i}` });
    } else return { t, seen, last: n };
  }
  return { t, seen };
}

test('R3-14a: the claude.ai Gmail connector: message 1\'s id and thread come from the send\'s own answer; the run reads the thread and searches for them, and the draft goes in as a reply to message 1', async () => {
  // The guard's post hook read the send's answer: the receipt (Claude's) named no thread.
  const sent = ledgerOf(BASE).filter((e) => e.id === BASE.ana && e.touch === 1);
  assert.ok(sent.some((e) => e.type === 'call_result' && e.kind === 'send' && e.who === 'guard' && e.message_id === BASE.m1.id && e.thread_id === BASE.m1.threadId), JSON.stringify(sent));
  assert.ok(sent.some((e) => e.type === 'sent' && !e.thread_id));
  for (const [style, wrap] of [
    [{ sender: 'named', date: 'iso' }, text],
    [{ sender: 'plain', date: 'rfc2822' }, (v) => ({ structuredContent: v })],
    [{ sender: 'object', date: 'ms' }, (v) => ({ ...text(v), structuredContent: v })]
  ]) {
    const H = clone(BASE);
    gdata(H, (d) => ({ ...d, mail: { ...d.mail, style } }));
    const r = await run(H, { wrap });
    assert.equal(r.refused, undefined, `${JSON.stringify(style)}: ${r.refused?.stderr}`);
    assert.deepEqual(r.seen.filter((s) => /^[a-z_]+$/.test(s)), ['read_mail', 'read_mail_from', 'stage_one', 'done'], JSON.stringify(r.seen));
    // Each read exactly as pinned: the whole thread, metadata only; anything from them since the day before.
    assert.ok(r.seen.includes(`get_thread ${JSON.stringify({ threadId: BASE.m1.threadId, messageFormat: 'METADATA_ONLY' })}`), r.seen.join('\n'));
    // (Every folder, from or to them, from 15 minutes before the guard let message 1 through, in epoch seconds.)
    assert.ok(r.seen.includes(`search_threads ${JSON.stringify({ query: `in:anywhere {from:${ANA} to:${ANA}} after:${Math.floor((Date.parse(NOW) - 15 * 60000) / 1000)}`, pageSize: 50 })}`), r.seen.join('\n'));
    const staged = ledgerOf(H).find((e) => e.type === 'staged' && e.touch === 2);
    assert.equal(staged?.thread_id, BASE.m1.threadId, JSON.stringify(style));
    const w = logOf(H).filter((e) => e.type === 'read_witnessed');
    assert.deepEqual(w.map((e) => [e.kind, e.readable, e.inbound]), [['mail', true, 0], ['mailfrom', true, 0]]);
  }
});

test('R3-14b: a reply in the thread, or them writing in a new thread, holds the draft; reads the model changed are refused', async () => {
  // A reply in the thread of message 1.
  {
    const H = clone(BASE);
    gdata(H, (d) => ({ ...d, mail: { ...d.mail, threads: [{ thread_id: BASE.m1.threadId, to: ANA, subject: 'x', replies: [{ from: ANA, at: '2026-10-12T15:00:00Z', snippet: 'Tuesday works' }] }] } }));
    const r = await run(H);
    assert.match(logOf(H).filter((e) => e.type === 'held').map((e) => e.why).join(' '), /1 message came in since your last message \(from ana@acme\.test/);
    assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'), r.seen.join('\n'));
  }
  // Ana writes in a new thread: the thread itself is clean, the search finds her.
  {
    const H = clone(BASE);
    gdata(H, (d) => ({ ...d, mail: { ...d.mail, threads: [{ thread_id: 't-new', to: OWN, subject: 'Lunch?', replies: [{ from: ANA, at: '2026-10-12T16:00:00Z' }] }] } }));
    await run(H);
    assert.match(logOf(H).filter((e) => e.type === 'held').map((e) => e.why).join(' '), /your mailbox shows 1 conversation with something from them since your last message/);
    assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'));
  }
  // The guard's own rule, whatever the run's flow says: the thread read alone is not enough.
  {
    const H = clone(BASE);
    const t = await ticket(H);
    start(H, t);
    const n = next(H, t);
    const args = fill(n.call.recipe.args, n.call.values);
    assert.equal(inRun(H, t, tool('get_thread'), args, { id: 'g1' }).decision, 'allow');
    afterRun(H, t, tool('get_thread'), args, text(gcall(H, 'get_thread', args)), { id: 'g1' });
    const it = stageItem(H, t);
    refused(inRun(H, t, tool('create_draft'), { to: [it.to], subject: it.subject, body: it.body, replyToMessageId: it.reply_to_message_id }), /your mailbox wasn't searched for anything from them by this run/);
  }
  // The draft call must reply to message 1, by its own id: another message, or none, never goes in.
  for (const [name, draft, re] of [
    ['another message', (it) => ({ to: [it.to], subject: it.subject, body: it.body, replyToMessageId: 'm-someone-else' }), /the reply-to argument must be the listed one/],
    ['no reply-to', (it) => ({ to: [it.to], subject: it.subject, body: it.body }), /it must go in reply to your last email to them/]
  ]) {
    const H = clone(BASE);
    const r = await run(H, { draft });
    assert.ok(r.refused, name);
    refused(r.refused, re);
    assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'), name);
  }
  // Reads the model changed: the format left out, the saved attended search instead, a later day, an empty extra.
  for (const [name, n, input] of [
    ['format left out', 'get_thread', { threadId: BASE.m1.threadId }],
    ['the attended recipe', 'search_threads', { query: `from:${ANA} OR to:${ANA} after:2026-10-11` }],
    ['a later day', 'search_threads', { query: `from:${ANA} after:2026/10/13`, pageSize: 50 }],
    ['an empty extra', 'get_thread', { threadId: BASE.m1.threadId, messageFormat: 'METADATA_ONLY', labelIds: [] }]
  ]) {
    const H2 = clone(BASE);
    const t2 = await ticket(H2);
    start(H2, t2);
    refused(inRun(H2, t2, tool(n), input), null);
    assert.ok(logOf(H2).some((e) => e.type === 'run_stopped'), name);
  }
});

test('R3-14c: the witness reads the connector\'s shapes, and fails closed on what it can\'t read whole', () => {
  const since = Date.parse('2026-10-11T00:00:00Z');
  const own = [OWN];
  const msg = (sender, date, extra = {}) => ({ id: `m${Math.random()}`, sender, toRecipients: [ANA], ccRecipients: [], bccRecipients: [], date, labelIds: ['SENT'], viewUrl: 'https://x', ...extra });
  const mine = msg(`Me <${OWN}>`, '2026-10-12T08:00:00Z');
  // get_thread: sender as text, "Name <address>" or an object; date as ISO, RFC 2822 or epoch ms; text, structured or both.
  for (const sender of [ANA, `Ana Berg <${ANA}>`, { name: 'Ana Berg', email: ANA }, { emailAddress: { address: ANA } }])
    for (const date of ['2026-10-12T15:00:00Z', 'Mon, 12 Oct 2026 15:00:00 +0000', Date.parse('2026-10-12T15:00:00Z')]) {
      const v = { id: 'T1', viewUrl: 'https://x', messages: [mine, msg(sender, date, { labelIds: ['INBOX'] })] };
      for (const resp of [text(v), { structuredContent: v }, { ...text(v), structuredContent: v }]) {
        const w = mailWitness(resp, { own, sinceMs: since });
        assert.deepEqual([w.readable, w.inbound], [true, 1], `${JSON.stringify(sender)} ${date}`);
      }
    }
  // A message with no sender floorboss can read, or two that disagree: unreadable.
  assert.equal(mailWitness(text({ messages: [mine, msg(null, '2026-10-12T15:00:00Z')] }), { own, sinceMs: since }).readable, false);
  assert.equal(mailWitness(text({ messages: [mine, msg(ANA, '2026-10-12T15:00:00Z', { from: 'bo@x.test' })] }), { own, sinceMs: since }).readable, false);
  // search_threads as a mailbox read: a thread that shows fewer messages than it holds, or a page token, is partial.
  const th = (n, shown) => ({ id: 'T1', messageCount: n, viewUrl: 'https://x', messages: Array.from({ length: shown }, (_, i) => (i ? msg(ANA, '2026-10-12T15:00:00Z') : mine)) });
  assert.equal(mailMessages({ threads: [th(9, 5)] }).ok, false);
  assert.equal(mailMessages({ threads: [th(2, 2)], nextPageToken: 'p2' }).ok, false);
  assert.deepEqual(mailMessages({ threads: [th(2, 2)] }).messages.map((m) => m.thread), ['T1', 'T1']);
  // {} is zero items: no witness for the thread read (it doesn't show your own email), and no clean search either
  // (the search must show your own last email to them).
  assert.equal(mailWitness(text({}), { own, sinceMs: since }).readable, false);
  const so = { own, contact: ANA, sinceMs: since, ownId: mine.id, ownThread: 'T1' };
  for (const v of [{}, { threads: [] }]) assert.deepEqual([mailFromWitness(text(v), so).readable, mailFromWitness(text(v), so).why], [false, SEARCH_UNPROVEN], JSON.stringify(v));
  // Your own email alone: clean. Their message after it holds, also in your own thread when the search shows only some
  // of it (the thread read reads it whole); another conversation shown in part, one with no count, more pages, an error
  // or another shape is no witness.
  assert.deepEqual([mailFromWitness(text({ threads: [th(1, 1)] }), so).readable, mailFromWitness(text({ threads: [th(1, 1)] }), so).inbound], [true, 0]);
  assert.equal(mailFromWitness(text({ threads: [th(9, 5)] }), so).inbound, 1);
  assert.equal(mailFromWitness(text({ threads: [th(9, 5)] }), { ...so, ownThread: 'T9' }).readable, false);
  assert.equal(mailFromWitness(text({ threads: [th(1, 1), { id: 'T2', messages: [] }] }), so).readable, false);
  assert.equal(mailFromWitness(text({ threads: [th(1, 1)], nextPageToken: 'p2' }), so).readable, false);
  assert.equal(mailFromWitness({ isError: true, content: [{ type: 'text', text: 'quota' }] }, so).readable, false);
  assert.equal(mailFromWitness(text({ messages: [] }), so).readable, false);
  assert.equal(mailFromWitness(text({ threads: [{ id: '' }] }), so).readable, false);
});

test('R3-14d: README and the opt-in command say which Gmail tools the check uses', () => {
  const flat = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\n\s*(>\s*)?/g, ' ');
  // (fix round 4, round 2: Spam and Trash are asked for, not promised; fix round 5: said as what the code can show.)
  assert.match(flat('README.md'), /With the claude\.ai Gmail connector it makes two reads: the whole thread of your last email to them \(`get_thread`\), and a search for anything from them or to them since shortly before it \(`search_threads`; from the day before it, when floorboss has no time of its own for it\)\. It searches every folder but Spam, which Gmail leaves out, and floorboss can only show that the search covered your own last email and the time since, not that it matched mail from them\. The search must find your own last email to them, or the draft is held/);
  assert.match(flat('commands/unattended.md'), /with Gmail: your whole thread with them, and a search for anything from or to them in any thread, which must find your own last email to them or the draft waits; it searches every folder but Spam, which Gmail leaves out, and floorboss can only show that the search covered your own last email and the time since, not that it matched mail from them\)/);
});
