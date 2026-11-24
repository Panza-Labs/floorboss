// Audit run 11, item 1: the daily routine's yes (pick 1) counts only for the text it was given for. After the user
// edits a queued follow-up and approves the new text, the old Gmail draft leaves the routine's queue, gets its delete
// step, and the edited message waits for a fresh choice. A later pick 2 (Gmail drafts) and then an edit never bring
// pick 1's yes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, addLines, ledgerLines, approvedLines, PEOPLE, NOW, EVENT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK } from '../lib/autosend/pick.mjs';
import { routineHeld, pickHold, standingPick, readEvent, eventJson, PICK_WHY, ROUTINE_DRAFT_LEFT } from '../lib/autosend/common.mjs';
import { routineQueue, routineDeletes, routineStopWords, ROUTINE_MODE } from '../lib/autosend/routine.mjs';

const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
// Ana and Bo, message 1 sent, messages 2 and 3 queued as the routine's Gmail drafts (all due after today).
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
// The user edits Ana's message 3 and approves the new text at the gate.
const editAna3 = (w) => {
  const e = approvedLines(w.evDir, ANA, 3, { at: '2026-10-12T08:30:00Z', extra: ' Edited by the user.' });
  addLines(w.evDir, e.lines);
  return e.hash;
};
const queued = (w) => routineQueue(w.evDir, w.nowMs).items.map((x) => x.draft_id);
const deletes = (w) => routineDeletes(w.evDir, w.nowMs);

test('an edit after pick 1 takes the old draft out of the queue and gives its delete step; the new text needs a fresh choice', () => {
  const w = routineWorld();
  assert.ok(queued(w).includes('r03'));
  const h2 = editAna3(w);
  assert.ok(!queued(w).includes('r03'), 'the old text never goes');
  assert.ok(queued(w).includes('r02') && queued(w).includes('r13'), 'the rest stay');
  const d = deletes(w).find((x) => x.draft_id === 'r03');
  assert.ok(d, 'a delete step for the old draft');
  assert.match(d.why, /changed/);
  assert.match(d.why, /fresh choice/);
  assert.ok(routineStopWords(w.evDir, EVENT.slug, w.nowMs).drafts_delete.some((s) => s.args.draftId === 'r03'));
  const { entries } = readEvent(w.evDir);
  const ev = eventJson(w.evDir);
  assert.equal(standingPick(entries, ANA.id, 3, h2), 'auto', 'the general pick reading is unchanged (Codex reads it)');
  assert.equal(routineHeld(ev, entries, ANA.id, 3, h2), ROUTINE_DRAFT_LEFT, 'held until the old draft is gone');
  assert.equal(pickHold(ev, entries, ANA.id, 3, h2, ANA.email), PICK_WHY.none, 'the user is told it waits for a fresh choice');
  // Ana's message 2, not edited, still has pick 1.
  assert.equal(pickHold(ev, entries, ANA.id, 2, ledgerLines(w.evDir).find((e) => e.type === 'autosend_approved' && e.id === ANA.id && e.touch === 2).hash, ANA.email), null);
});

test('pick 1, then pick 2, then an edit: pick 1 does not come back', () => {
  const w = routineWorld();
  const y = ledgerLines(w.evDir).find((e) => e.type === 'autosend_approved' && e.id === ANA.id && e.touch === 3);
  addLines(w.evDir, [{ at: '2026-10-12T08:10:00Z', type: 'drafts_approved', who: 'user', id: ANA.id, touch: 3, hash: y.hash, to: ANA.email, said: '2' }]);
  assert.ok(!queued(w).includes('r03'), 'pick 2 takes it out');
  assert.ok(deletes(w).some((x) => x.draft_id === 'r03'));
  const h2 = editAna3(w);
  assert.ok(!queued(w).includes('r03'), 'still out after the edit');
  assert.ok(deletes(w).some((x) => x.draft_id === 'r03'), 'still to delete after the edit');
  const { entries } = readEvent(w.evDir);
  assert.equal(pickHold(eventJson(w.evDir), entries, ANA.id, 3, h2, ANA.email), PICK_WHY.none);
});
