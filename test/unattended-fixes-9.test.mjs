// The independent review of 45bf380 (2026-11-17): one test per behaviour item, each failing on the code with its fix
// taken out. Through the real guard, launcher checks and flow in throwaway homes; nothing here starts Claude Code,
// launchctl or a real mail, CRM or calendar tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, clone, ticket, start, readMail, stageItem, stage, bashCall, scriptCmd, hook, ledgerOf, MAIL_OK } from './fixtures/unattended-world.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';

const BASE = world();
const inHome = (H, now, fn) => {
  const a = process.env.FLOORBOSS_HOME;
  const b = process.env.FLOORBOSS_NOW;
  process.env.FLOORBOSS_HOME = H.HOME;
  process.env.FLOORBOSS_NOW = now;
  try {
    return fn();
  } finally {
    if (a === undefined) delete process.env.FLOORBOSS_HOME;
    else process.env.FLOORBOSS_HOME = a;
    if (b === undefined) delete process.env.FLOORBOSS_NOW;
    else process.env.FLOORBOSS_NOW = b;
  }
};
const due = (H, now) => inHome(H, now, () => followupsDue(Date.parse(now), []));
const keys = (list) => list.map((x) => `${x.id}:${x.touch}`);

test('R-F1: after your word that a draft is not there, the launcher spends no run on it the day it was let through, and lists it again the next day', async () => {
  // Tue 13 08:00: run 1 lets follow-up 1 through with no result back; at 09:00 you say it isn't in your drafts.
  const H = clone(BASE);
  const t1 = await ticket(H);
  assert.equal(start(H, t1).code, 0);
  assert.equal(readMail(H, t1, MAIL_OK).pre.decision, 'allow');
  assert.equal(stage(H, t1, stageItem(H, t1), { post: false }).pre.decision, 'allow');
  const T = '2026-10-13T09:00:00Z';
  bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'notthere'), { session: 's-r1', now: T });
  assert.ok(ledgerOf(H).some((e) => e.type === 'stage_cleared' && e.id === H.ana && e.touch === 2), 'stage_cleared written');
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-r1' }, { now: T });
  // The same day: waiting, with why, never on a ticket (the guard would refuse it for its day marker).
  for (const now of ['2026-10-13T10:00:00Z', '2026-10-13T12:00:00Z']) {
    const d = due(H, now);
    assert.ok(!keys(d.items).includes(`${H.ana}:2`), `${now}: not on a ticket`);
    const w = (d.waiting || []).find((x) => x.id === H.ana && x.touch === 2);
    assert.ok(w, `${now}: waiting`);
    assert.match(w.why, /already let through today, so it can't go in again on its own today: it goes in again on its own from a later day/);
  }
  H.now = '2026-10-13T10:00:00Z';
  assert.equal((await ticket(H)).items.length, 0, 'no run started for it that day');
  // The next day it is listed again.
  const n = '2026-10-14T10:00:00Z';
  assert.ok(keys(due(H, n).items).includes(`${H.ana}:2`), 'listed the next day');
});

test('R-F2: your word given the day after the draft was let through lets it go in on its own that same day', async () => {
  // Released Tue 13, your word Wed 14 08:30, a run Wed 14 10:00: allowed (the day rule is "not again on the day the
  // first draft was let through", not "from the day after your word").
  const H = clone(BASE);
  const t1 = await ticket(H);
  assert.equal(start(H, t1).code, 0);
  assert.equal(readMail(H, t1, MAIL_OK).pre.decision, 'allow');
  assert.equal(stage(H, t1, stageItem(H, t1), { post: false }).pre.decision, 'allow');
  const W = '2026-10-14T08:30:00Z';
  bashCall(H, scriptCmd('event-outreach', 'draft-missing', '--event', H.slug, '--id', H.ana, '--touch', '2', '--said', 'notthere'), { session: 's-r2', now: W });
  hook(H, { hook_event_name: 'SessionEnd', session_id: 's-r2' }, { now: W });
  H.now = '2026-10-14T10:00:00Z';
  assert.ok(keys(due(H, H.now).items).includes(`${H.ana}:2`), 'the launcher lists it');
  const t2 = await ticket(H);
  assert.equal(t2.items.length, 1);
  assert.equal(start(H, t2).code, 0);
  assert.equal(readMail(H, t2, MAIL_OK).pre.decision, 'allow');
  const r = stage(H, t2, stageItem(H, t2), { post: false }).pre;
  assert.equal(r.decision, 'allow', `${r.code} ${r.stderr}`);
  assert.equal(ledgerOf(H).filter((e) => e.type === 'stage_released' && e.touch === 2).length, 2);
});
