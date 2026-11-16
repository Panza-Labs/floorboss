// A throwaway home with one event in drafts mode, brought through the real CLIs and the real guard hooks to the point
// where an unattended run may put follow-up 1 into the drafts: message 1 staged after its prompt and recorded as sent,
// unattended drafts turned on (the guard's prompt, then its post hook), the follow-ups authorised the same way, the
// schedule "installed" (its record), and a ticket the launcher would write. Nothing here starts Claude Code.
import './isolated-home.mjs';
import { writeFileSync, readFileSync, mkdirSync, cpSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setup, cli, idOf, todoJobs, ROOT } from './harness.mjs';
import { draftFor } from '../sims/lib/driver.mjs';
import { DRAFTS_SENTENCE } from '../../lib/unattended-drafts.mjs';
import { followupsDue } from '../../scripts/scheduled.mjs';

export { ROOT };
// Mon 12 Oct 2026, 10:00 in Amsterdam: message 1 goes. Follow-up 1 (gap 1) is due Tue 13 Oct.
export const NOW = '2026-10-12T08:00:00Z';
export const D13 = '2026-10-13T08:00:00Z';
export const SEND = { server: 'mail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't0', user_confirmed: true } };
export const STAGE = { server: 'mail', tool: 'create_draft', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{reply_in_thread}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
export const READ = { server: 'mail', tool: 'list_messages', args: { address: '{email}', since: '{since}' }, reading: 'x', tool_hash: 'e'.repeat(64), probe: { ok: true } };
export const CRM = { server: 'crm', tool: 'list_engagements', args: { contact_id: '{crm_id}' }, reading: 'x', tool_hash: 'f'.repeat(64), probe: { ok: true } };
export const OWN = 'me@lanecraft.example';
export const ANA = 'ana@acme.test';
// A second person, for the worlds that need two (two: true): message 1 to her went in thread T2.
export const BO = 'bo@bolt.test';
const PEOPLE = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n';
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
export const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// The guard as Claude Code runs it, in this home, at this time. extra: more environment (the run's token).
export function hook(H, input, { args = [], now = H.now || NOW, env = {} } = {}) {
  const e = { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, FLOORBOSS_PLATFORM: 'darwin', CLAUDE_PLUGIN_ROOT: ROOT, ...env };
  delete e.FLOORBOSS_UNATTENDED;
  if (env.FLOORBOSS_UNATTENDED) e.FLOORBOSS_UNATTENDED = env.FLOORBOSS_UNATTENDED;
  const r = spawnSync(process.execPath, [join(ROOT, 'hooks/guard.mjs'), ...args], { input: JSON.stringify(input), env: e, encoding: 'utf8' });
  let out = null;
  try {
    out = r.stdout ? JSON.parse(r.stdout) : null;
  } catch {
    out = null;
  }
  return { code: r.status, stderr: r.stderr, stdout: r.stdout, decision: out?.hookSpecificOutput?.permissionDecision || null, reason: out?.hookSpecificOutput?.permissionDecisionReason || '' };
}
export const scriptCmd = (skill, ...args) => `node ${join(ROOT, 'skills', skill, 'scripts', 'cli.mjs')} ${args.join(' ')}`;
// A floorboss script call as Claude Code makes it: the guard before it, the script, the guard after it (only when the
// user allowed, which a test says with allowed: false for a declined prompt).
export function bashCall(H, command, { session = 's-att', id = `tu-${Math.random().toString(36).slice(2)}`, now = H.now || NOW, allowed = true, env = {} } = {}) {
  const pre = hook(H, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: session, tool_use_id: id }, { now, env });
  if (pre.code !== 0 || !allowed) return { pre };
  const words = command.split(' ');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, words.slice(1), { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: now, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    stdout = String(e.stdout || '');
  }
  const post = hook(H, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, session_id: session, tool_use_id: id, tool_response: { stdout, stderr: '', interrupted: false } }, { args: ['post'], now, env });
  return { pre, stdout, post };
}
export const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

export function approveAll(H, now) {
  for (let i = 0; i < 6; i++) {
    const r = todoJobs(H, now);
    for (const j of r.jobs.filter((x) => x.kind === 'message' && !x.waits_for_previous)) {
      const d = draftFor({ ...r.t, insights: r.insights }, { ...j, slot_labels: j.slot_labels || [] });
      cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--json', JSON.stringify({ subject: d.subject || 'Test Expo', body: d.body, brief: 'x', ...(d.structure ? { structure: d.structure, fact_source: d.fact_source } : {}), ...(d.insight ? { insight: d.insight } : {}) })], now);
      cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', j.id, '--touch', String(j.touch), '--text', 'PASS'], now);
    }
  }
  return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all'], now);
}
const file = (H, name, data) => {
  const f = join(H.HOME, 'work', name);
  mkdirSync(join(H.HOME, 'work'), { recursive: true });
  writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
  return f;
};

// The claude.ai Gmail connector, as its tool descriptions give it (examples/standins/gmail-real.mjs answers in its
// shapes): send_message and create_draft take a list of addresses and reply by replyToMessageId; the saved mailbox
// reader is search_threads, as an attended setup would save it.
export const G = 'claude_ai_Gmail';
// The three recipes on a Gmail server of this name (the end-to-end test names its stand-in apart from the real one).
export const gRecipes = (server = G) => ({
  send: { server, tool: 'send_message', args: { to: ['{to}'], subject: '{subject}', body: '{body}', replyToMessageId: '{reply_to_message_id}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't0', user_confirmed: true } },
  stage: { server, tool: 'create_draft', args: { to: ['{to}'], subject: '{subject}', body: '{body}', replyToMessageId: '{reply_to_message_id}' }, reading: 'x', tool_hash: 'd'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } },
  read: { server, tool: 'search_threads', args: { query: 'from:{email} OR to:{email} after:{since}' }, reading: 'x', tool_hash: 'e'.repeat(64), probe: { ok: true } }
});
export const { send: GSEND, stage: GSTAGE, read: GREAD } = gRecipes();
// One call to the gmail-real stand-in, over MCP stdio (examples/standins/call.mjs), with this home's data file.
export function gcall(H, tool, args, { now = H.now || NOW } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'examples/standins/call.mjs'), 'gmail-real', 'call', tool, JSON.stringify(args)], { env: { ...process.env, STANDIN_DATA: join(H.HOME, 'standin.json'), STANDIN_NOW: now }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gmail-real ${tool}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
// The same call's whole MCP result (content, structuredContent, isError), as a client receives it.
export function graw(H, tool, args, { now = H.now || NOW } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, 'examples/standins/call.mjs'), 'gmail-real', 'raw', tool, JSON.stringify(args)], { env: { ...process.env, STANDIN_DATA: join(H.HOME, 'standin.json'), STANDIN_NOW: now }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gmail-real ${tool}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
export const gdata = (H, fn) => {
  const f = join(H.HOME, 'standin.json');
  writeFileSync(f, JSON.stringify(fn(existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {})));
};

// The whole world, up to the morning follow-up 1 is due. crm: also a CRM reader (crm.activity).
// gmail: the claude.ai Gmail connector's recipes (above); message 1 goes through gmail-real's send_message, the
// guard's post hook reads its answer (the message id and thread it records), and the receipt names no thread.
// Email sending is on: the whole sequence is approved up front, message 1 goes through the guard with its prompt, and
// the unattended run puts the follow-ups in the drafts instead of sending them (release 2).
// gserver: the Gmail recipes' server name (the claude.ai connector's by default).
export function world({ crm = false, two = false, gmail = false, gserver = G } = {}) {
  const H = setup({ attendees: two ? `${PEOPLE}Bo Lind,CFO,Bolt,${BO}\n` : PEOPLE, settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email', 'email'] } });
  const g = gRecipes(gserver);
  const conn = gmail ? { 'email.send': g.send, stage_draft: g.stage, 'email.messages': g.read } : { 'email.send': SEND, stage_draft: STAGE, 'email.messages': READ };
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { ...conn, ...(crm ? { 'crm.activity': CRM } : {}) }, followup_gap: [1], own_email: OWN }));
  if (gmail) gdata(H, () => ({ mail: { address: OWN, threads: [] } }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  H.ana = idOf(H, 'Ana Berg');
  if (two) H.bo = idOf(H, 'Bo Lind');
  approveAll(H, NOW);
  // Message 1, through the guard with its prompt, then its receipt (with the thread the send tool gave).
  const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug], NOW);
  const firsts = JSON.parse(readFileSync(sl.file, 'utf8')).filter((x) => x.touch === 1);
  const sends = [];
  for (const [who, mid, thread, tu] of [[H.ana, 'm1', 'T1', 'tu-m1'], ...(two ? [[H.bo, 'mb1', 'T2', 'tu-mb1']] : [])]) {
    const m1 = firsts.find((x) => x.id === who);
    if (!m1) throw new Error(`message 1 to ${who} isn't listed to send: ${JSON.stringify(sl.waiting || sl)}`);
    if (gmail) {
      // The real connector's send: the guard asks, the stand-in "sends", the post hook reads its answer.
      const input = { to: [m1.to], subject: m1.subject, body: m1.body };
      const pre = hook(H, { hook_event_name: 'PreToolUse', tool_name: `mcp__${gserver}__send_message`, tool_input: input, session_id: 's-att', tool_use_id: tu });
      if (pre.decision !== 'ask') throw new Error(`message 1 to ${who} should ask: ${pre.code} ${pre.stderr}`);
      const answer = gcall(H, 'send_message', input);
      hook(H, { hook_event_name: 'PostToolUse', tool_name: `mcp__${gserver}__send_message`, tool_input: input, tool_response: text(answer), session_id: 's-att', tool_use_id: tu }, { args: ['post'] });
      H.m1 = answer;
      sends.push({ id: who, touch: 1, message_id: answer.id });
      continue;
    }
    const pre = hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__send_email', tool_input: { to: m1.to, subject: m1.subject, body: m1.body }, session_id: 's-att', tool_use_id: tu });
    if (pre.decision !== 'ask') throw new Error(`message 1 to ${who} should ask: ${pre.code} ${pre.stderr}`);
    sends.push({ id: who, touch: 1, message_id: mid, thread_id: thread });
  }
  cli(H, 'event-outreach', ['sent', '--event', H.slug, '--receipts-file', file(H, 'r1.json', { sends })], NOW);
  // Step 1 and 2: the typed sentence, and the guard's prompt (allowed), recorded by its post hook.
  const said = file(H, 'said.txt', DRAFTS_SENTENCE);
  H.optin = bashCall(H, scriptCmd('connectors', 'unattended-on', '--event', H.slug, '--said-file', said));
  // The authorisation: one prompt for the whole sequence, recorded by the post hook.
  H.auth = bashCall(H, scriptCmd('event-outreach', 'authorise-unattended', '--event', H.slug));
  // Step 3's record (install-followups writes it; tested on its own).
  mkdirSync(join(H.HOME, 'unattended'), { recursive: true, mode: 0o700 });
  writeFileSync(join(H.HOME, 'unattended', 'followups-installed.json'), JSON.stringify({ label: 'com.floorboss.followups', version: VERSION, claude: '/usr/local/bin/claude', at: NOW }), { mode: 0o600 });
  // The attended session ended: its run lock with it.
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-att' });
  H.now = D13;
  return H;
}

// A copy of a world in a new home (the event's own files carry no path to the old one that matters here).
export function clone(H) {
  const base = mkdtempSync(join(tmpdir(), 'fb-uw-'));
  const HOME = join(base, 'home');
  cpSync(H.HOME, HOME, { recursive: true });
  return { ...H, HOME, dir: join(HOME, 'events', H.slug) };
}

// What the launcher does before it starts Claude Code: the due items, a ticket and a token. Returns { session, token }.
export async function ticket(H, { now = H.now, items = null, at = null } = {}) {
  const was = process.env.FLOORBOSS_HOME;
  const wasNow = process.env.FLOORBOSS_NOW;
  process.env.FLOORBOSS_HOME = H.HOME;
  process.env.FLOORBOSS_NOW = now;
  try {
    // Synchronous from here to the end: two of these at once can't see each other's home.
    const due = items || followupsDue(Date.parse(now)).items;
    const session = randomUUID();
    const token = createHash('sha256').update(`${session}${Math.random()}`).digest('hex');
    mkdirSync(join(H.HOME, 'unattended', 'tickets'), { recursive: true, mode: 0o700 });
    writeFileSync(join(H.HOME, 'unattended', 'tickets', `${session}.json`), JSON.stringify({ v: 1, session, token_sha256: sha(token), pid: process.pid, at: at || now, items: due }), { mode: 0o600 });
    return { session, token, items: due };
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = was;
    if (wasNow === undefined) delete process.env.FLOORBOSS_NOW;
    else process.env.FLOORBOSS_NOW = wasNow;
  }
}
// The run's session starting as the launcher starts it: a fresh startup, with the token in its environment.
export const start = (H, t, { source = 'startup', now = H.now, token = t.token } = {}) =>
  hook(H, { hook_event_name: 'SessionStart', source, session_id: t.session, transcript_path: '/nonexistent' }, { args: ['start'], now, env: { FLOORBOSS_UNATTENDED: token } });
// One call in the run, before and (optionally) after.
export const inRun = (H, t, tool_name, tool_input, { now = H.now, token = t.token, id = `tu-${Math.random().toString(36).slice(2)}`, extra = {} } = {}) =>
  hook(H, { hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: t.session, tool_use_id: id, ...extra }, { now, env: { FLOORBOSS_UNATTENDED: token } });
export const afterRun = (H, t, tool_name, tool_input, tool_response, { now = H.now, token = t.token, id } = {}) =>
  hook(H, { hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, session_id: t.session, tool_use_id: id }, { args: ['post'], now, env: { FLOORBOSS_UNATTENDED: token } });
// The mailbox read, and its answer: by default, only the user's own message 1.
export const MAIL_OK = { messages: [{ id: 'm1', threadId: 'T1', from: OWN, to: ANA, date: '2026-10-12T09:00:00Z', subject: 'Test Expo' }] };
export function readMail(H, t, answer = MAIL_OK, { now = H.now, since = '2026-10-11', id = `tu-mail-${Math.random().toString(36).slice(2)}`, address = ANA } = {}) {
  const input = { address, since };
  const pre = inRun(H, t, 'mcp__mail__list_messages', input, { now, id });
  if (pre.decision !== 'allow') return { pre };
  const post = afterRun(H, t, 'mcp__mail__list_messages', input, text(answer), { now, id });
  return { pre, post };
}
export function readCrm(H, t, answer, { now = H.now, crmId = '101', id = `tu-crm-${Math.random().toString(36).slice(2)}` } = {}) {
  const input = { contact_id: crmId };
  const pre = inRun(H, t, 'mcp__crm__list_engagements', input, { now, id });
  if (pre.decision !== 'allow') return { pre };
  const post = afterRun(H, t, 'mcp__crm__list_engagements', input, text(answer), { now, id });
  return { pre, post };
}
// The stage list as the run's flow makes it, and follow-up 1's draft call.
export function stageItem(H, t, { now = H.now, who = H.ana } = {}) {
  const was = process.env.FLOORBOSS_UNATTENDED;
  process.env.FLOORBOSS_UNATTENDED = t.token;
  let sl;
  try {
    sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug, '--unattended'], now);
  } finally {
    if (was === undefined) delete process.env.FLOORBOSS_UNATTENDED;
    else process.env.FLOORBOSS_UNATTENDED = was;
  }
  if (!sl.file) throw new Error(`stage-list: ${JSON.stringify(sl)}`);
  return JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === who && x.touch === 2) || null;
}
export const draftInput = (it, extra = {}) => ({ to: it.to, subject: it.subject, body: it.body, threadId: it.reply_in_thread, ...extra });
export function stage(H, t, it, { now = H.now, input = draftInput(it), answer = { id: 'd2', message: { id: 'm2', threadId: 'T1' } }, id = `tu-stage-${Math.random().toString(36).slice(2)}`, post = true } = {}) {
  const pre = inRun(H, t, 'mcp__mail__create_draft', input, { now, id });
  if (pre.decision !== 'allow' || !post) return { pre };
  return { pre, post: afterRun(H, t, 'mcp__mail__create_draft', input, text(answer), { now, id }) };
}
export const logOf = (H) =>
  existsSync(join(H.HOME, 'unattended', 'log.jsonl'))
    ? readFileSync(join(H.HOME, 'unattended', 'log.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
export const ledgerOf = (H) =>
  readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
