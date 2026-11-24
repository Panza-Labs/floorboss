// The unattended drafts on top of main's rules (one message a day across all your events, the per-address send locks,
// what your other events lend about a person) and the ledger merge: through the real guard, in throwaway homes.
// - An unattended draft is refused when another event let a message to that person through today, before or after
//   the run's stage list, and the launcher puts no one on a ticket whom that rule holds today.
// - It is refused when another event recorded a stop for them after the stage list (lib/sendcheck.mjs lentChanged).
// - Its once mark, day marker and release are taken under the same send locks a send takes (hooks/guard/daymark.mjs
//   sendLocks): a lock held by a live call refuses it, leaves nothing, and lets the next run try again.
// - Another event's person who shares only an inbox address (info@) under another name is not this person.
// - call_result, stage_released and stage_cleared survive the ledger merge, and only the hooks write the first two.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, mkdtempSync, appendFileSync, utimesSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { world, clone, ticket, start, readMail, stageItem, stage, logOf, ledgerOf, MAIL_OK, ANA, ROOT } from './fixtures/unattended-world.mjs';
import { followupsDue } from '../scripts/scheduled.mjs';
import { crossEventWhy } from '../hooks/guard/unattended.mjs';
import { sendLocks } from '../hooks/guard/daymark.mjs';
import { readLedgerText, fold, legacyState } from '../lib/ledger.mjs';

const BASE = world();
const BASE_ITEMS = (await ticket(clone(BASE))).items;

const refused = (r, re) => {
  assert.equal(r.code, 2, `expected a refusal, got ${r.code} ${r.decision} ${r.stderr}`);
  assert.equal(r.decision, null, 'never allow or ask');
  if (re) assert.match(r.stderr, re);
};
const nothingLeft = (H) => {
  assert.ok(!ledgerOf(H).some((e) => e.type === 'stage_released'), 'no release');
  const rel = existsSync(join(H.dir, 'released')) ? readdirSync(join(H.dir, 'released')) : [];
  assert.deepEqual(rel.filter((f) => /^ustage-/.test(f) || (/-day-/.test(f) && !f.endsWith('-day-2026-10-12'))), [], 'no once mark or day marker left');
};
// A second event in the same home with Ana on its list; lines: more of its ledger.
function second(H, lines = []) {
  const ev2 = join(H.HOME, 'events', 'ev2');
  mkdirSync(ev2, { recursive: true });
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  writeFileSync(join(ev2, 'event.json'), JSON.stringify({ ...ev, slug: 'ev2', name: 'Other Expo' }));
  const all = [{ at: '2026-09-01T00:00:00Z', type: 'person', who: 'floorboss', id: 'c001', name: 'Ana Berg', company: 'Acme', email: ANA, keys: [] }, ...lines];
  writeFileSync(join(ev2, 'ledger.jsonl'), all.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return ev2;
}
const LET_THROUGH_TODAY = (H) => ({ at: `${H.now.slice(0, 10)}T07:30:00Z`, type: 'send_released', who: 'guard', id: 'c001', touch: 1, via: 'email.send', to: ANA });
async function run(H) {
  const t = await ticket(H, { items: BASE_ITEMS });
  assert.equal(start(H, t).code, 0);
  assert.equal(readMail(H, t, MAIL_OK).pre.decision, 'allow');
  return t;
}
function due(H) {
  const was = [process.env.FLOORBOSS_HOME, process.env.FLOORBOSS_NOW];
  process.env.FLOORBOSS_HOME = H.HOME;
  process.env.FLOORBOSS_NOW = H.now;
  try {
    return followupsDue(Date.parse(H.now));
  } finally {
    for (const [k, v] of [['FLOORBOSS_HOME', was[0]], ['FLOORBOSS_NOW', was[1]]]) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test('the base world drafts follow-up 1 on its own, under the send locks, with its release counted by the one-a-day rule', async () => {
  const H = clone(BASE);
  assert.deepEqual(due(H).items.map((x) => [x.id, x.touch]), [['c001', 2]]);
  const t = await run(H);
  const r = stage(H, t, stageItem(H, t));
  assert.equal(r.pre.decision, 'allow', r.pre.stderr);
  const rel = ledgerOf(H).filter((e) => e.type === 'stage_released');
  assert.equal(rel.length, 1);
  assert.equal(rel[0].unattended, true);
  // No send lock is left behind.
  assert.deepEqual(readdirSync(H.HOME).filter((f) => /^send-.*\.lock$/.test(f)), []);
  // The unattended draft counts as today's message to her at another event (as a send's release does).
  const ev2 = second(H);
  const { addressBusyToday } = await import('../lib/sendcheck.mjs');
  process.env.FLOORBOSS_HOME = H.HOME;
  assert.deepEqual(addressBusyToday(ev2, ANA, Date.parse(H.now), 'c001'), { slug: 'ev' });
});

test('another event let a message to her through today: the launcher waits on her with no run, the stage list holds her, and a draft listed before it is refused', async () => {
  // Before the run: the launcher puts no one on a ticket whom main's one-a-day rule holds today, and says why once.
  {
    const H = clone(BASE);
    second(H, [LET_THROUGH_TODAY(H)]);
    const d = due(H);
    assert.deepEqual(d.items, [], 'not on a ticket');
    assert.match(d.waiting.map((w) => w.why).join(' | '), /another message to Ana Berg \(ana@acme\.test\) already went or is going today, for ev2/);
    // And the run's own stage list holds her, with the reason.
    const t = await ticket(H, { items: BASE_ITEMS });
    start(H, t);
    assert.equal(stageItem(H, t), null, 'not listed to stage');
  }
  // After the stage list: the guard refuses the draft, by main's rule (its reason names the other event), and leaves
  // nothing behind.
  {
    const H = clone(BASE);
    const t = await run(H);
    const it = stageItem(H, t);
    second(H, [LET_THROUGH_TODAY(H)]);
    refused(stage(H, t, it, { post: false }).pre, /another message to Ana Berg \(ana@acme\.test\) already went or is going today, for ev2/);
    nothingLeft(H);
  }
});

test('another event recorded a stop for her after the stage list: the draft is refused by the lent re-check, and nothing is taken', async () => {
  const H = clone(BASE);
  const ev2 = second(H);
  const t = await run(H);
  const it = stageItem(H, t);
  assert.match(String(it.elsewhere), /^[0-9a-f]{24}$/, 'the stage list records what the other events lend about her');
  appendFileSync(join(ev2, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-13T07:00:00Z', type: 'stop', who: 'user', id: 'c001', said: 'please stop' })}\n`);
  refused(stage(H, t, it, { post: false }).pre, /something floorboss reads about them changed at another of your events since this list was made/);
  nothingLeft(H);
});

test('a send lock for her address held by a live call: the draft is refused, nothing is left, and it is tried again at the next run', async () => {
  const H = clone(BASE);
  const t = await run(H);
  const it = stageItem(H, t);
  process.env.FLOORBOSS_HOME = H.HOME;
  const [name] = sendLocks(H.dir, 'c001', ANA);
  const lock = join(H.HOME, `${name}.lock`);
  mkdirSync(lock);
  // Held by this test's own process, which is alive: never broken while it is young. Its time is set an hour ahead, so
  // it stays young by the wall clock however long the machine stalls or sleeps before the guard looks.
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const ahead = new Date(Date.now() + 3600 * 1000);
  utimesSync(lock, ahead, ahead);
  const r = stage(H, t, it, { post: false }).pre;
  refused(r, /another call to them was being checked at this moment/);
  nothingLeft(H);
  assert.ok(existsSync(lock), "the other call's lock is left as it was");
  const held = logOf(H).filter((e) => e.type === 'held' && e.id === 'c001').pop();
  assert.equal(held?.retry, true, 'a timing hold: the next run tries again');
});

test("another event's person who shares only an inbox address under another name is someone else; the same name is her", () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-um-'));
  process.env.FLOORBOSS_HOME = H;
  const ev = (slug, lines) => {
    const d = join(H, 'events', slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'event.json'), JSON.stringify({ slug, name: slug, time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12' }));
    writeFileSync(join(d, 'ledger.jsonl'), lines.map((e) => `${JSON.stringify(e)}\n`).join(''));
  };
  const person = (id, name, email) => ({ at: '2026-09-01T00:00:00Z', type: 'person', who: 'floorboss', id, name, company: 'Acme', email, keys: [] });
  ev('ev', [person('c001', 'Ana Berg', 'info@acme.test')]);
  ev('ev2', [person('c007', 'Bo Lind', 'info@acme.test'), { at: '2026-10-12T09:00:00Z', type: 'stop', who: 'user', id: 'c007', said: 'stop' }]);
  const nowMs = Date.parse('2026-10-13T08:00:00Z');
  assert.equal(crossEventWhy({ slug: 'ev', id: 'c001', to: 'info@acme.test', since: 0, nowMs }), null, "Bo's stop is not Ana's");
  ev('ev3', [person('c009', 'Ana Berg', 'info@acme.test'), { at: '2026-10-12T09:00:00Z', type: 'stop', who: 'user', id: 'c009', said: 'stop' }]);
  assert.match(crossEventWhy({ slug: 'ev', id: 'c001', to: 'info@acme.test', since: 0, nowMs }) || '', /at your event ev3, they said stop/);
  // An ordinary address written the same way is still the same person, whatever the name.
  ev('ev', [person('c001', 'Ana Berg', 'ana@acme.test')]);
  ev('ev3', []);
  ev('ev2', [person('c007', 'A. Berg', 'ana@acme.test'), { at: '2026-10-12T09:00:00Z', type: 'stop', who: 'user', id: 'c007', said: 'stop' }]);
  assert.match(crossEventWhy({ slug: 'ev', id: 'c001', to: 'ana@acme.test', since: 0, nowMs }) || '', /at your event ev2, they said stop/);
});

test('call_result, stage_released and stage_cleared survive the ledger merge; only the hooks write call_result and stage_released', () => {
  const lines = [
    { at: '2026-10-12T08:00:00Z', type: 'person', who: 'floorboss', id: 'c001', name: 'Ana Berg', email: ANA },
    { at: '2026-10-12T08:00:01Z', type: 'drafted', who: 'floorboss', id: 'c001', touch: 1, hash: 'h1' },
    { at: '2026-10-12T08:00:30Z', type: 'call_result', who: 'guard', id: 'c001', touch: 1, kind: 'send', message_id: 'M1', thread_id: 'T1', tool: 'send_message' },
    { at: '2026-10-12T08:01:00Z', type: 'sent', who: 'floorboss', id: 'c001', touch: 1, date: '2026-10-12', message_id: 'claude-said', thread_id: 'claude-said' },
    { at: '2026-10-13T08:00:00Z', type: 'drafted', who: 'floorboss', id: 'c001', touch: 2, hash: 'h2' },
    { at: '2026-10-13T08:00:10Z', type: 'stage_released', who: 'guard', id: 'c001', touch: 2, hash: 'h2', to: ANA, thread_id: 'T1', unattended: true, run: 's' },
    { at: '2026-10-13T08:00:20Z', type: 'call_result', who: 'guard', id: 'c001', touch: 2, kind: 'draft', message_id: 'M2', thread_id: 'T1', draft_id: 'D2', tool: 'create_draft' },
    { at: '2026-10-13T08:00:30Z', type: 'staged', who: 'guard', id: 'c001', touch: 2, draft_id: 'D2', unattended: true }
  ];
  const st = fold(readLedgerText(lines.map((e) => JSON.stringify(e)).join('\n')).entries);
  const x1 = st.people.c001.touches[1];
  assert.deepEqual([x1.sent.message_id, x1.sent.thread_id], ['M1', 'T1'], "the send tool's own answer wins over the receipt");
  const x2 = st.people.c001.touches[2];
  assert.deepEqual([x2.stage_released.unattended, x2.staged.draft_id, x2.staged.message_id, x2.staged.unattended], [true, 'D2', 'M2', true]);
  assert.ok(legacyState(st).c001.touches[2].stage_released, 'the legacy state carries it');
  // A new text makes the unattended draft of the old one no longer this step's; the user's "it isn't there" clears one
  // that never got a receipt.
  const re = fold(readLedgerText([...lines.slice(0, 6), { at: '2026-10-14T00:00:00Z', type: 'drafted', who: 'floorboss', id: 'c001', touch: 2, hash: 'h3' }].map((e) => JSON.stringify(e)).join('\n')).entries);
  assert.equal(re.people.c001.touches[2].stage_released, null);
  const cl = fold(readLedgerText([...lines.slice(0, 6), { at: '2026-10-14T00:00:00Z', type: 'stage_cleared', who: 'user', id: 'c001', touch: 2 }].map((e) => JSON.stringify(e)).join('\n')).entries);
  assert.equal(cl.people.c001.touches[2].stage_released, null);
  // Only the guard's hooks write call_result and stage_released: no script, skill or library line writes them.
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', '.git', 'test', 'examples'].includes(e.name) ? [] : walk(join(d, e.name))) : e.name.endsWith('.mjs') ? [join(d, e.name)] : []));
  const writers = walk(ROOT)
    .filter((f) => /type:\s*'(call_result|stage_released)'/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f))
    .sort();
  // (hooks/guard/autosend-drafts.mjs: the guard's own reading of a create_draft it let through after the final approval.)
  assert.deepEqual(writers, ['hooks/guard/after-call.mjs', 'hooks/guard/autosend-drafts.mjs', 'hooks/guard/unattended.mjs']);
});
