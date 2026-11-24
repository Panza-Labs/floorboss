// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The final approval's picks 2 and 3 (lib/autosend/pick.mjs), as the flow carries on after them (sim run 3, P2c, P2d,
// P3b): after "put them all in my Gmail drafts" or "I'll send them myself", flow next never offers a send of those
// messages (send_one, email.send), message 1 or a follow-up, and says plainly where they are and who sends them. A
// later pick 1 for a fresh readback still goes the auto-send way. In Claude Code (a daily Claude routine) and in Codex.
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeHome, drive, simplePersona, ROOT } from './sims/lib/driver.mjs';
import { PICKS } from '../lib/autosend/pick.mjs';
import { envFor, addLines, ledgerLines, approvedLines } from './fixtures/autosend-world.mjs';
import { offersCopy, mailOf } from '../skills/event-outreach/scripts/outbox.mjs';

const SLUG = 'test-expo';
const OWN = 'priya@tidewell.example';
const LIST = 'Name,Title,Company,Email\nMarta Okoye,VP Operations,Saltmarsh Foods,marta@saltmarsh.example\nRaj Patel,Director of Logistics,Northgate Freight,raj@northgate.example\n';
const CODEX = { CODEX_SESSION_ID: 'codex-sess', CODEX_THREAD_ID: 'codex-thread' };
const recipe = (server, tool, args, extra = {}) => ({ server, tool, args, tool_hash: 'b'.repeat(64), reading: 'x', probe: { ok: true }, ...extra });
const RECIPES = {
  'email.history': recipe('claude_ai_Gmail', 'search_threads', { query: 'from:{email} OR to:{email}' }),
  'email.messages': recipe('claude_ai_Gmail', 'search_threads', { query: 'from:{email} in:anywhere' }),
  'email.send': recipe('claude_ai_Gmail', 'send_message', { to: '{to}', subject: '{subject}', body: '{body}' }, { reading: 'the id and threadId it returns', test_draft: { draft_id: 'm-test', user_confirmed: true } })
};
const GMAIL = ['search_threads', 'get_thread', 'list_drafts', 'create_draft', 'get_draft', 'list_labels', 'send_message'].map((n) => `mcp__claude_ai_Gmail__${n}`);

const envOf = (H, claude) => ({ ...envFor(H.HOME, { claude, now: H.now }), FLOORBOSS_SCAN_HOME: join(H.HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(H.HOME, 'scan-home') });
function run(H, claude, skill, args, input = null) {
  const r = spawnSync('node', [join(ROOT, skill), ...args], { env: envOf(H, claude), encoding: 'utf8', ...(input ? { input } : {}) });
  if (r.status !== 0) return { ERROR: String(r.stderr || r.stdout).slice(0, 1500) };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ERROR: `not JSON: ${r.stdout.slice(0, 300)}` };
  }
}
const asCli = (H, claude, args) => run(H, claude, 'skills/autosend/scripts/cli.mjs', args);
const flow = (H, claude, args) => run(H, claude, 'skills/flow/scripts/cli.mjs', args);
const wordsFile = (H, words) => {
  const f = join(H.HOME, 'work', `said-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(f, words);
  return f;
};

// The run up to the final approval: Claude Code with the claude.ai Gmail connector (auto-send through a daily Claude
// routine), or Codex with auto-send from the cloud. Driven once per host; each test works on a copy.
function toSecondYes(claude) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' }, attendees: LIST });
  H.env = claude ? { ...H.env, CLAUDECODE: '1' } : { ...H.env, ...CODEX };
  if (!claude) delete H.env.CLAUDECODE;
  const saveRecipe = (task) => {
    const r = RECIPES[task];
    if (!r) return false;
    const f = join(H.HOME, 'config.json');
    const c = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
    c.connectors = { ...(c.connectors || {}), [task]: r };
    writeFileSync(f, JSON.stringify(c));
    return true;
  };
  let pendingSend = false;
  let on = false;
  const asks = claude
    ? { account_intake: 'emails', show_intake: 'file', tools: { crm: 'none', mailbox: true, calendar: false }, sending: 'email (your connected mailbox)', send_setup: () => ((pendingSend = true), { own_email: OWN, done: true }), followups_mode: 'scheduled: each goes on its day' }
    : { account_intake: 'none', show_intake: 'file', sending: 'yes, send them from my Gmail', send_setup: OWN, followups_mode: 'scheduled' };
  const persona = simplePersona({
    asks: { setup_level: 'standard', list_source: join(H.HOME, 'inputs', 'attendees.csv'), touches: '3', check_these: (s) => s.ask.people.map((p) => `${p.id} different-person all`).join('\n'), rate: 'skip', daily_task: "yes, it's created", ...asks },
    judge: {
      scan: () => ({ tools: claude ? GMAIL : [] }),
      mail_history: () => ({ people: [] }),
      check_replies: (read) => ({ people: (read.people || read).map((p) => ({ id: p.id, messages: [] })) }),
      check_replies_one: (read) => ({ people: (read.people || read).map((p) => ({ id: p.id, messages: [] })) })
    }
  });
  persona.connect = (s) => {
    const ok = saveRecipe(s.task);
    if (ok && s.task === 'email.history') saveRecipe('email.messages');
    return ok ? { task: s.task, answer: 'try again' } : { task: s.task, answer: `no ${s.task} tool in this setup, don't use it` };
  };
  const r = drive(H, persona, {
    maxSteps: 300,
    onStep: (s) => {
      if (pendingSend) {
        pendingSend = false;
        saveRecipe('email.send');
      }
      // Claude Code: the user asks for the follow-ups to go by themselves (the model runs on, as the skill says).
      if (claude && s.ask?.id === 'touches' && !on) {
        on = true;
        const o = asCli(H, true, withSeen(H.HOME, ['on', '--event', SLUG, '--said-file', wordsFile(H, 'yes, send the follow-ups by themselves'), '--own', OWN]));
        assert.ok(!o.ERROR, o.ERROR);
      }
    }
  });
  assert.equal(r.last?.step, 'second_yes', JSON.stringify(r.trail?.slice(-8)));
  return H;
}
const BASE = {};
const homeFor = (claude) => {
  const k = claude ? 'cc' : 'codex';
  BASE[k] ||= toSecondYes(claude);
  const H0 = BASE[k];
  const HOME = mkdtempSync(join(tmpdir(), 'fb-pick-'));
  cpSync(H0.HOME, HOME, { recursive: true });
  return { ...H0, HOME, env: { ...H0.env, FLOORBOSS_HOME: HOME, FLOORBOSS_SCAN_HOME: join(HOME, 'scan-home'), FLOORBOSS_SCAN_CWD: join(HOME, 'scan-home') } };
};
const evDir = (H) => join(H.HOME, 'events', SLUG);

// The user's pick: in Claude Code the AskUserQuestion answer the guard's hook records; in Codex their reply.
let calls = 0;
function pick(H, claude, n) {
  const rb = asCli(H, claude, ['readback', '--event', SLUG]);
  assert.ok(!rb.ERROR && rb.messages > 0, rb.ERROR || 'nothing to read back');
  if (claude) {
    const q = rb.choice.ask_user_question;
    const input = JSON.stringify({ session_id: 'sess-pick', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: q, tool_response: { questions: q.questions, answers: { [q.questions[0].question]: PICKS[n - 1].label } }, tool_use_id: `toolu_pick_${++calls}` });
    spawnSync('node', [join(ROOT, 'hooks/guard.mjs'), 'post'], { input, env: envOf(H, true), encoding: 'utf8' });
    return asCli(H, true, withSeen(H.HOME, ['approve', '--event', SLUG, '--digest', rb.digest]));
  }
  return asCli(H, false, ['approve', '--event', SLUG, '--digest', rb.digest, '--said-file', wordsFile(H, String(n))]);
}

// flow next, followed the way the skill says, for a few steps: an ask is answered with its first option, and nothing
// that sends is ever done. Every step it gave, in order.
function steps(H, claude, n = 6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = flow(H, claude, ['next', '--event', SLUG]);
    assert.ok(!s.ERROR, s.ERROR);
    out.push(s);
    if (s.call || s.done || s.step === 'waiting') break;
    if (s.ask?.id === 'crm_contacts') {
      const f = join(H.HOME, 'work', 'crmc.json');
      writeFileSync(f, JSON.stringify('go on without them'));
      flow(H, claude, ['answer', '--event', SLUG, '--ask', 'crm_contacts', '--value-file', f]);
      continue;
    }
    break;
  }
  return out;
}
// The outbox's cards as the page is built from them (commands/cards.mjs allOutboxCards), in the host's own process.
function outboxCards(H, claude) {
  const code = `const { ctxOf } = await import(${JSON.stringify(join(ROOT, 'skills/event-outreach/scripts/commands/context.mjs'))}); const { allOutboxCards } = await import(${JSON.stringify(join(ROOT, 'skills/event-outreach/scripts/commands/cards.mjs'))}); console.log(JSON.stringify(allOutboxCards(ctxOf(${JSON.stringify(SLUG)}, {}))));`;
  const r = spawnSync('node', ['--input-type=module', '-e', code], { env: envOf(H, claude), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const sends = (ss) => ss.filter((s) => s.step === 'send_one' || s.call?.task === 'email.send');
const said = (s) => JSON.stringify([s.tell_user, s.why, s.how, s.text]);

// What pick 2's run leaves in the ledger once each message 1 is in Gmail Drafts (lib/autosend/approved-drafts.mjs).
function draftedFirsts(H) {
  const ls = ledgerLines(evDir(H)).filter((e) => e.type === 'drafts_approved' && e.touch === 1);
  addLines(evDir(H), ls.map((e, i) => ({ at: H.now, type: 'staged', who: 'floorboss', id: e.id, touch: 1, draft_id: `r${i}`, thread_id: `t${i}`, message_id: `m${i}`, tool: 'mcp__claude_ai_Gmail__create_draft', run: 'dr-test' })));
  return ls.length;
}

for (const claude of [true, false]) {
  const host = claude ? 'Claude Code' : 'Codex';

  test(`${host}: after pick 2 (Gmail drafts) flow next never sends them, and says they are in Gmail Drafts for the user`, { timeout: 900000 }, () => {
    const H = homeFor(claude);
    const ap = pick(H, claude, 2);
    assert.ok(!ap.ERROR, ap.ERROR);
    assert.equal(ap.pick, 'drafts');
    // Before the drafts run: flow next points to it, never to a send.
    const before = steps(H, claude);
    assert.deepEqual(sends(before), [], JSON.stringify(before.map((s) => s.step)));
    const last0 = before.at(-1);
    assert.match(JSON.stringify(last0), /drafts next/);
    assert.match(JSON.stringify(last0), /--for drafts/);
    // Not in Gmail Drafts yet: the outbox has no buttons for them either (they go into Drafts, never copied).
    const early = outboxCards(H, claude).filter((x) => x.kind === 'message');
    assert.ok(early.length >= 1);
    for (const c of early) assert.equal(offersCopy(c), false, JSON.stringify(c).slice(0, 300));
    // Each message 1 is in Gmail Drafts now.
    assert.ok(draftedFirsts(H) >= 1);
    const after = steps(H, claude);
    assert.deepEqual(sends(after), [], JSON.stringify(after.map((s) => s.step)));
    const last = after.at(-1);
    assert.match(said(last), /Gmail Drafts/);
    assert.match(said(last), /follow-up/i);
    assert.match(said(last), /nothing is sent automatically|never sends/i);
    // The send list holds them, so the guard has nothing of theirs to let through either.
    const sl = run(H, claude, 'skills/event-outreach/scripts/cli.mjs', ['send-list', '--event', SLUG]);
    // (In Codex floorboss sends no email itself: the send list says sending is off.)
    if (claude) {
      assert.ok(!sl.ERROR, sl.ERROR);
      assert.deepEqual(JSON.parse(readFileSync(sl.file, 'utf8')), []);
    } else assert.match(String(sl.ERROR), /Sending is off/);
    // The outbox: a message in Gmail Drafts has no send or copy buttons.
    const cards = outboxCards(H, claude);
    
    for (const c of cards.filter((x) => x.kind === 'message')) {
      assert.equal(offersCopy(c), false, JSON.stringify(c).slice(0, 300));
      assert.equal(mailOf(c), null);
    }
  });

  test(`${host}: after pick 3 (I'll send them myself) flow next never sends them; the outbox is the user's, with copy buttons`, { timeout: 900000 }, () => {
    const H = homeFor(claude);
    const ap = pick(H, claude, 3);
    assert.ok(!ap.ERROR, ap.ERROR);
    assert.equal(ap.pick, 'self');
    const ss = steps(H, claude);
    assert.deepEqual(sends(ss), [], JSON.stringify(ss.map((s) => s.step)));
    const last = ss.at(-1);
    assert.match(said(last), /outbox/);
    assert.match(said(last), /copy/);
    assert.doesNotMatch(said(last), /Gmail Drafts/);
    const cards = outboxCards(H, claude);
    
    const msgs = cards.filter((x) => x.kind === 'message');
    assert.ok(msgs.length >= 1);
    for (const c of msgs) {
      assert.equal(offersCopy(c), true, JSON.stringify(c).slice(0, 300));
      // The user sends it: the page offers to open it in their mail app too (in Claude Code as in Codex).
      assert.ok(mailOf(c), JSON.stringify(c).slice(0, 300));
    }
  });
}

test('Claude Code: after pick 3, a fresh readback (a message rewritten) and pick 1: that person goes the auto-send way', { timeout: 900000 }, () => {
  const H = homeFor(true);
  assert.equal(pick(H, true, 3).pick, 'self');
  // One person's message 2 is rewritten and approved again: only they are read back, and the user picks 1 for them.
  const people = JSON.parse(readFileSync(join(evDir(H), 'derived', 'contacts.json'), 'utf8'));
  const p = people[0];
  const t2 = ledgerLines(evDir(H)).find((e) => e.type === 'approved' && e.id === p.id && e.touch === 2);
  const plan = ledgerLines(evDir(H)).filter((e) => e.type === 'drafted' && e.id === p.id && e.touch === 2).at(-1);
  const re = approvedLines(evDir(H), { id: p.id, name: p.name, company: p.company, email: t2.to }, 2, { at: H.now, extra: ' Rewritten.', plan: { planned_due: plan.planned_due, planned_gap: plan.planned_gap, planned_from: plan.planned_from } });
  addLines(evDir(H), re.lines);
  const ap = pick(H, true, 1);
  assert.ok(!ap.ERROR, ap.ERROR);
  assert.equal(ap.pick, 'auto');
  assert.deepEqual(ap.people, [p.id]);
  // The auto-send run (what pick 1's next says to run) starts with message 1 to them, sent from this session.
  const st = asCli(H, true, withSeen(H.HOME, ['drafts', 'next', '--event', SLUG, '--run', 'new']));
  assert.ok(!st.ERROR, st.ERROR);
  assert.equal(st.step, 'send', JSON.stringify(st).slice(0, 400));
  assert.equal(st.person.id, p.id);
  // Its send list lists that one step (the routine's own release), so Claude Code's send of it can go.
  const sl = run(H, true, 'skills/event-outreach/scripts/cli.mjs', ['send-list', '--event', SLUG, '--ids', p.id]);
  assert.ok(!sl.ERROR, sl.ERROR);
  assert.deepEqual(JSON.parse(readFileSync(sl.file, 'utf8')).map((x) => `${x.id}:${x.touch}`), [`${p.id}:1`]);
  // Everyone else is still the user's: flow next offers no send of theirs.
  const ss = steps(H, true);
  assert.ok(sends(ss).every((s) => s.call?.item?.id === p.id), JSON.stringify(ss.map((s) => [s.step, s.call?.item?.id])));
});


// ---- Review of c02c899 (independent reviewer's PoCs A, B, C, E, F) ----
const EVENING = '2026-10-12T17:30:00Z'; // 19:30 in Amsterdam, a Monday: outside sending hours
const guardSend = (H, it, n) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ session_id: 'sess-x', hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: it.to, subject: it.subject, body: it.body }, tool_use_id: `toolu_rev_${n}` }), env: envOf(H, true), encoding: 'utf8' });
const lets = (g) => g.status === 0 && /"permissionDecision":"(ask|allow)"/.test(g.stdout);

test('Claude Code routine, no pick yet, outside sending hours: no send of message 1; flow next waits for sending hours', { timeout: 900000 }, () => {
  const H = homeFor(true);
  H.now = EVENING;
  const ss = steps(H, true);
  assert.deepEqual(sends(ss), [], JSON.stringify(ss.map((s) => s.step)));
  const last = ss.at(-1);
  assert.equal(last.step, 'waiting');
  assert.notEqual(last.done, true);
  assert.match(said(last), /sending hours/);
  assert.match(said(last), /choose|choice/);
  // The send list holds message 1 too: there is nothing for the guard to let through.
  const sl = run(H, true, 'skills/event-outreach/scripts/cli.mjs', ['send-list', '--event', SLUG]);
  assert.ok(!sl.ERROR, sl.ERROR);
  assert.deepEqual(JSON.parse(readFileSync(sl.file, 'utf8')), []);
});

test('Claude Code routine: pick 2, then a list change, outside sending hours: no send', { timeout: 900000 }, () => {
  const H = homeFor(true);
  assert.equal(pick(H, true, 2).pick, 'drafts');
  addLines(evDir(H), [{ at: H.now, type: 'cap', who: 'user', company: 'Nobody Ltd', value: 1 }]);
  H.now = EVENING;
  const ss = steps(H, true);
  assert.deepEqual(sends(ss), [], JSON.stringify(ss.map((s) => s.step)));
});

test('Claude Code: a send list written before pick 2 lets nothing through the guard after it', { timeout: 900000 }, () => {
  const H = homeFor(true);
  // Inside sending hours, before any pick: message 1 waits for the choice, so nothing is listed; a list written by
  // an older floorboss (or by hand) is what the guard would read.
  const people = JSON.parse(readFileSync(join(evDir(H), 'derived', 'contacts.json'), 'utf8'));
  const draftsBy = ledgerLines(evDir(H)).filter((e) => e.type === 'approved' && e.touch === 1);
  const items = draftsBy.map((a) => {
    const d = JSON.parse(readFileSync(join(evDir(H), 'drafts', `${a.hash}.json`), 'utf8'));
    return { id: a.id, touch: 1, name: people.find((p) => p.id === a.id)?.name, to: a.to, subject: d.subject, body: d.body, via: 'email.send', listed_at: H.now };
  });
  assert.equal(pick(H, true, 2).pick, 'drafts');
  writeFileSync(join(evDir(H), 'derived', 'send-list.json'), JSON.stringify(items));
  const g = guardSend(H, items[0], 1);
  assert.ok(!lets(g), g.stdout.slice(0, 400));
});

test('approve with pick 2 or 3 takes those messages off a send list written before it', { timeout: 900000 }, () => {
  const H = homeFor(true);
  writeFileSync(join(evDir(H), 'derived', 'send-list.json'), JSON.stringify([{ id: 'c001', touch: 1, to: 'x@y.example' }, { id: 'c999', touch: 1, to: 'z@y.example' }]));
  assert.equal(pick(H, true, 3).pick, 'self');
  assert.deepEqual(JSON.parse(readFileSync(join(evDir(H), 'derived', 'send-list.json'), 'utf8')).map((x) => x.id), ['c999']);
});

test('standingPick: an older pick 1 never comes back when a newer pick 2 lapses', async () => {
  const { standingPick } = await import(join(ROOT, 'lib/autosend/approval.mjs'));
  const x = { id: 'c001', hash: 'h1' };
  const L = [{ type: 'autosend_approved', id: x.id, touch: 1, hash: x.hash }, { type: 'cap' }, { type: 'drafts_approved', id: x.id, touch: 1, hash: x.hash }, { type: 'cap' }];
  assert.equal(standingPick(L.slice(0, 1), x.id, 1, x.hash), 'auto');
  assert.equal(standingPick(L.slice(0, 2), x.id, 1, x.hash), null);
  assert.equal(standingPick(L.slice(0, 3), x.id, 1, x.hash), 'drafts');
  assert.equal(standingPick(L, x.id, 1, x.hash), null);
});

// Pick 1 ran: message 1 sent from this session, each follow-up a Gmail draft queued for the daily routine.
function afterPick1Run(H) {
  assert.equal(pick(H, true, 1).pick, 'auto');
  const yes = ledgerLines(evDir(H)).filter((e) => e.type === 'autosend_approved');
  const add = [];
  for (const id of [...new Set(yes.map((e) => e.id))]) {
    const y1 = yes.find((e) => e.id === id && e.touch === 1);
    add.push({ at: H.now, type: 'autosend_released', who: 'floorboss', id, touch: 1, hash: y1.hash, to: y1.to, run: 'cc-x', host: 'claude-code' });
    add.push({ at: H.now, type: 'call_result', who: 'guard', id, touch: 1, kind: 'send', message_id: `m-${id}`, thread_id: `t-${id}` });
    add.push({ at: H.now, type: 'sent', who: 'guard', id, touch: 1, via: 'email.send', date: H.now.slice(0, 10), message_id: `m-${id}`, thread_id: `t-${id}`, hash: y1.hash, channel: 'email' });
    for (const y of yes.filter((e) => e.id === id && e.touch > 1))
      add.push({ at: H.now, type: 'autosend_drafted', who: 'floorboss', id, touch: y.touch, hash: y.hash, to: y.to, due: y.planned_due, draft_id: `d-${id}-${y.touch}`, message_id: `dm-${id}-${y.touch}`, thread_id: `t-${id}`, threaded: true, run: 'cc-x' });
  }
  addLines(evDir(H), add);
  return add.filter((e) => e.type === 'autosend_drafted');
}

for (const second of [2, 1]) {
  test(`Claude Code routine: drafts queued at pick 1, then a list change: the routine drops them, the delete steps come, and only once they are gone is pick ${second} offered${second === 2 ? ' (no second copy in Drafts)' : ' (they are drafted again)'}`, { timeout: 900000 }, async () => {
    const H = homeFor(true);
    const drafted = afterPick1Run(H);
    const { routineQueue, routineDeletes } = await import(join(ROOT, 'lib/autosend/routine.mjs'));
    const { approvedPlan } = await import(join(ROOT, 'lib/autosend/approved-drafts.mjs'));
    const nowMs = Date.parse(H.now);
    assert.equal(routineQueue(evDir(H), nowMs).items.length, drafted.length);
    addLines(evDir(H), [{ at: H.now, type: 'cap', who: 'user', company: 'Nobody Ltd', value: 1 }]);
    // The yes no longer stands: the routine's list leaves the drafts out, and each gets its delete step.
    assert.deepEqual(routineQueue(evDir(H), nowMs).items, []);
    assert.deepEqual(routineDeletes(evDir(H), nowMs).map((x) => x.draft_id).sort(), drafted.map((x) => x.draft_id).sort());
    // The readback offers none of the drafted steps while their drafts may still be in Gmail, and says why.
    const rb = asCli(H, true, ['readback', '--event', SLUG]);
    assert.ok(!rb.ERROR, rb.ERROR);
    assert.equal(rb.messages, 0, rb.text);
    assert.ok(rb.refused.some((x) => /Gmail draft/.test(x.why)), JSON.stringify(rb.refused));
    assert.ok(Array.isArray(rb.drafts_delete) && rb.drafts_delete.length === drafted.length, JSON.stringify(rb).slice(0, 400));
    // The user deletes them (the guard records each delete_draft's answer): then the readback offers them again.
    addLines(evDir(H), drafted.map((d) => ({ at: H.now, type: 'autosend_draft_deleted', who: 'guard', id: d.id, touch: d.touch, draft_id: d.draft_id, how: 'delete_draft' })));
    const ap = pick(H, true, second);
    assert.ok(!ap.ERROR, ap.ERROR);
    if (second === 2) {
      assert.equal(ap.pick, 'drafts');
      assert.equal(approvedPlan(evDir(H), 'drafts', 'claude-code', nowMs).queue.length, drafted.length);
      assert.deepEqual(routineQueue(evDir(H), nowMs).items, []);
    } else {
      assert.equal(ap.pick, 'auto');
      assert.equal(approvedPlan(evDir(H), 'auto', 'claude-code', nowMs).queue.filter((q) => q.step === 'draft').length, drafted.length);
    }
  });
}

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, approve is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('approve');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
