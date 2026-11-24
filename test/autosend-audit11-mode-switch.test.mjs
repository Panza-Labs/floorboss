// Audit run 11, item 5: switching the auto-send mode of an event whose daily Claude routine still has queued Gmail
// drafts. The routine in the user's Claude account keeps its prompt and sends those drafts on their day whatever
// event.json says now, so they stay held and get delete steps until each is confirmed gone.
import { withSeen } from './fixtures/guard-seen.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, addLines, ledgerLines, autosend, said, PEOPLE, NOW, EVENT, SLUG } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { routineHeld, readEvent, eventJson, ROUTINE_DRAFT_LEFT } from '../lib/autosend/common.mjs';
import { routineDeletes, routineStopWords, ROUTINE_MODE } from '../lib/autosend/routine.mjs';

const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
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
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due: `2026-10-${20 + t}`, draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  return { ...w, nowMs };
}
const held = (w, id, touch) => routineHeld(eventJson(w.evDir), readEvent(w.evDir).entries, id, touch);

for (const mode of ['drafts', 'cloud']) {
  test(`switching a routine event to ${mode} keeps its queued routine drafts held, with delete steps, until each is gone`, () => {
    const w = routineWorld();
    // A routine event's `on` needs the guard's record in any host (0.1.7, owner's decision): refused without one.
    const onArgs = ['on', '--event', SLUG, '--mode', mode, '--said-file', said(w.HOME, 'send them from ChatGPT instead')];
    const before = readFileSync(join(w.evDir, 'event.json'), 'utf8');
    assert.match(autosend(w.HOME, onArgs).ERROR || '', /safety check did not see this command/);
    assert.equal(readFileSync(join(w.evDir, 'event.json'), 'utf8'), before, 'nothing changed without the record');
    const out = autosend(w.HOME, withSeen(w.HOME, onArgs));
    assert.ok(!out.ERROR, out.ERROR);
    assert.equal(eventJson(w.evDir).autosend_mode, mode);
    for (const p of [ANA, BO]) for (const t of [2, 3]) assert.equal(held(w, p.id, t), ROUTINE_DRAFT_LEFT, `${p.id} message ${t}`);
    assert.deepEqual(routineDeletes(w.evDir, w.nowMs).map((x) => x.draft_id).sort(), ['r02', 'r03', 'r12', 'r13']);
    assert.deepEqual(routineStopWords(w.evDir, SLUG, w.nowMs).drafts_delete.map((s) => s.args.draftId).sort(), ['r02', 'r03', 'r12', 'r13']);
    assert.deepEqual((out.drafts_delete || []).map((s) => s.args.draftId).sort(), ['r02', 'r03', 'r12', 'r13'], 'the switch hands out the delete steps');
    // Confirmed gone: that step is no longer the old routine's.
    addLines(w.evDir, [{ at: NOW, type: 'autosend_draft_deleted', who: 'guard', id: ANA.id, touch: 2, draft_id: 'r02' }]);
    assert.equal(held(w, ANA.id, 2), null);
    assert.equal(held(w, ANA.id, 3), ROUTINE_DRAFT_LEFT);
    assert.ok(!routineDeletes(w.evDir, w.nowMs).some((x) => x.draft_id === 'r02'));
  });
}

test('a Codex event that was never routine is unchanged', () => {
  const w = world({ touches: 2, event: { ...EVENT, autosend_mode: 'drafts' } });
  const out = autosend(w.HOME, ['on', '--event', SLUG, '--mode', 'cloud', '--said-file', said(w.HOME, 'use the cloud task')]);
  assert.ok(!out.ERROR, out.ERROR);
  assert.equal(out.drafts_delete, undefined);
  assert.equal(eventJson(w.evDir).autosend_routine_until, undefined);
  assert.deepEqual(routineDeletes(w.evDir, Date.parse(NOW)), []);
});
