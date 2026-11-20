// Security audit run 10, findings 2, 3 and 4 (auto-send, Codex). 2: after a missed follow-up is planned again for
// auto-send, the outbox card works out its day as the planner does, so it never offers by hand a message the cloud
// still has due (a double send). 3: a send step is never given while its release mark is only an uncommitted change
// in the cloud clone (a run killed between the write and the commit). 4: the clock-behind check reads every event's
// ledger, not only the auto-send events'. Fake remotes only; nothing is sent. Addresses are .example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { world, addLines, ledgerLines, remoteFor, cloneOf, remoteFile, git, PEOPLE, NOW, EVENT, ROOT } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { readEvent } from '../lib/autosend/common.mjs';
import { legacyState } from '../lib/ledger.mjs';
import { todayKeyIn } from '../lib/tz.mjs';
import { next } from '../skills/autosend/scripts/driver.mjs';
import { autosendCard } from '../skills/event-outreach/scripts/commands/cards.mjs';
import { followupDayOf } from '../skills/event-outreach/scripts/commands/saved-drafts.mjs';
import { offersCopy, mailOf } from '../skills/event-outreach/scripts/outbox.mjs';

const at = (iso) => Date.parse(iso);
const SENTENCE = 'auto-send these sequences';
function approved(opts = {}) {
  const w = world({ touches: 2, ...opts });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: SENTENCE }, at(NOW));
  return w;
}

// ---- Finding 2

test('finding 2: a follow-up planned again after a missed day: on the days the planner has it due the card has no hand-send buttons; once truly missed, it has them', () => {
  const w = approved({ people: [PEOPLE[0]] });
  const h1 = ledgerLines(w.evDir).find((e) => e.type === 'autosend_approved' && e.touch === 1).hash;
  // The cloud sent message 1 on Mon 12 Oct.
  addLines(w.evDir, [
    { at: '2026-10-12T09:00:00Z', type: 'autosend_released', who: 'floorboss', id: 'c001', touch: 1, hash: h1, to: PEOPLE[0].email, run: 'r1' },
    { at: '2026-10-12T09:00:30Z', type: 'sent', who: 'floorboss', id: 'c001', touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', message_id: 'm1', thread_id: 't1', hash: h1, source: 'autosend' }
  ]);
  const ev = JSON.parse(readFileSync(join(w.evDir, 'event.json'), 'utf8'));
  const keep = process.env.CODEX_SESSION_ID;
  process.env.CODEX_SESSION_ID = 'codex-sess';
  try {
    // The card as the outbox works it out (cards.mjs: dueOf is followupDayOf for a follow-up).
    const card = (nowIso) => {
      const { entries, folded } = readEvent(w.evDir);
      const c = { event: ev, today: todayKeyIn(ev.time_zone, new Date(at(nowIso))), settings: ev.settings, state: legacyState(folded), folded, entries };
      const drafted = entries.filter((e) => e.type === 'drafted' && e.id === 'c001' && e.touch === 2).pop();
      const due = followupDayOf(c, 'c001', 2, drafted);
      const s = autosendCard(c, { kind: 'message', id: 'c001', touch: 2 }, due);
      const shown = { kind: 'message', channel: 'email', you_send: true, pending: false, send_to: PEOPLE[0].email, subject: 's', body: 'b', autosend: s.live && !s.missed ? true : undefined, autosend_missed: s.live && s.missed ? s.day : undefined };
      return { buttons: offersCopy(shown) || !!mailOf(shown), missed: s.missed };
    };
    const dueHere = (nowIso) => dueNow(w.HOME, at(nowIso)).due.some((x) => x.id === 'c001' && x.touch === 2);
    // Message 2 was due 19 Oct; the task was paused, so 21 Oct finds it missed: the user's, with buttons.
    assert.equal(dueHere('2026-10-21T09:30:00Z'), false);
    assert.equal(card('2026-10-21T09:30:00Z').buttons, true);
    // The user asks for it to be planned again (a fresh readback and yes, with their word it wasn't sent).
    const rb = readback(w.evDir, at('2026-10-21T09:30:00Z'));
    assert.deepEqual(rb.items.map((x) => [x.touch, x.planned_day, !!x.missed]), [[2, '2026-10-21', true]]);
    approve(w.evDir, { digest: rb.digest, said: SENTENCE, notSentSaid: 'I did not send it' }, at('2026-10-21T09:30:00Z'));
    for (const d of ['2026-10-21T10:00:00Z', '2026-10-22T09:30:00Z']) {
      assert.equal(dueHere(d), true, `the planner has it due on ${d}`);
      assert.deepEqual(card(d), { buttons: false, missed: false }, `no hand-send buttons on ${d}`);
    }
    // 23 Oct: its new day and the day after went by: missed for the planner and back to the user on the card.
    assert.equal(dueHere('2026-10-23T09:30:00Z'), false);
    assert.deepEqual(card('2026-10-23T09:30:00Z'), { buttons: true, missed: true });
  } finally {
    if (keep === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = keep;
  }
});

// ---- Finding 3

test('finding 3: checked is SIGKILLed between writing the release and committing it: next never returns the send, and it stays due', { timeout: 120000 }, () => {
  const w = approved({ touches: 1, people: [PEOPLE[0]] });
  const { bare } = remoteFor(w.HOME);
  const dir = cloneOf(bare);
  process.env.FLOORBOSS_HOME = dir;
  const now = at('2026-10-12T10:00:00Z');
  const s = next(dir, { run: 'new', nowMs: now });
  assert.equal(s.step, 'search', JSON.stringify(s).slice(0, 300));
  writeFileSync(s.write, JSON.stringify({ messages: [] }));
  // A git that kills its caller at the first `git status` (the first call checkpoint makes, after the writes).
  const bin = mkdtempSync(join(tmpdir(), 'fb-a10-bin-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "status" ]; then kill -9 $PPID; sleep 3; exit 1; fi; done\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const child = `const { checked } = await import(${JSON.stringify(join(ROOT, 'skills/autosend/scripts/driver.mjs'))}); console.log(JSON.stringify(checked(${JSON.stringify(dir)}, { run: ${JSON.stringify(s.run)}, file: ${JSON.stringify(s.write)}, nowMs: ${now + 1000} })));`;
  const env = { ...process.env, FLOORBOSS_HOME: dir, FLOORBOSS_TEST: '1', PATH: `${bin}:${process.env.PATH}` };
  const k = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(k.signal, 'SIGKILL', `${k.stdout} ${k.stderr}`);
  // The state the audit found: the release only as an uncommitted change here, the send step saved.
  assert.match(git(dir, ['status', '--porcelain']), /M events\/harbor-expo\/ledger\.jsonl/);
  const run = JSON.parse(readFileSync(join(dir, 'autosend', 'runs', `${s.run}.json`), 'utf8'));
  assert.equal(run.current.step, 'send');
  assert.ok(!(remoteFile(bare, 'events/harbor-expo/ledger.jsonl') || '').includes('autosend_released'));
  const n = next(dir, { run: s.run, nowMs: now + 2000 });
  assert.notEqual(n.step, 'send', JSON.stringify(n).slice(0, 300));
  assert.equal(n.step, 'stop');
  assert.match(n.why, /nothing was sent/);
  assert.ok(!('args' in n));
  assert.ok(!(remoteFile(bare, 'events/harbor-expo/ledger.jsonl') || '').includes('autosend_released'));
  assert.equal(remoteFile(bare, 'autosend/lock.json'), null, 'the lock released');
});

// ---- Finding 4

test('finding 4: the clock a day behind the latest line of an event without auto-send: nothing is due', () => {
  const w = approved({ people: [PEOPLE[0]] });
  const B = { ...EVENT, slug: 'dock-days', name: 'Dock Days', autosend: false };
  world({ touches: 1, home: w.HOME, event: B, people: [{ ...PEOPLE[0], id: 'c050' }] });
  addLines(join(w.HOME, 'events', 'dock-days'), [{ at: '2026-10-13T09:00:00Z', type: 'sent', who: 'user', id: 'c050', touch: 1, via: 'email.send', channel: 'email', date: '2026-10-13', source: 'hand' }]);
  // The clock right: she waits (another message went to her today).
  assert.deepEqual(dueNow(w.HOME, at('2026-10-13T09:30:00Z')).due, []);
  // A day behind: nothing goes, and it says why.
  const r = dueNow(w.HOME, at('2026-10-12T09:30:00Z'));
  assert.deepEqual(r.due, []);
  assert.match(String(r.blocked), /the clock .* is behind what your data repo records/);
});
