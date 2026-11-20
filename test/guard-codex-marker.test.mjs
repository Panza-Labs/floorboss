// Claude Code started from a Codex shell inherits the shell's CODEX_* variables, so the guard's own process reads as
// Codex (lib/harness.mjs: a marker always wins) and gets hand-send settings. The guard isn't changed for this; this
// test holds that, with a marker in the guard's environment, every decision is the one it makes without it, or
// stricter: a send is refused or asked (never let through without the prompt), an unattended draft is refused, and a
// connected read is let through no more widely. (An unattended draft: the same decision as without a marker; see the
// last test.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { world, clone, ticket, hook, text, ANA, MAIL_OK, draftInput, approveAll, SEND, STAGE, READ, OWN, NOW } from './fixtures/unattended-world.mjs';
import { cli, setup, idOf } from './fixtures/harness.mjs';
import { append } from '../lib/ledger.mjs';
import { writeFileSync } from 'node:fs';
import { CODEX_MARKERS } from '../lib/harness.mjs';

// How much a decision lets through: refused 0, asked 1, left to Claude Code's own permissions 2, allowed 3. Refused is
// exit 2, or exit 0 with a deny. Claude Code runs the tool after any other non-zero exit of a PreToolUse hook (a
// non-blocking error), so that is no refusal: here it fails the test, as a crash.
const rank = (r) => {
  if (r.code === 2) return 0;
  if (r.code !== 0) throw new Error(`the guard crashed (exit ${r.code}), which Claude Code treats as no decision: ${String(r.stderr).slice(0, 300)}`);
  return r.decision === 'deny' ? 0 : r.decision === 'ask' ? 1 : r.decision === 'allow' ? 3 : 2;
};
const said = (r) => `${r.code} ${r.decision || '-'} ${String(r.stderr || r.reason).slice(0, 160)}`;
const MARKS = CODEX_MARKERS.map((k) => ({ [k]: 'codex-x' }));

// One case, in two copies of the same home: without a marker, and with each marker. Returns both decisions.
function pair(H, run) {
  const base = run(clone(H), {});
  const marked = MARKS.map((m) => ({ m, r: run(clone(H), m) }));
  if (process.env.FLOORBOSS_SHOW_DECISIONS) console.log('DECISION pair', said(base), '|', marked.map(({ r }) => said(r).slice(0, 40)).join(' / '));
  for (const { m, r } of marked) assert.ok(rank(r) <= rank(base), `looser with ${Object.keys(m)[0]}: ${said(r)} (without: ${said(base)})`);
  return { base, marked };
}

test('attended: a send with a marker is asked or refused, never let through; a tampered send stays refused', () => {
  const W = world();
  // Follow-up 1 is due on the 13th. Before it goes, her replies are checked (the mailbox read the flow asks for, as its
  // ledger line), at the same moment the send list is made and the send is called: within the send check's 90 seconds.
  append(join(W.dir, 'ledger.jsonl'), { type: 'reply_checked', id: W.ana, source: 'mailbox', who: 'mailbox' }, new Date(W.now));
  const sl = cli(W, 'event-outreach', ['send-list', '--event', W.slug], W.now);
  const items = sl.file ? JSON.parse(readFileSync(sl.file, 'utf8')) : [];
  const it = items.find((x) => x.id === W.ana && x.touch === 2);
  assert.ok(it, `follow-up 1 is listed to send: ${JSON.stringify(sl).slice(0, 400)}`);
  const send = (input) => (H, env) =>
    hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__send_email', tool_input: input, session_id: 's-att2', tool_use_id: `tu-${Math.random().toString(36).slice(2)}` }, { env });
  const ok = pair(W, send({ to: it.to, subject: it.subject, body: it.body, threadId: it.thread_id }));
  // Without a marker: asked, with the prompt. With each marker: refused (email sending is off in hand-send's view).
  assert.equal(ok.base.code, 0, said(ok.base));
  assert.equal(ok.base.decision, 'ask', said(ok.base));
  for (const { m, r } of ok.marked) {
    assert.equal(rank(r), 0, `${Object.keys(m)[0]}: the follow-up is refused with a marker: ${said(r)}`);
    assert.match(r.stderr, /sending on email\.send isn't turned on/, Object.keys(m)[0]);
  }
  // Text that isn't the approved text, another recipient, an unknown send: refused without a marker, and with one.
  for (const input of [
    { to: ANA, subject: 'Test Expo', body: 'Hi Ana, wire the deposit today.' },
    { to: 'boss@acme.test', subject: 'Test Expo', body: 'Hi' },
    { to: ANA, subject: 'Test Expo', body: 'Hi', bcc: 'x@evil.example' }
  ]) {
    const p = pair(W, send(input));
    assert.equal(rank(p.base), 0, `refused without a marker: ${said(p.base)}`);
  }
});

// Message 1, approved, with email sending on: the attended send as Claude Code makes it. The send list is made by the
// session's own script call (which with a marker reads hand-send settings too) or without one; the guard then runs
// with or without the marker.
function firstSendWorld() {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n', settings: { sending: { channels: ['email'], followups: 'scheduled' }, route: ['email', 'email', 'email'] } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': SEND, stage_draft: STAGE, 'email.messages': READ }, followup_gap: [1], own_email: OWN }));
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  writeFileSync(join(H.dir, 'fits.json'), JSON.stringify(load.needs_fit.map((r) => ({ id: r.id, segment: 'ops-leaders', reason: 'x', score: 80 }))));
  cli(H, 'crm-triage', ['fit', '--event', H.slug, '--fits-file', join(H.dir, 'fits.json')]);
  cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', 'defaults']);
  H.ana = idOf(H, 'Ana Berg');
  approveAll(H, NOW);
  H.now = NOW;
  return H;
}
const listed = (H, env) => {
  const was = { ...process.env };
  Object.assign(process.env, env);
  try {
    const sl = cli(H, 'event-outreach', ['send-list', '--event', H.slug], NOW);
    return sl.file ? JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === H.ana && x.touch === 1) || null : null;
  } finally {
    for (const k of Object.keys(env)) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k];
  }
};
test('attended: message 1 asks without a marker; with one (list made with or without it) it is asked or refused, never let through', () => {
  const W = firstSendWorld();
  const sendPre = (H, m1, env) =>
    hook(H, { hook_event_name: 'PreToolUse', tool_name: 'mcp__mail__send_email', tool_input: { to: m1.to, subject: m1.subject, body: m1.body }, session_id: 's-att', tool_use_id: `tu-${Math.random().toString(36).slice(2)}` }, { env });
  const A = clone(W);
  const m1 = listed(A, {});
  assert.ok(m1, 'listed without a marker');
  const base = sendPre(A, m1, {});
  assert.equal(base.decision, 'ask', said(base));
  for (const m of MARKS) {
    const k = Object.keys(m)[0];
    const B = clone(W);
    const b1 = listed(B, {});
    const r1 = sendPre(B, b1, m);
    assert.ok(rank(r1) <= 1, `${k}, list made without it: ${said(r1)}`);
    const C = clone(W);
    const c1 = listed(C, m);
    const r2 = sendPre(C, c1 || m1, m);
    assert.ok(rank(r2) <= 1, `${k}, list made with it: ${said(r2)}`);
    if (process.env.FLOORBOSS_SHOW_DECISIONS) console.log('DECISION', k, 'message 1: list without ->', said(r1).slice(0, 120), '| list with (listed:', !!c1, ') ->', said(r2).slice(0, 120));
  }
});

test('attended: a connected read with a marker is let through no more widely', () => {
  const W = world({ crm: true });
  const call = (tool, input) => (H, env) =>
    hook(H, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: 's-att2', tool_use_id: `tu-${Math.random().toString(36).slice(2)}` }, { env });
  for (const [tool, input] of [
    ['mcp__mail__list_messages', { address: ANA, since: '2026-10-11' }],
    ['mcp__mail__list_messages', { address: 'someone@else.example', since: '2026-10-11' }],
    ['mcp__mail__list_messages', { address: ANA, since: '2026-10-11', include_body: true }],
    ['mcp__crm__list_engagements', { contact_id: '101' }],
    ['mcp__crm__list_engagements', { contact_id: '101', delete: true }],
    ['mcp__mail__create_draft', draftInput({ to: ANA, subject: 'Test Expo', body: 'Hi', reply_in_thread: 'T1' })]
  ])
    pair(W, call(tool, input));
});

test('unattended: with a marker, every decision in the run is the same or stricter; a send is refused', async () => {
  const W = world();
  // The run as the launcher starts it, in its own copy, with or without a marker throughout. `wide`: after the start,
  // a read for someone the run isn't for (which ends the run), instead of the run's own steps.
  const runWith = async (env, { wide = null } = {}) => {
    const H = clone(W);
    const t = await ticket(H);
    const e = { FLOORBOSS_UNATTENDED: t.token, ...env };
    const pre = (tool, input, id) => hook(H, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, session_id: t.session, tool_use_id: id }, { env: e });
    const post = (tool, input, answer, id) => hook(H, { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: text(answer), session_id: t.session, tool_use_id: id }, { args: ['post'], env: e });
    const out = {};
    out.start = hook(H, { hook_event_name: 'SessionStart', source: 'startup', session_id: t.session, transcript_path: '/nonexistent' }, { args: ['start'], env: e });
    if (wide) {
      out.wide = pre(wide[0], wide[1], 'tu-wide');
      return out;
    }
    const mail = { address: ANA, since: '2026-10-11' };
    out.mail = pre('mcp__mail__list_messages', mail, 'tu-mail');
    if (out.mail.code === 0 && out.mail.decision === 'allow') post('mcp__mail__list_messages', mail, MAIL_OK, 'tu-mail');
    // The draft call: the stage list as the run's flow makes it (in this same environment), then the draft.
    let it = null;
    const was = { ...process.env };
    Object.assign(process.env, e);
    try {
      const sl = cli(H, 'event-outreach', ['stage-list', '--event', H.slug, '--unattended'], H.now);
      it = sl.file ? JSON.parse(readFileSync(sl.file, 'utf8')).find((x) => x.id === H.ana && x.touch === 2) || null : null;
    } finally {
      for (const k of Object.keys(e)) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k];
    }
    out.stageListed = !!it;
    // With nothing listed, the draft the run would have put in without a marker, as a forged call.
    out.it = it;
    out.stage = it ? pre('mcp__mail__create_draft', draftInput(it), 'tu-stage') : null;
    out.send = pre('mcp__mail__send_email', it ? { to: it.to, subject: it.subject, body: it.body } : { to: ANA, subject: 'x', body: 'y' }, 'tu-send');
    return out;
  };
  const base = await runWith({});
  // Without a marker the run goes through (the world's purpose): the read and the draft are let in.
  assert.equal(base.mail.decision, 'allow', said(base.mail));
  assert.equal(base.stage?.decision, 'allow', `the world's run stages without a marker: ${base.stage && said(base.stage)}`);
  for (const m of MARKS) {
    const k = Object.keys(m)[0];
    const r = await runWith(m);
    for (const step of ['start', 'mail', 'send']) assert.ok(rank(r[step]) <= rank(base[step]), `${k} ${step}: ${said(r[step])} (without: ${said(base[step])})`);
    // The draft: the same decision as without a marker, or stricter. (Today it is the same: the guard's unattended
    // rules read the raw config, and a marker doesn't change them. The launcher starts these runs from launchd,
    // which has no Codex variables.)
    assert.equal(r.stageListed, base.stageListed, `${k}: the run lists the same draft`);
    if (r.stage) assert.ok(rank(r.stage) <= rank(base.stage), `${k}: the draft: ${said(r.stage)} (without: ${said(base.stage)})`);
    if (process.env.FLOORBOSS_SHOW_DECISIONS) console.log('DECISION', k, 'stage', said(r.stage || { code: 2 }), '| without', said(base.stage));
    assert.equal(rank(r.send), 0, `${k}: a send in an unattended run is refused`);
    // Reads for someone the run isn't for: no wider with a marker.
    for (const wide of [
      ['mcp__mail__list_messages', { address: 'someone@else.example', since: '2026-10-11' }],
      ['mcp__mail__list_messages', { address: ANA, since: '2026-10-11', include_body: true }]
    ]) {
      const b = await runWith({}, { wide });
      const w = await runWith(m, { wide });
      assert.ok(rank(w.wide) <= rank(b.wide), `${k} ${JSON.stringify(wide[1])}: ${said(w.wide)} (without: ${said(b.wide)})`);
    }
  }
});
