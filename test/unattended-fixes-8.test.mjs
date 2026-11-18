// The independent security review of the integrated branch (2026-11-16): one test per item, each failing on the code
// with its fix taken out (FIX-REPORT.md in the session's integrate/fix-sec scratchpad says how each was shown). Through
// the real guard, flow and the gmail-real stand-in in throwaway homes; nothing here starts Claude Code, launchctl or a
// real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { world, clone, ticket, start, readMail, stageItem, stage, draftInput, inRun, afterRun, hook, bashCall, scriptCmd, ledgerOf, logOf, text, gcall, G, MAIL_OK, OWN, ANA, ROOT, TEST_DEADLINE } from './fixtures/unattended-world.mjs';
import { cli } from './fixtures/harness.mjs';
import { sendLocks } from '../hooks/guard/daymark.mjs';
import { mailWitness, mailFromWitness } from '../hooks/guard/witness.mjs';
import { gmailReads } from '../lib/unattended-drafts.mjs';

const BASE = world();
const GBASE = world({ gmail: true });
const D14 = '2026-10-14T08:00:00Z';
const tool = (n) => `mcp__${G}__${n}`;
const fill = (args, values) => JSON.parse(JSON.stringify(args).replace(/\{([a-z_]+)\}/g, (m, k) => values[k] ?? m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edit = (p, fn) => writeFileSync(p, fn(readFileSync(p, 'utf8')));
const draftsMode = (H) =>
  edit(join(H.dir, 'event.json'), (s) => {
    const e = JSON.parse(s);
    e.settings.sending = { channels: [], followups: 'scheduled' };
    return JSON.stringify(e);
  });

// The guard as a process that can wait on a lock this test holds.
function hookAsync(H, input, { now, env = {}, args = [] }) {
  const e = { ...process.env, ...TEST_DEADLINE, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, FLOORBOSS_PLATFORM: 'darwin', CLAUDE_PLUGIN_ROOT: ROOT, ...env };
  return new Promise((res) => {
    const c = spawn(process.execPath, [join(ROOT, 'hooks/guard.mjs'), ...args], { env: e });
    let out = '',
      err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => {
      let d = null;
      try {
        d = JSON.parse(out).hookSpecificOutput.permissionDecision;
      } catch {}
      res({ code, decision: d, stderr: err });
    });
    c.stdin.end(JSON.stringify(input));
  });
}
// Holds the person's send locks, starts the call, writes what another guard would write under them, then lets go.
async function underLocks(H, call, write) {
  const locks = sendLocks(H.dir, H.ana, ANA).map((n) => join(H.HOME, `${n}.lock`));
  for (const l of locks) {
    mkdirSync(l);
    writeFileSync(join(l, 'pid'), String(process.pid));
    // An hour ahead: young by the wall clock however long the machine stalls (test/unattended-merge.test.mjs).
    const ahead = new Date(Date.now() + 3600 * 1000);
    utimesSync(l, ahead, ahead);
  }
  const p = call();
  await sleep(2500);
  write();
  for (const l of locks) rmSync(l, { recursive: true });
  return p;
}
// Run 1 lets follow-up 1's draft through (its result never comes back), and you say it isn't in your drafts.
async function clearedWorld() {
  const H = clone(BASE);
  const t1 = await ticket(H);
  assert.equal(start(H, t1).code, 0);
  assert.equal(readMail(H, t1, MAIL_OK).pre.decision, 'allow');
  const s1 = stage(H, t1, stageItem(H, t1), { post: false });
  assert.equal(s1.pre.decision, 'allow', s1.pre.stderr);
  bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'notthere'), { session: 's-att2' });
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.id === H.ana && e.touch === 2), 'stage_cleared written');
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att2' });
  H.now = D14;
  return { H, items: t1.items };
}

test('S-F1a: an attended send of a follow-up let through while its unattended draft waits on the locks holds the draft (a stage_cleared on the step)', async () => {
  for (const resets of [0, 1]) {
    const { H, items } = await clearedWorld();
    const t = await ticket(H, { items });
    assert.equal(start(H, t).code, 0);
    assert.equal(readMail(H, t, MAIL_OK).pre.decision, 'allow');
    const it = stageItem(H, t);
    assert.ok(it, 'listed again');
    const draft = () => hookAsync(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(it), session_id: t.session, tool_use_id: `tu-race-${resets}` }, { now: D14, env: { FLOORBOSS_UNATTENDED: t.token } });
    // What the attended send guard writes under the same locks (hooks/guard.mjs): its marker, the day marker, the release.
    const r = await underLocks(H, draft, () => {
      writeFileSync(join(H.dir, 'released', `${H.ana}-2-${resets}`), '', { flag: 'wx' });
      writeFileSync(join(H.dir, 'released', `${H.ana}-day-2026-10-14`), `${H.slug}:${H.ana}:2:${resets}`, { flag: 'wx' });
      appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: D14, type: 'send_released', who: 'guard', id: H.ana, touch: 2, hash: it.hash || null, via: 'email.send', to: ANA })}\n`);
    });
    assert.equal(r.code, 2, `resets ${resets}: ${r.code} ${r.decision} ${r.stderr}`);
    assert.equal(ledgerOf(H).filter((e) => e.type === 'stage_released' && e.touch === 2 && e.at.startsWith('2026-10-14')).length, 0);
    assert.ok(!readdirSync(join(H.dir, 'released')).some((f) => f.startsWith(`${H.ana}-day-2026-10-14~`)), 'no next day-marker link');
  }
});

test('S-F1a2: a send of the step released under the locks holds its unattended draft, even with no day marker of it to read', async () => {
  const { H, items } = await clearedWorld();
  const t = await ticket(H, { items });
  assert.equal(start(H, t).code, 0);
  assert.equal(readMail(H, t, MAIL_OK).pre.decision, 'allow');
  const it = stageItem(H, t);
  const draft = () => hookAsync(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(it), session_id: t.session, tool_use_id: 'tu-race-r' }, { now: D14, env: { FLOORBOSS_UNATTENDED: t.token } });
  const r = await underLocks(H, draft, () => {
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: D14, type: 'send_released', who: 'guard', id: H.ana, touch: 2, hash: it.hash || null, via: 'email.send', to: ANA })}\n`);
  });
  assert.equal(r.code, 2, `${r.code} ${r.decision} ${r.stderr}`);
  assert.match(r.stderr, /a send of this same follow-up was let through a moment ago/);
});

test('S-F1b: one day rule on both paths: your word that a draft is not there frees no day, so a second unattended draft of the step waits for the next day', async () => {
  // Tue 13: run 1 lets follow-up 1 through, you say it isn't in your drafts, and a second run that day tries again.
  const H = clone(BASE);
  const t1 = await ticket(H);
  assert.equal(start(H, t1).code, 0);
  assert.equal(readMail(H, t1, MAIL_OK).pre.decision, 'allow');
  assert.equal(stage(H, t1, stageItem(H, t1), { post: false }).pre.decision, 'allow');
  bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'notthere'), { session: 's-att2', now: '2026-10-13T09:00:00Z' });
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.id === H.ana && e.touch === 2), 'stage_cleared written');
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att2' }, { now: '2026-10-13T09:00:00Z' });
  H.now = '2026-10-13T10:00:00Z';
  const t2 = await ticket(H, { items: t1.items });
  assert.equal(start(H, t2).code, 0);
  assert.equal(readMail(H, t2, MAIL_OK).pre.decision, 'allow');
  const it = stageItem(H, t2);
  assert.ok(it, 'listed again');
  const r = stage(H, t2, it, { post: false }).pre;
  assert.equal(r.code, 2, `${r.code} ${r.decision} ${r.stderr}`);
  assert.match(r.stderr, /another message to them already went or is going today \(one a day\)/);
  assert.equal(ledgerOf(H).filter((e) => e.type === 'stage_released' && e.touch === 2).length, 1);
  assert.ok(!readdirSync(join(H.dir, 'released')).some((f) => f.startsWith(`${H.ana}-day-2026-10-13~`)), 'no next day-marker link');
});

test('S-F1c: an attended draft call marked while the unattended draft of the same step waits on the locks holds the unattended one', async () => {
  const H = clone(BASE);
  const t = await ticket(H);
  assert.equal(start(H, t).code, 0);
  assert.equal(readMail(H, t, MAIL_OK).pre.decision, 'allow');
  const it = stageItem(H, t);
  const draft = () => hookAsync(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(it), session_id: t.session, tool_use_id: 'tu-u1' }, { now: H.now, env: { FLOORBOSS_UNATTENDED: t.token } });
  // What the attended stage guard writes under the same locks now: the step's call mark (its prompt is open).
  const r = await underLocks(H, draft, () => {
    mkdirSync(join(H.dir, 'released'), { recursive: true });
    writeFileSync(join(H.dir, 'released', `stage-call-${H.ana}-2-b1-1`), new Date(Date.parse(H.now)).toISOString());
  });
  assert.equal(r.code, 2, `${r.code} ${r.decision} ${r.stderr}`);
  assert.match(r.stderr, /a draft of this same follow-up was started in a session with you there/);
  assert.equal(ledgerOf(H).filter((e) => e.type === 'stage_released' && e.touch === 2).length, 0);
});

test('S-F1d: an unattended draft let through while an attended draft of the same step waits on the locks holds the attended one', async () => {
  const H = clone(BASE);
  draftsMode(H);
  const t0 = '2026-10-13T08:00:00Z';
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], t0);
  const att = JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === H.ana && x.touch === 2);
  assert.ok(att, 'listed attended');
  const call = () => hookAsync(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(att), session_id: 's-att9', tool_use_id: 'att-9' }, { now: t0 });
  // What the unattended guard writes under the same locks: its release.
  const r = await underLocks(H, call, () => {
    appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: t0, type: 'stage_released', who: 'guard', id: H.ana, touch: 2, hash: att.hash, to: ANA, thread_id: String(att.reply_in_thread), unattended: true, run: 'r1' })}\n`);
  });
  assert.equal(r.code, 2, `${r.code} ${r.decision} ${r.stderr}`);
  assert.match(r.stderr, /its draft already went into your drafts on its own/);
  assert.ok(!readdirSync(join(H.dir, 'released')).some((f) => f.startsWith(`stage-call-${H.ana}-2-`)), 'no call mark left');
});

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
// A Gmail run as its model makes it. thread / search: change the stand-in's answer. view: the search's view as sent.
async function grun(H, { thread = (v) => v, search = (v) => v, args: change = (a) => a } = {}) {
  const t = await ticket(H);
  assert.equal(start(H, t).code, 0);
  for (let i = 0; i < 8; i++) {
    const n = next(H, t);
    if (n.step === 'read_mail' || n.step === 'read_mail_from') {
      const args = change(fill(n.call.recipe.args, n.call.values), n.call.recipe.tool);
      const pre = inRun(H, t, tool(n.call.recipe.tool), args, { id: `r${i}` });
      if (pre.decision !== 'allow') return { refused: pre, seen: n.call.recipe };
      const ans = gcall(H, n.call.recipe.tool, args);
      afterRun(H, t, tool(n.call.recipe.tool), args, text(n.call.recipe.tool === 'get_thread' ? thread(ans) : search(ans)), { id: `r${i}` });
    } else if (n.step === 'stage_one') {
      const it = n.call.item;
      const pre = inRun(H, t, tool('create_draft'), { to: [it.to], subject: it.subject, body: it.body, replyToMessageId: it.reply_to_message_id }, { id: `s${i}` });
      return { draft: pre.decision };
    } else return { last: n.step, held: logOf(H).filter((e) => e.type === 'held').map((e) => e.why).pop() };
  }
  return {};
}

const SINCE = Date.parse('2026-10-11T00:00:00Z');
const MSG = { id: 'm1', sender: OWN, toRecipients: [ANA], date: '2026-10-12T08:00:00Z', internalDate: String(Date.parse('2026-10-12T08:00:00Z')), labelIds: ['SENT'], threadId: 'T1', viewUrl: 'x' };
const TH = (extra = {}) => ({ id: 'T1', messageCount: 1, messages: [MSG], viewUrl: 'x', ...extra });

test('S-F2a: the thread read holds on any key beside id, messageCount, messages and viewUrl, on a count above the messages shown, and on no count at all', () => {
  const w = (v) => mailWitness(text(v), { own: [OWN], sinceMs: SINCE, thread: true });
  assert.equal(w(TH()).readable, true);
  assert.equal(w({ id: 'T1', messageCount: 1, messages: [MSG] }).readable, true, 'no viewUrl');
  // The connector always sends messageCount: an answer without one can't be shown to be the whole thread (review of
  // 45bf380, item 3).
  for (const v of [{ id: 'T1', messages: [MSG] }, { id: 'T1', messages: [MSG], viewUrl: 'x' }]) {
    const r = w(v);
    assert.equal(r.readable, false, JSON.stringify(v));
    assert.match(r.why, /has no message count/);
  }
  for (const c of [null, '1', 1.5, -1, true, [1]]) {
    const r = w(TH({ messageCount: c }));
    assert.equal(r.readable, false, JSON.stringify(c));
    assert.match(r.why, /message count in the answer isn't a number/);
  }
  for (const extra of [{ omittedContent: 'Some content was filtered: 1 message' }, { omittedContent: true }, { resultSizeEstimate: 1 }, { snippet: 'x' }, { '': {} }]) {
    const r = w(TH(extra));
    assert.equal(r.readable, false, JSON.stringify(extra));
    assert.match(r.why, /beside its messages, which isn't the connector's answer/);
  }
  for (const c of [2, 6]) {
    const r = w(TH({ messageCount: c }));
    assert.equal(r.readable, false, String(c));
    assert.match(r.why, new RegExp(`the thread shows 1 of its ${c} messages`));
  }
  // Only the thread read: a plain mailbox answer keeps its own rules.
  assert.equal(mailWitness(text({ messages: [MSG], extra: 1 }), { own: [OWN], sinceMs: SINCE }).readable, true);
});

test('S-F2b: a whole Gmail run holds the draft when get_thread answers with omittedContent or a count above its messages', async () => {
  const H0 = clone(GBASE);
  assert.equal((await grun(H0)).draft, 'allow', 'control');
  for (const thread of [(v) => ({ ...v, omittedContent: 'Some content was filtered: 1 message' }), (v) => ({ ...v, messageCount: v.messageCount + 1 }), (v) => ({ ...v, messageCount: v.messageCount + 5 })]) {
    const H = clone(GBASE);
    const r = await grun(H, { thread });
    assert.notEqual(r.draft, 'allow', JSON.stringify(r));
    assert.match(r.held || '', /your mailbox couldn't be read/);
  }
});

test('S-F3: the search holds when its count of matches is above the conversations it shows, or is not a number', async () => {
  const SO = { own: [OWN], contact: ANA, sinceMs: Date.parse('2026-10-12T07:45:00Z'), ownId: 'm1', ownThread: 'T1' };
  const s = (est) => mailFromWitness(text({ resultCountEstimate: est, threads: [TH()] }), SO);
  for (const est of ['1', '0', 1]) assert.equal(s(est).readable, true, String(est));
  for (const est of ['2', '75', 75]) {
    const r = s(est);
    assert.equal(r.readable, false, String(est));
    assert.match(r.why, /the search says it matched \d+ conversations but shows 1/);
  }
  for (const est of ['many', '1.5', '', ' ', '-1']) assert.equal(s(est).readable, false, JSON.stringify(est));
  const H = clone(GBASE);
  const r = await grun(H, { search: (v) => ({ ...v, resultCountEstimate: '75' }) });
  assert.notEqual(r.draft, 'allow', JSON.stringify(r));
  assert.match(r.held || '', /matched 75 conversations/);
});

test('S-N2: the search is pinned to the metadata-only view: no subject or snippet reaches the run, and a search without it is refused', async () => {
  assert.equal(gmailReads({ connectors: { 'email.messages': { server: G, tool: 'search_threads' } } }).from.args.view, 'THREAD_VIEW_METADATA_ONLY');
  // The stand-in, as the real connector: the default view gives subject and snippet; the pinned one doesn't.
  const H = clone(GBASE);
  const q = { query: `to:${ANA}`, pageSize: 50 };
  assert.ok('subject' in gcall(H, 'search_threads', q).threads[0].messages[0]);
  const meta = gcall(H, 'search_threads', { ...q, view: 'THREAD_VIEW_METADATA_ONLY' }).threads[0].messages[0];
  assert.ok(!('subject' in meta) && !('snippet' in meta), JSON.stringify(meta));
  // A run whose model leaves the view out, or asks for another, is refused at the search.
  for (const view of [undefined, 'THREAD_VIEW_MINIMAL']) {
    const H2 = clone(GBASE);
    const r = await grun(H2, {
      args: (a, n) => {
        if (n !== 'search_threads') return a;
        const { view: _v, ...rest } = a;
        return view ? { ...rest, view } : rest;
      }
    });
    assert.ok(r.refused, `view ${view}: ${JSON.stringify(r)}`);
    assert.equal(r.refused.code, 2);
  }
});
