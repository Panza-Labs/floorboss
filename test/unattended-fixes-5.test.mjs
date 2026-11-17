// The fifth round of the unattended email drafts review (verify3, fix round 4, 2026-11-15): one test per item, each
// failing on the code with its fix taken out (FIX-1.md in the session's unattended-fix4 scratchpad says how each was
// shown). Through the real guard, flow, launcher, sync and the gmail-real stand-in (over MCP stdio) in throwaway homes;
// nothing here starts Claude Code, launchctl or a real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  world,
  clone,
  ticket,
  start,
  readMail,
  stageItem,
  stage,
  draftInput,
  inRun,
  afterRun,
  hook,
  logOf,
  ledgerOf,
  text,
  bashCall,
  scriptCmd,
  gcall,
  gdata,
  G,
  MAIL_OK,
  OWN,
  ANA,
  ROOT,
  D13
} from './fixtures/unattended-world.mjs';
import { cli } from './fixtures/harness.mjs';
import { mailFromWitness } from '../hooks/guard/witness.mjs';
import { scheduleRefusal } from '../hooks/guard.mjs';
import { readSince, buildSummary, gmailReads } from '../lib/unattended-drafts.mjs';
import { planSync } from '../skills/event-outreach/scripts/sync.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';

const BASE = world();
const BASE2 = world({ two: true });
const GBASE = world({ gmail: true });
const ITEMS = (await ticket(clone(BASE))).items;
const D14 = '2026-10-14T08:00:00Z';
const at = (iso, s) => new Date(Date.parse(iso) + s * 1000).toISOString();
const tool = (n) => `mcp__${G}__${n}`;
const fill = (args, values) => JSON.parse(JSON.stringify(args).replace(/\{([a-z_]+)\}/g, (m, k) => values[k] ?? m));
const edit = (p, fn) => writeFileSync(p, fn(readFileSync(p, 'utf8')));
const refused = (r, re) => {
  assert.ok(r, 'expected a refusal, but the call was let through');
  assert.equal(r.code, 2, `expected a refusal, got ${r.code} ${r.decision} ${r.stderr}`);
  if (re) assert.match(r.stderr, re);
};
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
// A Gmail run as its model makes it (as in unattended-fixes-4). answer(tool, args): the tool_response the guard's post
// hook gets; draft(it): the draft call's arguments.
async function grun(H, { answer = (n, args) => text(gcall(H, n, args)), draft = (it) => ({ to: [it.to], subject: it.subject, body: it.body, replyToMessageId: it.reply_to_message_id }) } = {}) {
  const t = await ticket(H);
  assert.equal(start(H, t).code, 0);
  for (let i = 0; i < 8; i++) {
    const n = next(H, t);
    if (n.step === 'read_mail' || n.step === 'read_mail_from') {
      const args = fill(n.call.recipe.args, n.call.values);
      const pre = inRun(H, t, tool(n.call.recipe.tool), args, { id: `r${i}` });
      if (pre.decision !== 'allow') return { t, refused: pre };
      afterRun(H, t, tool(n.call.recipe.tool), args, answer(n.call.recipe.tool, args), { id: `r${i}` });
    } else if (n.step === 'stage_one') {
      const args = draft(n.call.item);
      const pre = inRun(H, t, tool('create_draft'), args, { id: `s${i}` });
      if (pre.decision !== 'allow') return { t, refused: pre, args };
      afterRun(H, t, tool('create_draft'), args, text(gcall(H, 'create_draft', args)), { id: `s${i}` });
      return { t, allowed: true, args };
    } else return { t, last: n };
  }
  return { t };
}
const released = (H, touch = 2) => ledgerOf(H).some((e) => e.type === 'stage_released' && e.touch === touch);
const heldWhy = (H) => logOf(H).filter((e) => e.type === 'held').map((e) => e.why).join(' | ');
const flat = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\n\s*(>\s*)?/g, ' ').replace(/\s+/g, ' ');
// Drafts mode (no email sending): the attended stage list lists follow-ups too.
const draftsMode = (H) =>
  edit(join(H.dir, 'event.json'), (s) => {
    const e = JSON.parse(s);
    e.settings.sending = { channels: [], followups: 'scheduled' };
    return JSON.stringify(e);
  });
const UNPROVEN = /floorboss's search of your mailbox didn't find your own last email to them, so it can't trust that search/;

test('F4-P1a: the Gmail search is from or to them, and its witness is clean only when it shows your own last email to them', () => {
  // The fixed query, from or to them ({a b} is Gmail's "a or b"), pinned as before.
  assert.equal(gmailReads({ connectors: { 'email.messages': { server: G, tool: 'search_threads' } } }).from.args.query, 'in:anywhere {from:{email} to:{email}} after:{since_epoch}');
  // The witness alone. so: the search's start, your message 1 by its id, and its thread.
  const so = { own: [OWN], contact: ANA, sinceMs: Date.parse('2026-10-12T07:45:00Z'), ownId: 'm1', ownThread: 'T1' };
  const msg = (id, sender, date, to = [ANA], labels = ['SENT']) => ({ id, sender, toRecipients: to, ccRecipients: [], bccRecipients: [], date, labelIds: labels });
  const th = (id, messages, count = messages.length) => ({ id, messageCount: count, messages });
  const m1 = msg('m1', OWN, '2026-10-12T08:00:00Z');
  const w = (threads, o = so) => mailFromWitness(text(threads == null ? {} : { threads }), o);
  const pick = (x) => [x.readable, x.inbound, x.others, x.own_after];
  // {} and { threads: [] }: the search doesn't show your email, so it is no clean read, said plainly.
  for (const v of [null, []]) {
    assert.equal(w(v).readable, false, JSON.stringify(v));
    assert.match(w(v).why, UNPROVEN);
    assert.equal(w(v).plain, true);
  }
  // Your message 1, by its id: clean.
  assert.deepEqual(pick(w([th('T1', [m1])])), [true, 0, 0, 0]);
  // With no id recorded: a message of yours dated at or after the start counts; one before it doesn't.
  assert.equal(w([th('T1', [m1])], { ...so, ownId: null }).readable, true);
  assert.equal(w([th('T1', [msg('m0', OWN, '2026-10-12T07:00:00Z')])], { ...so, ownId: null }).readable, false);
  // Them after the start holds; an older message of theirs in your own thread doesn't. (Fix round 5: in another
  // conversation a message of theirs holds whatever its date, test/unattended-fixes-7.test.mjs F6-S2-1.)
  assert.equal(w([th('T1', [m1, msg('r1', ANA, '2026-10-12T15:00:00Z', [OWN], ['INBOX'])])]).inbound, 1);
  assert.deepEqual(pick(w([th('T1', [msg('r0', ANA, '2026-10-01T15:00:00Z', [OWN], ['INBOX']), m1])])), [true, 0, 0, 0]);
  assert.equal(w([th('T1', [m1]), th('T0', [msg('r0', ANA, '2026-10-01T15:00:00Z', [OWN], ['INBOX'])])]).inbound, 1);
  // Someone else in a conversation with them: held too.
  assert.equal(w([th('T1', [m1]), th('T3', [msg('c1', 'lee@acme.test', '2026-10-12T15:00:00Z', [ANA, OWN], ['INBOX'])])]).others, 1);
  // An email you wrote to them yourself after message 1: own_after; one to someone else only: not.
  assert.equal(w([th('T1', [m1]), th('T4', [msg('h1', OWN, '2026-10-12T12:00:00Z')])]).own_after, 1);
  assert.equal(w([th('T1', [m1]), th('T4', [msg('h1', OWN, '2026-10-12T12:00:00Z', ['bo@bolt.test'])])]).own_after, 0);
  // A conversation that shows fewer messages than it holds can't be read, unless it is your own thread (read whole by
  // get_thread); one with no count, or anything beside the conversations, can't either.
  assert.equal(w([th('T1', [m1], 7)]).readable, true);
  assert.equal(w([th('T1', [m1]), th('T5', [msg('r5', ANA, '2026-10-12T15:00:00Z', [OWN], ['INBOX'])], 6)]).readable, false);
  assert.equal(w([{ id: 'T1', messages: [m1] }]).readable, false);
  assert.equal(mailFromWitness(text({ threads: [th('T1', [m1])], resultSizeEstimate: 1 }), so).readable, false);
});

test('F4-P1b: the gmail-real stand-in reads {a b} as a or b', () => {
  {
    const H = clone(GBASE);
    gdata(H, (d) => ({ ...d, mail: { ...d.mail, threads: [{ thread_id: 't-new', to: OWN, subject: 'Lunch?', replies: [{ from: ANA, at: '2026-10-12T16:00:00Z' }] }] } }));
    const ids = (q) => (gcall(H, 'search_threads', { query: q }).threads || []).map((x) => x.id).sort();
    assert.deepEqual(ids(`{from:${ANA} to:${ANA}}`), [H.m1.threadId, 't-new'].sort());
    assert.deepEqual(ids(`from:${ANA}`), ['t-new']);
  }
});

test('F4-P1c: a connector that ignores a search word answers {}: held, said plainly, and no draft goes in', async () => {
  // End to end: a connector that doesn't know after: or in:anywhere (read as text, matching nothing) answers {}. Held,
  // said plainly, and no draft goes in.
  for (const word of ['after:', 'in:anywhere']) {
    const H = clone(GBASE);
    gdata(H, (d) => ({ ...d, mail: { ...d.mail, unread_words: [word] } }));
    await grun(H);
    assert.ok(!released(H), `${word}: no draft`);
    assert.match(heldWhy(H), UNPROVEN, word);
    assert.doesNotMatch(heldWhy(H), /couldn't be (read|searched)/, word);
  }
  // The clean world still goes in.
  assert.equal((await grun(clone(GBASE))).allowed, true);
});

test('F4-P1d: an email you wrote to them yourself since floorboss\'s last one holds the draft', async () => {
  // You wrote to Ana yourself after message 1, in a new conversation: held.
  {
    const H = clone(GBASE);
    gdata(H, (d) => ({ ...d, mail: { ...d.mail, threads: [{ thread_id: 't-hand', message_id: 'm-hand', to: ANA, subject: 'One more thing', sent_at: '2026-10-12T12:00:00Z' }] } }));
    await grun(H);
    assert.ok(!released(H));
    assert.match(heldWhy(H), /you wrote to them yourself since floorboss's last email/);
  }
});

test('F4-P1e: README, the opt-in command and SECURITY.md say the search must show your own email', () => {
  assert.match(flat('README.md'), /The search must find your own last email to them, or the draft is held, and anything from them, or an email you wrote them yourself since, holds it too\./);
  assert.match(flat('commands/unattended.md'), /a search for anything from or to them in any thread, which must find your own last email to them or the draft waits/);
  assert.match(flat('SECURITY.md'), /An empty answer, or one without your email, holds the draft as a search floorboss can't trust\./);
  // (fix round 4, round 2: the limit names from: too, and the docs no longer say Spam and Trash are searched.)
  // (fix round 5: real calls showed in:anywhere leaves Spam out, test/unattended-fixes-7.test.mjs F6-docs.)
  assert.match(flat('SECURITY.md'), /covers Trash but leaves out Spam/);
});

test('F4-R1-N2a: sync never files a message id floorboss has for another step as a draft\'s send', async () => {
  // sync, alone: a sent message with message 1's id that matches follow-up 1's draft by its subject is not follow-up 1.
  const plan = (filed) =>
    planSync([{ id: 'c001', items: [{ ext: 'mid-1', at: '2026-10-13T14:00:00Z', kind: 'message', direction: 'out', subject: 'Test Expo', text: 'x', thread: 'T1' }] }], {
      state: { c001: { sent: { 1: '2026-10-12' }, ext: [], touches: {} } },
      since: { c001: '2026-10-01T00:00:00Z' },
      source: 'mailbox',
      now: new Date('2026-10-14T08:00:00Z'),
      byId: { c001: { name: 'Ana Berg', company: 'Acme', email: ANA } },
      zone: 'Europe/Amsterdam',
      drafts: { c001: [{ touch: 2, at: Date.parse('2026-10-13T08:00:00Z'), thread: 'T1', message_id: null, subject: 'Test Expo', body: 'Hello Ana, a follow-up about Test Expo next month.' }] },
      filed
    });
  assert.deepEqual(plan({ c001: [{ touch: 1, message_id: 'mid-1' }] }).entries.filter((e) => e.type === 'sent'), []);
  assert.equal(plan({ c001: [{ touch: 1, message_id: 'mid-other' }] }).entries.filter((e) => e.type === 'sent' && e.touch === 2).length, 1, 'another id: it is follow-up 1');
  // The real sync: Tue 13, follow-up 1 goes into the drafts on its own; a mailbox sync file then says it went with
  // message 1's id. It isn't filed as sent.
  const H = clone(GBASE);
  assert.equal((await grun(H)).allowed, true);
  const d2 = JSON.parse(readFileSync(join(H.HOME, 'standin.json.drafts.json'), 'utf8')).find((d) => d.to === ANA);
  const now = '2026-10-13T15:00:00Z';
  bashCall(H, scriptCmd('event-outreach', 'sync-list', '--event', H.slug, '--source', 'mailbox'), { session: 's-att3', now });
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  const f = join(H.HOME, 'work', 'sync.json');
  writeFileSync(f, JSON.stringify({ people: [{ id: H.ana, messages: [{ message_id: H.m1.id, at: '2026-10-13T14:00:00Z', direction: 'out', subject: d2.subject, to: ANA, from: OWN }] }] }));
  const sy = bashCall(H, scriptCmd('event-outreach', 'sync', '--event', H.slug, '--source', 'mailbox', '--file', f), { session: 's-att3', now });
  assert.equal(sy.pre.code, 0, sy.pre.stderr);
  assert.deepEqual(ledgerOf(H).filter((e) => e.type === 'sent' && e.id === H.ana && e.touch === 2), [], String(sy.stdout).slice(0, 400));
});

test('F4-R1-N2b: on Gmail, a draft replying to your latest own message, but one older than the earlier email\'s start, is held', async () => {
  // Tue 13: follow-up 1 goes into the drafts on its own, as above.
  const H = clone(GBASE);
  assert.equal((await grun(H)).allowed, true);
  const now = '2026-10-13T15:00:00Z';
  // The guard: a sent record written some other way with message 1's id for follow-up 1. On Wed 14, follow-up 2's
  // draft would reply to message 1, which is your latest own message in the thread but older than follow-up 1's
  // release: held, even with a search answer that shows message 1.
  const H2 = clone(H);
  appendFileSync(join(H2.dir, 'ledger.jsonl'), `${JSON.stringify({ at: now, type: 'sent', id: H2.ana, touch: 2, date: '2026-10-13', source: 'mailbox', message_id: H2.m1.id, thread_id: H2.m1.threadId })}\n`);
  // (Follow-up 1's draft left the thread: a draft still in it holds the thread read on its own, test/unattended-fixes-8.)
  writeFileSync(join(H2.HOME, 'standin.json.drafts.json'), '[]');
  H2.now = D14;
  const m1 = gcall(H2, 'get_thread', { threadId: H2.m1.threadId, messageFormat: 'METADATA_ONLY' }).messages.find((x) => x.id === H2.m1.id);
  const r = await grun(H2, {
    answer: (n, args) => (n === 'search_threads' ? text({ threads: [{ id: H2.m1.threadId, messageCount: 1, messages: [m1] }] }) : text(gcall(H2, n, args)))
  });
  assert.equal(r.args?.replyToMessageId, H2.m1.id, `the stage list names message 1: ${JSON.stringify(r.last || r.refused?.stderr || '')}`);
  refused(r.refused, /the message this draft would reply to isn't your latest email in your thread with them since floorboss let your last one through/);
  assert.ok(!released(H2, 3));
});

test('F4-R1-N2c: on Gmail, a draft replying to an own message that isn\'t your latest in the thread is held', async () => {
  // A later own message in the thread (you wrote again by hand after message 1): message 1 is no longer your
  // latest, so a draft replying to it is held, even with a search answer that shows only message 1.
  const H3 = clone(GBASE);
  gdata(H3, (d) => ({ ...d, mail: { ...d.mail, threads: [{ thread_id: H3.m1.threadId, message_id: 'm-hand2', to: ANA, subject: 'Re: Test Expo', sent_at: '2026-10-12T12:00:00Z' }] } }));
  const m13 = gcall(H3, 'get_thread', { threadId: H3.m1.threadId, messageFormat: 'METADATA_ONLY' }).messages.find((x) => x.id === H3.m1.id);
  const r3 = await grun(H3, {
    answer: (n, args) => (n === 'search_threads' ? text({ threads: [{ id: H3.m1.threadId, messageCount: 2, messages: [m13] }] }) : text(gcall(H3, n, args)))
  });
  refused(r3.refused, /the message this draft would reply to isn't your latest email in your thread with them/);
  assert.ok(!released(H3));
});

test('F4-R1-N3: the search starts at the guard\'s time only when that time can be the send\'s; else the day before', () => {
  const p = (x) => ({ touches: { 1: { approved: { to: ANA }, sent: { date: '2026-10-12', thread_id: 'T1' }, ...x } } });
  const r = (x) => {
    const s = readSince(p(x), 2, ANA);
    return [s.exact, new Date(s.from_s * 1000).toISOString()];
  };
  // Released again on Tue after a send on Mon (sent_undone, then let through again): after the send's record.
  assert.deepEqual(r({ released_at: '2026-10-13T08:00:00Z', sent_at: '2026-10-12T08:05:00Z' }), [false, '2026-10-11T00:00:00.000Z']);
  // A release past the end of the send's day, with a day's slack, even before a late receipt.
  assert.deepEqual(r({ stage_released: { at: '2026-10-15T09:00:00Z' }, sent_at: '2026-10-16T10:00:00Z' }), [false, '2026-10-11T00:00:00.000Z']);
  // As before: the guard let it through before the send, and the receipt came days later.
  assert.deepEqual(r({ released_at: '2026-10-12T08:00:00Z', sent_at: '2026-10-15T09:00:00Z' }), [true, '2026-10-12T07:45:00.000Z']);
  // Within the day's slack (an event west of UTC whose day is still the 12th).
  assert.deepEqual(r({ released_at: '2026-10-13T09:00:00Z', sent_at: '2026-10-13T10:00:00Z' }), [true, '2026-10-13T08:45:00.000Z']);
  // No receipt time: never exact.
  assert.deepEqual(r({ released_at: '2026-10-12T08:00:00Z' }), [false, '2026-10-11T00:00:00.000Z']);
});

// The shell name rules, from a folder outside the plugin (inside it, node with the guard named is refused already).
const AWAY = mkdtempSync(join(tmpdir(), 'fb-n4-cwd-'));
const outside = (fn) => {
  const was = process.cwd();
  process.chdir(AWAY);
  try {
    return fn();
  } finally {
    process.chdir(was);
  }
};
const NH = clone(BASE);
const refusedHere = (cmd) => outside(() => inHome(NH, () => scheduleRefusal(cmd)));

test('F4-R1-N4a: node on a file named guard.mjs with a hook word is refused, in any folder', () => {
  for (const cmd of [
    `echo '{"hook_event_name":"PostToolUse"}' | node /tmp/fbx/hooks/guard.mjs`,
    `H=hooks; echo x | node ${ROOT}/$H/guard.mjs post`,
    `echo x | node ${ROOT}/hook?/guard.mjs post`,
    `cat in.json | node /opt/someone/copy/hooks/guard.mjs start`,
    `cat in.json | node ./guard* failure`
  ])
    assert.ok(refusedHere(cmd), cmd);
});

test('F4-R1-N4b: a link of the plugin folder (ln -s) is refused', () => {
  for (const cmd of [`ln -s ${ROOT} /tmp/fbx`, `ln -sf "\${CLAUDE_PLUGIN_ROOT}" ~/fbx`, `ln -s ${ROOT}/hooks /tmp/h`]) assert.ok(refusedHere(cmd), cmd);
});

test('F4-R1-N4c: a write to the ledger named with a wildcard on its end is refused', () => {
  assert.ok(refusedHere('printf x >> ~/.floorboss/events/ev/ledger.json?'));
  assert.ok(refusedHere('rm ~/.floorboss/events/ev/release*/stage-c001-2-b1'));
});

test('F4-R1-N4d: ~, $HOME and ${HOME} are read as the home folder before matching', () => {
  // A data folder whose name doesn't say floorboss, written to through ~ or $HOME.
  const fbHome = join(process.env.HOME, 'fbdata');
  for (const cmd of ['printf x >> ~/fbdata/events/ev/ledger.jsonl', 'printf x >> $HOME/fbdata/events/ev/ledger.jsonl', 'rm "${HOME}/fbdata/events/ev/released/stage-c001-2-b1"'])
    assert.ok(outside(() => inHome({ HOME: fbHome }, () => scheduleRefusal(cmd))), cmd);
});

test('F4-R1-N4e: commands that only name these, or link something else, still pass', () => {
  for (const cmd of ['ln -s ~/projects/app /tmp/app', 'git log -p hooks/guard.mjs', 'grep -n post hooks/guard.mjs', 'node build.mjs post', `cat ${join(NH.HOME, 'events', 'ev', 'ledger.jsonl')}`])
    assert.equal(refusedHere(cmd), null, cmd);
});

test('F4-R1-N4f: through the guard, the plugin named by its /tmp form or with // and /./ is still the plugin', () => {
  const H = NH;
  // Through the guard, with the plugin at a /private/tmp path, named by its /tmp form or with // and /./ in it (no hook
  // word in the command), from a session that never ran floorboss. A path that isn't the plugin's passes.
  const ROOT2 = '/private/tmp/fb-n4-root';
  const bash = (command) => hook(H, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 'sess-second', tool_use_id: 'toolu_N4' }, { now: D13, env: { CLAUDE_PLUGIN_ROOT: ROOT2 } });
  for (const cmd of ['cat in.json | node /tmp/fb-n4-root/hooks/guard.mjs', 'cat in.json | node /private/tmp//fb-n4-root/./hooks/guard.mjs']) refused(bash(cmd), /runs floorboss's own guard hook from a shell/);
  assert.equal(bash('cat in.json | node /tmp/fb-n4-other/hooks/guard.mjs').code, 0);
});

test('F4-R1-N4g: SECURITY.md says what the rule reads, and that it is still a name rule', () => {
  // SECURITY.md says what it reads, and that it is still a name rule.
  assert.match(flat('SECURITY.md'), /Before matching it reads `~` and `\$HOME` as your home folder, `\/\/` and `\/\.\/` as `\/`, and `\/private\/tmp` as `\/tmp`\. Like the other name rules it reads text, not the shell, so a path built some other way isn't seen/);
});

test('F4-R1-N5: two people with timing holds today go on the ticket least recently tried first', () => {
  const H = clone(BASE2);
  const s = 'a1b2c3d4-0000-4000-8000-000000000001';
  const hold = (id, time) => ({ at: `2026-10-13T${time}:00.000Z`, type: 'held', session: s, event: H.slug, id, touch: 2, why: "the mailbox wasn't read for them by this run in the last 90 seconds", retry: true });
  const order = (log) => inHome(H, () => followupsDue(Date.parse('2026-10-13T12:00:00Z'), log)).items.map((x) => x.id);
  assert.deepEqual(order([hold(H.ana, '07:02'), hold(H.bo, '08:02'), hold(H.ana, '09:02')]), [H.bo, H.ana]);
  assert.deepEqual(order([hold(H.ana, '07:02'), hold(H.bo, '09:02')]), [H.ana, H.bo]);
  // Nobody held: as listed.
  assert.deepEqual(order([]), [H.ana, H.bo]);
});

test('F4-R1-N6a: no "tries again" on the step\'s last day', async () => {
  // A hold for timing only on Wed 14, the last day follow-up 1 (due Tue 13) can go in on its own: the guard notes that
  // day, and the summary doesn't say floorboss tries again. On Tue 13 it does.
  for (const [now, again] of [
    [D14, false],
    [D13, true]
  ]) {
    const H = clone(BASE);
    const t = await ticket(H, { now });
    start(H, t, { now });
    readMail(H, t, MAIL_OK, { now });
    refused(stage(H, t, stageItem(H, t, { now: at(now, 101) }), { now: at(now, 101), post: false }).pre, /wasn't read for them by this run in the last 90 seconds/);
    const h = logOf(H).find((e) => e.type === 'held');
    assert.deepEqual([h.retry, h.last_day], [true, '2026-10-14'], now);
    const sum = inHome(H, () => buildSummary(logOf(H), new Date(Date.parse(now)).toLocaleDateString('sv')));
    assert.equal(/floorboss tries again at a later hour/.test(sum), again, `${now}: ${sum}`);
  }
});

test('F4-R1-N6b: a stage-call mark floorboss can\'t date has its own reason', async () => {
  // A stage-call mark floorboss can't date: its own reason, in the launcher and the guard, never the 12 hours.
  const H = clone(BASE);
  mkdirSync(join(H.dir, 'released'), { recursive: true });
  writeFileSync(join(H.dir, 'released', `stage-call-${H.ana}-2-b123-1`), 'not a date');
  const why = /floorboss found a mark it can't date: run floorboss once with you there/;
  const due = inHome(H, () => followupsDue(Date.parse(D13), []));
  assert.deepEqual(due.items, []);
  assert.match(due.waiting.map((x) => x.why).join(' '), why);
  assert.doesNotMatch(due.waiting.map((x) => x.why).join(' '), /12 hours/);
  const t = await ticket(H, { items: ITEMS });
  start(H, t);
  readMail(H, t);
  refused(stage(H, t, stageItem(H, t), { post: false }).pre, why);
  assert.equal(logOf(H).find((e) => e.type === 'held')?.retry, undefined, 'no hour later changes it');
});

test('F4-R2-N1: an attended draft call that fails after it was let through holds the unattended draft of that step until you say', async () => {
  const H = clone(BASE);
  draftsMode(H);
  const t0 = '2026-10-13T08:00:00Z';
  const day2 = '2026-10-14T07:30:00Z';
  // What a ticket holds the next day with no attended draft at all.
  const forced = (await ticket(clone(H), { now: day2 })).items;
  assert.equal(forced.length, 1);
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], t0);
  const att = JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === H.ana && x.touch === 2);
  const call = { tool_name: 'mcp__mail__create_draft', tool_input: draftInput(att), session_id: 's-att2', tool_use_id: 'att-1' };
  assert.equal(hook(H, { hook_event_name: 'PreToolUse', ...call }, { now: t0 }).decision, 'ask');
  // The user allows it, and the call fails (a timeout: the mailbox may still have made the draft).
  assert.equal(hook(H, { hook_event_name: 'PostToolUseFailure', ...call, error: 'MCP tool call timed out' }, { args: ['post'], now: at(t0, 60) }).code, 0);
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att2' }, { now: at(t0, 60) });
  assert.ok(readdirSync(join(H.dir, 'released')).some((f) => new RegExp(`^stage-call-${H.ana}-2-[0-9a-f]{24}-1\\.failed$`).test(f)));
  // The next day: held up front, as maybe in the drafts folder, never ticketed; a ticket made anyway is refused.
  // (Fix round 5: one plain reason for every attended draft with no receipt, test/unattended-fixes-7.test.mjs.)
  const why = /a draft of this same follow-up was tried in a session with you there and floorboss has no receipt for it, so it may or may not be in your drafts folder/;
  const due = inHome(H, () => followupsDue(Date.parse(day2), []));
  assert.deepEqual(due.items, []);
  assert.match(due.held.map((x) => x.why).join(' '), why);
  const t = await ticket(H, { now: day2, items: forced });
  start(H, t, { now: day2 });
  readMail(H, t, MAIL_OK, { now: day2 });
  refused(stage(H, t, stageItem(H, t, { now: day2 }), { now: day2, post: false }).pre, why);
  assert.ok(!released(H));
  // You say it isn't there (draft-missing, with its prompt): the step can go in again.
  const dm = bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'not-in-my-drafts'), { session: 's-att4', now: day2 });
  assert.equal(dm.pre.decision, 'ask', dm.pre.stderr);
  assert.match(dm.pre.reason, /In a session with you there, a draft of it was tried \(for its text now or an earlier one\), and floorboss has no receipt for it\./);
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.id === H.ana && e.touch === 2), String(dm.stdout).slice(0, 300));
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att4' }, { now: day2 });
  assert.deepEqual(inHome(H, () => followupsDue(Date.parse(day2), [])).items.map((x) => `${x.id}:${x.touch}`), [`${H.ana}:2`]);
});

const NO_ID = /Claude Code didn't give this draft call an id \(tool_use_id\), and floorboss keeps track of each draft call by it: update Claude Code, then try again/;
test('F4-R2-N2a: a staged draft call with no tool_use_id is refused with you there', async () => {
  const no = NO_ID;
  // With you there.
  const H = clone(BASE);
  draftsMode(H);
  const t0 = '2026-10-13T08:00:00Z';
  const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug], t0);
  const att = JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === H.ana && x.touch === 2);
  refused(hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(att), session_id: 's-att5' }, { now: t0 }), no);
  refused(hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(att), session_id: 's-att5', tool_use_id: '' }, { now: t0 }), no);
  assert.ok(!readdirSync(join(H.dir, 'released')).some((f) => f.startsWith(`stage-call-${H.ana}-2-`)), 'no call mark taken');
  assert.equal(hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__create_draft', tool_input: draftInput(att), session_id: 's-att5', tool_use_id: 'att-5' }, { now: t0 }).decision, 'ask');
});

test('F4-R2-N2b: a staged draft call with no tool_use_id is refused in an unattended run', async () => {
  const no = NO_ID;
  // In an unattended run.
  const H2 = clone(BASE);
  const t = await ticket(H2, { items: ITEMS });
  start(H2, t);
  readMail(H2, t);
  refused(stage(H2, t, stageItem(H2, t), { id: '', post: false }).pre, no);
  assert.ok(!released(H2));
});

test('F4-R2-N2c: SECURITY.md says the protection relies on tool_use_id', () => {
  assert.match(flat('SECURITY.md'), /All of this relies on Claude Code giving each call its own id \(`tool_use_id`\): the guard keeps each draft call's note by it, so a staged draft call that comes with no id is refused, with you there or not\./);
});
