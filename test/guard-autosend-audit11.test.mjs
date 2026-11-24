// Audit run 11, items 3 and 4 (owner's approval for these guard rules, 2026-11-22):
//   3. draft-gone releases a stopped routine draft only through a guard ask that shows the user's words and the
//      person; never from a subagent; never for a draft not yet past its day (its delete step can settle it).
//   4. a subagent never runs the auto-send verbs that change state (on, approve, revoke, draft-gone, drafts,
//      routine-checked), as it never sends.
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { world, addLines, ledgerLines, autosend, said, envFor, PEOPLE, NOW, EVENT, SLUG, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { ROUTINE_MODE } from '../lib/autosend/routine.mjs';

const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
// Ana's message 2 due today (2026-10-12), message 3 after today.
function routineWorld() {
  const w = world({ touches: 3, people: [ANA, BO], event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: AUTO_PICK }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  [ANA, BO].forEach((p, i) => {
    const h = (t) => yes.find((e) => e.id === p.id && e.touch === t).hash;
    lines.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-09', message_id: `m${i}1`, thread_id: `t${i}`, hash: h(1), source: 'autosend' });
    for (let t = 2; t <= 3; t++) {
      const due = i === 0 && t === 2 ? '2026-10-12' : `2026-10-${20 + t}`;
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due, draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  autosend(w.HOME, withSeen(w.HOME, ['revoke', '--event', SLUG, '--ids', ANA.id, '--said-file', said(w.HOME, 'stop auto-send for Ana')]), { claude: true });
  return { ...w, nowMs };
}
const guard = (HOME, command, extra = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_name: 'Bash', tool_input: { command }, ...extra }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
const out = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput || {};
  } catch {
    return {};
  }
};

test('3. draft-gone asks the user, showing their words and the person; a subagent is refused', () => {
  const w = routineWorld();
  const f = said(w.HOME, "I looked: it's not in Sent and not in Drafts");
  const cmd = `node ${CLI} draft-gone --event ${SLUG} --id ${ANA.id} --touch 2 --said-file ${f}`;
  const r = guard(w.HOME, cmd);
  assert.equal(r.status, 0, r.stderr);
  const o = out(r);
  assert.equal(o.permissionDecision, 'ask');
  assert.match(o.permissionDecisionReason, /not in Sent and not in Drafts/, 'their words');
  assert.match(o.permissionDecisionReason, /Ana Ito/);
  assert.match(o.permissionDecisionReason, new RegExp(ANA.email.replace(/[.+]/g, '\\$&')));
  const s = guard(w.HOME, cmd, { agent_id: 'agent-researcher-1' });
  assert.equal(s.status, 2);
  assert.match(s.stderr, /subagent/);
  // No words it can read: refused, never asked.
  assert.equal(guard(w.HOME, `node ${CLI} draft-gone --event ${SLUG} --id ${ANA.id} --touch 2 --said-file /nonexistent/x`).status, 2);
  // A step that isn't waiting on a stopped draft: refused.
  assert.equal(guard(w.HOME, `node ${CLI} draft-gone --event ${SLUG} --id ${BO.id} --touch 2 --said-file ${f}`).status, 2);
});

test('3. draft-gone is refused for a draft not yet past its day: its delete step settles it', () => {
  const w = routineWorld();
  const f = said(w.HOME, "I looked: it's not in Sent and not in Drafts");
  const r = autosend(w.HOME, withSeen(w.HOME, ['draft-gone', '--event', SLUG, '--id', ANA.id, '--touch', '3', '--said-file', f]), { claude: true });
  assert.ok(r.ERROR, 'refused');
  assert.match(r.ERROR, /delete/);
  assert.ok(!ledgerLines(w.evDir).some((e) => e.type === 'autosend_draft_deleted'));
  assert.equal(guard(w.HOME, `node ${CLI} draft-gone --event ${SLUG} --id ${ANA.id} --touch 3 --said-file ${f}`).status, 2, 'the guard refuses it too');
});

test('4. a subagent never runs the auto-send verbs that change state; the main session still may', () => {
  const w = routineWorld();
  const verbs = [`on --event ${SLUG} --said yes-please --own mallory@attacker.example`, `approve --event ${SLUG} --digest x`, `revoke --event ${SLUG} --ids all --said-file x`, `draft-gone --event ${SLUG} --id ${ANA.id} --touch 2 --said-file x`, `drafts next --event ${SLUG} --run new`, 'routine-checked --run rc-000000000000'];
  for (const v of verbs) {
    const r = guard(w.HOME, `node ${CLI} ${v}`, { agent_id: 'agent-researcher-1' });
    assert.equal(r.status, 2, `${v}: ${r.stderr}`);
    assert.match(r.stderr, /subagent/, v);
  }
  for (const v of verbs.filter((x) => !x.startsWith('draft-gone'))) assert.equal(guard(w.HOME, `node ${CLI} ${v}`).status, 0, `main: ${v}`);
  // Read-only verbs stay open to a subagent.
  for (const v of [`readback --event ${SLUG}`, 'routine-status']) assert.equal(guard(w.HOME, `node ${CLI} ${v}`, { agent_id: 'agent-researcher-1' }).status, 0, v);
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, draft-gone is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('draft-gone');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
