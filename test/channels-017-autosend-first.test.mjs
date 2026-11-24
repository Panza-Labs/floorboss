// 0.1.7 review round 4: Gmail drafts after a skipped message 1. Message 2 is then the first message; auto-send holds it
// with the true reason (it waits for the user to send it from the outbox), and the skipped note is never drafted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, addLines, NOW } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { approvedPlan } from '../lib/autosend/approved-drafts.mjs';

const nowMs = Date.parse(NOW);
const WHY = 'message 1 could not be delivered, so this first message waits for you to send it from the outbox';

for (const host of ['claude-code', 'codex'])
  test(`pick 2 in ${host}: after message 1 was skipped, message 2 is held with the true reason and message 1 is not drafted`, () => {
    const w = world({ touches: 2 });
    approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '2' }, nowMs);
    addLines(w.evDir, [{ at: NOW, type: 'step_skipped', who: 'floorboss', id: 'c001', touch: 1, reason: 'Grip said: "gone"' }]);
    const plan = approvedPlan(w.evDir, 'drafts', host, nowMs);
    assert.ok(!plan.queue.some((q) => q.id === 'c001'), JSON.stringify(plan.queue));
    assert.equal(plan.skipped.find((s) => s.id === 'c001')?.why, WHY, JSON.stringify(plan.skipped));
  });
