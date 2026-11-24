// (d) of the owner's approval (2026-11-22): message 1 at the final approval goes through Claude Code's own send
// check (one prompt each), and auto-send through a daily Claude routine coexists with Claude Code's email sending,
// without that send ending the yes for the follow-ups. Codex is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { world, ledgerLines, addLines, EVENT, NOW, PEOPLE } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
const routineEvent = { ...EVENT, autosend_mode: 'routine' };

import { handSentAfter, liveApproval, claudeSendsEmail, routineHeld, readEvent } from '../lib/autosend/common.mjs';

test('(d) through a daily Claude routine, Claude Code\'s email sending and auto-send coexist; elsewhere, as before', () => {
  const { HOME } = world({ touches: 1, event: routineEvent });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'] } }));
  assert.equal(claudeSendsEmail(HOME, routineEvent), null, 'a routine event');
  assert.match(claudeSendsEmail(HOME, EVENT), /Claude Code sends email/, 'a Codex event: as before');
  assert.match(claudeSendsEmail(HOME, { ...EVENT, autosend_mode: 'drafts' }), /Claude Code sends email/);
});

test('(d) message 1 sent through Claude Code\'s send after the run let it go keeps the yes for the follow-ups; any other send ends it', () => {
  const w = world({ touches: 2, event: routineEvent });
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '1' }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const h = (id, t) => yes.find((e) => e.id === id && e.touch === t).hash;
  const sentLine = (id) => ({ at: NOW, type: 'sent', who: 'floorboss', id, touch: 1, date: '2026-10-12', via: 'floorboss', hash: h(id, 1), channel: 'email.send' });
  // Ana: the run let it go (host claude-code), then Claude Code's send recorded it.
  // Bo: a release with no host (Codex's form), then the same send line: as before, the user took it over.
  // Cy: sent with no release at all.
  addLines(w.evDir, [
    { at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: h('c001', 1), to: PEOPLE[0].email, run: 'cc-1', host: 'claude-code' },
    sentLine('c001'),
    { at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c002', touch: 1, hash: h('c002', 1), to: PEOPLE[1].email, run: 'r-1' },
    sentLine('c002'),
    sentLine('c003')
  ]);
  const { entries } = readEvent(w.evDir);
  assert.ok(liveApproval(entries, 'c001', 2), 'Ana: still auto-send\'s');
  assert.equal(liveApproval(entries, 'c002', 2), null, 'Bo: as before');
  assert.equal(liveApproval(entries, 'c003', 2), null, 'Cy: as before');
  // A release for another text doesn't count.
  const v = world({ touches: 2, event: routineEvent });
  approve(v.evDir, { digest: readback(v.evDir, nowMs).digest, said: '1' }, nowMs);
  addLines(v.evDir, [{ at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: 'f'.repeat(24), to: PEOPLE[0].email, run: 'cc-1', host: 'claude-code' }, sentLine('c001')]);
  assert.equal(liveApproval(readEvent(v.evDir).entries, 'c001', 2), null);
});

test('(d) Claude Code\'s send and stage lists leave a routine step alone, except message 1 the run let go now', () => {
  const w = world({ touches: 2, event: routineEvent });
  const nowMs = Date.parse(NOW);
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: '1' }, nowMs);
  const ev = JSON.parse(readFileSync(join(w.evDir, 'event.json'), 'utf8'));
  let { entries } = readEvent(w.evDir);
  assert.match(routineHeld(ev, entries, 'c001', 1), /daily routine sends it/);
  assert.match(routineHeld(ev, entries, 'c001', 2), /daily routine sends it/);
  const h = ledgerLines(w.evDir).find((e) => e.type === 'autosend_approved' && e.id === 'c001' && e.touch === 1).hash;
  addLines(w.evDir, [{ at: NOW, type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: h, to: PEOPLE[0].email, run: 'cc-1', host: 'claude-code' }]);
  ({ entries } = readEvent(w.evDir));
  assert.equal(routineHeld(ev, entries, 'c001', 1), null, 'message 1, let go by the run');
  assert.match(routineHeld(ev, entries, 'c001', 2), /daily routine/, 'its follow-up stays the routine\'s');
  // A Codex event, or no yes: nothing changes.
  assert.equal(routineHeld({ ...ev, autosend_mode: 'drafts' }, entries, 'c002', 2), null);
  addLines(w.evDir, [{ at: NOW, type: 'autosend_revoked', who: 'user', id: 'c002', said: 'stop' }]);
  assert.equal(routineHeld(ev, readEvent(w.evDir).entries, 'c002', 2), null, 'stopped: back to the user');
});
