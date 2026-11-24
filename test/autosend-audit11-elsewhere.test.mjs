// Audit run 11, item 2: a stop or a bounce recorded for the same address at another event in the data folder reaches
// a daily-routine event's queued drafts: they leave the queue, get their delete steps, stay held on the laptop, and the
// routine is flagged for an update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { world, addLines, ledgerLines, PEOPLE, NOW, EVENT, SLUG } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { routineHeld, readEvent, eventJson } from '../lib/autosend/common.mjs';
import { routineQueue, routineDeletes, routineStopWords, routineState, routinePrompt, cronFor, ROUTINE_MODE } from '../lib/autosend/routine.mjs';
import { writeJson } from '../lib/jsonio.mjs';

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
  // The same Ana at another event in this data folder.
  const o = world({ touches: 1, people: [ANA], event: { ...EVENT, slug: 'other-fair', name: 'Other Fair', autosend: false }, home: w.HOME });
  return { ...w, nowMs, other: o.evDir };
}
const held = (w, id, touch) => routineHeld(eventJson(w.evDir), readEvent(w.evDir).entries, id, touch);

for (const [what, line] of [
  ['a stop', { at: NOW, type: 'stop', who: 'user', id: ANA.id, said: 'she asked me to stop (phone)' }],
  ['a bounce', { at: NOW, type: 'bounced', who: 'floorboss', id: ANA.id, touch: 1 }]
]) {
  test(`${what} for Ana at another event takes her queued routine drafts out and gives their delete steps`, () => {
    const w = routineWorld();
    writeJson(join(w.HOME, 'autosend', 'routines', `${SLUG}.json`), { trigger_id: 'trig_01SAVEDROUTINE00001', hash: routinePrompt(w.evDir, w.nowMs).hash, cron: cronFor({ time: '09:00', zone: EVENT.time_zone, nowMs: w.nowMs }), time: '09:00' });
    assert.equal(routineState(w.HOME, SLUG, w.nowMs).update_due, null, 'up to date before');
    addLines(w.other, [line]);
    const q = routineQueue(w.evDir, w.nowMs);
    assert.deepEqual(q.items.map((x) => x.draft_id).sort(), ['r12', 'r13'], 'only Bo stays queued');
    assert.ok(q.left_out.some((x) => x.draft_id === 'r02' && /another of your events/.test(x.why)));
    const d = routineDeletes(w.evDir, w.nowMs);
    assert.deepEqual(d.map((x) => x.draft_id).sort(), ['r02', 'r03']);
    assert.match(d[0].why, /other-fair/);
    assert.deepEqual(routineStopWords(w.evDir, SLUG, w.nowMs).drafts_delete.map((s) => s.args.draftId).sort(), ['r02', 'r03']);
    assert.ok(held(w, ANA.id, 2), 'held on the laptop until the draft is gone');
    assert.match(routineState(w.HOME, SLUG, w.nowMs).update_due, /changed/, 'a routine update is due');
    assert.equal(held(w, BO.id, 2) && /daily routine sends it/.test(held(w, BO.id, 2)), true, 'Bo is untouched');
  });
}
