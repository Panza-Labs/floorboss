// Review of audit run 11's fixes:
//   3. draft-gone works for an event switched away from the daily routine, for the drafts the routine still has,
//      under the same ask and the same conditions.
//   4. a stop at another event: address case, a plus-tag, a shared inbox (with and without the same name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { world, addLines, ledgerLines, autosend, said, envFor, PEOPLE, NOW, EVENT, SLUG, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { routineHeld, readEvent, eventJson } from '../lib/autosend/common.mjs';
import { routineQueue, routineDeletes, ROUTINE_MODE } from '../lib/autosend/routine.mjs';
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { readFileSync } from 'node:fs';

const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
// Ana's message 2 due today (2026-10-12); the rest after today.
function routineWorld(ana = ANA) {
  const w = world({ touches: 3, people: [ana, BO], event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  process.env.FLOORBOSS_HOME = w.HOME;
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: AUTO_PICK }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  [ana, BO].forEach((p, i) => {
    const h = (t) => yes.find((e) => e.id === p.id && e.touch === t).hash;
    lines.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-09', message_id: `m${i}1`, thread_id: `t${i}`, hash: h(1), source: 'autosend' });
    for (let t = 2; t <= 3; t++) {
      const due = i === 0 && t === 2 ? '2026-10-12' : `2026-10-${20 + t}`;
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due, draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  return { ...w, nowMs };
}
const guard = (HOME, command, extra = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_name: 'Bash', tool_input: { command }, ...extra }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
const hso = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput || {};
  } catch {
    return {};
  }
};

test('3. draft-gone for a switched event\'s old routine draft: the same ask, the same conditions', () => {
  const w = routineWorld();
  // A routine event's `on` needs the guard's record in any host (0.1.7, owner's decision): refused without one.
  const onArgs = ['on', '--event', SLUG, '--mode', 'drafts', '--said-file', said(w.HOME, 'send them from ChatGPT')];
  const before = readFileSync(join(w.evDir, 'event.json'), 'utf8');
  assert.match(autosend(w.HOME, onArgs).ERROR || '', /safety check did not see this command/);
  assert.equal(readFileSync(join(w.evDir, 'event.json'), 'utf8'), before, 'nothing changed without the record');
  assert.ok(!autosend(w.HOME, withSeen(w.HOME, onArgs)).ERROR);
  const f = said(w.HOME, "I looked: it's not in Sent and not in Drafts");
  const cmd = (t) => `node ${CLI} draft-gone --event ${SLUG} --id ${ANA.id} --touch ${t} --said-file ${f}`;
  const r = guard(w.HOME, cmd(2));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hso(r).permissionDecision, 'ask');
  assert.match(hso(r).permissionDecisionReason, /not in Sent and not in Drafts/);
  assert.match(hso(r).permissionDecisionReason, /Ana Ito/);
  assert.equal(guard(w.HOME, cmd(2), { agent_id: 'agent-1' }).status, 2, 'never a subagent');
  assert.equal(guard(w.HOME, cmd(3)).status, 2, 'not yet past its day: its delete step settles it');
  const ok = autosend(w.HOME, withSeen(w.HOME, ['draft-gone', '--event', SLUG, '--id', ANA.id, '--touch', '2', '--said-file', f]), { claude: true });
  assert.ok(!ok.ERROR, ok.ERROR);
  assert.equal(routineHeld(eventJson(w.evDir), readEvent(w.evDir).entries, ANA.id, 2), null, 'no longer stuck');
  assert.ok(autosend(w.HOME, withSeen(w.HOME, ['draft-gone', '--event', SLUG, '--id', ANA.id, '--touch', '3', '--said-file', f]), { claude: true }).ERROR, 'the CLI refuses a draft not yet due');
});

const stopAt = (w, person) => {
  const o = world({ touches: 1, people: [person], event: { ...EVENT, slug: 'other-fair', name: 'Other Fair', autosend: false }, home: w.HOME });
  addLines(o.evDir, [{ at: NOW, type: 'stop', who: 'user', id: person.id, said: 'asked to stop' }]);
};
const anaOut = (w) => {
  const q = routineQueue(w.evDir, w.nowMs).items.map((x) => x.draft_id);
  const d = routineDeletes(w.evDir, w.nowMs).map((x) => x.draft_id);
  return !q.includes('r02') && !q.includes('r03') && d.includes('r02') && d.includes('r03');
};

test('4. a stop elsewhere matches the address whatever its case, and with a plus-tag', () => {
  for (const email of ['ANA@North.Example', 'ana+fair@north.example', 'Ana+Fair@NORTH.example']) {
    const w = routineWorld();
    stopAt(w, { ...ANA, id: 'c901', email });
    assert.equal(anaOut(w), true, email);
    assert.ok(q2(w), 'Bo stays queued');
  }
  // A different address at the same company is someone else.
  const w = routineWorld();
  stopAt(w, { ...ANA, id: 'c901', name: 'Zed Roe', email: 'zed@north.example' });
  assert.equal(anaOut(w), false);
});
const q2 = (w) => routineQueue(w.evDir, w.nowMs).items.some((x) => x.draft_id === 'r12');

test('4. a shared inbox: a stop there holds the drafts to that inbox, with the same name or not (it is one mailbox)', () => {
  const inbox = { ...ANA, email: 'info@north.example' };
  for (const name of ['Ana Ito', 'Zed Roe']) {
    const w = routineWorld(inbox);
    stopAt(w, { ...inbox, id: 'c901', name });
    assert.equal(anaOut(w), true, name);
    const lo = routineQueue(w.evDir, w.nowMs).left_out.find((x) => x.draft_id === 'r02');
    assert.match(lo.why, /another of your events \(other-fair\)/, 'what the user sees');
  }
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, draft-gone is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('draft-gone');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
