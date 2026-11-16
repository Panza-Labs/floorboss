// What other events lend, read at the send and at staging, review round 5 (14 Nov). send-list checked once, before
// listing, that the other events' records were as its view read them: a stop recorded at another event while it listed
// gave the item a record that already held the stop, so the send check let the send to someone who said stop go to the
// prompt (N2). Staging re-checked only the event's own record, so a stop or a send at another event after the stage
// list was made didn't hold the draft for its 30 minutes (N5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, NOW, ROOT } from './fixtures/harness.mjs';
import { lentChanged, CHANGED_ELSEWHERE } from '../lib/sendcheck.mjs';
import { LENT_NOTHING } from '../lib/lent.mjs';

const LIST =
  'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nSigne Dahl,Ops Lead,All Nordic,signe@allnordic.test\nCy Ruiz,Head of Ops,Initech,cy@initech.test\nDee Moss,Supply Chain Lead,Umbrella,dee@umbrella.test\n';
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const STAGE = { ...RECIPE, tool: 'create_draft', tool_hash: 'd'.repeat(64) };
let n = 0;
const file = (H, name, o) => {
  const f = join(H.dir, `${name}-${n++}`);
  writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
  return f;
};
const record = (H, items) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, 'rec.json', { items })]);
const lines = (dir) =>
  readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const guard = (H, tool, item) => {
  const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: { to: item.to, subject: item.subject, body: item.body } }),
    env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW },
    encoding: 'utf8'
  });
  return { refused: r.status === 2, asks: r.status === 0 && /"permissionDecision":"ask"/.test(r.stdout || ''), why: r.stderr || '' };
};
// Two events in one home: A approved (sending on, or staging), B with the same people, triaged.
function two({ sending }) {
  const A = setup({ attendees: LIST, settings: sending ? { sending: { channels: ['email'], followups: 'scheduled' }, touches: 1 } : { touches: 1 } });
  writeFileSync(join(A.HOME, 'config.json'), JSON.stringify({ connectors: sending ? { 'email.send': RECIPE } : { stage_draft: STAGE } }));
  triage(A);
  assert.ok(!draftApprove(A).gate.ERROR);
  const B = setup({ attendees: LIST, home: A.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  return { A, B, cy: idOf(A, 'Cy Ruiz') };
}
// The line a stop for Cy at B writes, taken from a run in a copy of the home (nothing written to B itself).
function stopLine(B) {
  const copy = join(B.HOME, '..', `stop-${Math.random().toString(36).slice(2)}`);
  cpSync(B.HOME, copy, { recursive: true });
  const C = { ...B, HOME: copy, dir: join(copy, 'events', B.slug) };
  const was = lines(C.dir).length;
  assert.equal(record(C, [{ who: 'Cy Ruiz', what: 'stop' }]).applied, true);
  const line = lines(C.dir).slice(was).find((e) => e.type === 'stop');
  rmSync(copy, { recursive: true, force: true });
  assert.ok(line, 'record wrote a stop line');
  const { at, ...rest } = line;
  return rest;
}
const during = (line, fn) => {
  process.env.FLOORBOSS_LIST_APPEND = JSON.stringify({ event: 'evb', line });
  try {
    return fn();
  } finally {
    delete process.env.FLOORBOSS_LIST_APPEND;
  }
};

test('N2: a stop at another event recorded while send-list lists the items holds every item, and the guard refuses the send', () => {
  const { A, B, cy } = two({ sending: true });
  // The list as it was before (what a send would carry).
  const first = cli(A, 'event-outreach', ['send-list', '--event', A.slug]);
  assert.ok(!first.ERROR, first.ERROR);
  const before = JSON.parse(readFileSync(first.file, 'utf8')).find((x) => x.id === cy);
  assert.ok(before, 'Cy is listed before the stop');
  const line = stopLine(B);
  const l = during(line, () => cli(A, 'event-outreach', ['send-list', '--event', A.slug]));
  assert.ok(!l.ERROR, l.ERROR);
  assert.ok(lines(B.dir).some((e) => e.type === 'stop' && e.id === line.id), 'the stop landed at B while the list was made');
  const items = JSON.parse(readFileSync(l.file, 'utf8'));
  assert.equal(items.find((x) => x.id === cy), undefined, 'Cy is not listed to send');
  assert.equal(l.to_send, 0, 'every item waits: the view that judged them was read before the stop');
  const w = l.waiting.find((x) => x.id === cy);
  assert.match(w?.why || '', /another of your events changed while this list was made: make the list again/);
  const g = guard(A, 'mcp__gmail__send_email', before);
  assert.equal(g.refused, true, g.why);
  assert.equal(g.asks, false);
  // Made again, the list reads B in full: Cy is held, the others are listed.
  const again = cli(A, 'event-outreach', ['send-list', '--event', A.slug]);
  const now = JSON.parse(readFileSync(again.file, 'utf8'));
  assert.equal(now.find((x) => x.id === cy), undefined);
  assert.ok(now.length > 0, 'the others are listed again');
});

test('N2: the send check refuses an item marked as made while another event changed, and one whose record is not a digest', () => {
  const { A, cy } = two({ sending: true });
  const l = cli(A, 'event-outreach', ['send-list', '--event', A.slug]);
  const items = JSON.parse(readFileSync(l.file, 'utf8'));
  const it = items.find((x) => x.id === cy);
  const was = process.env.FLOORBOSS_HOME;
  process.env.FLOORBOSS_HOME = A.HOME;
  try {
    const P = { name: 'Cy Ruiz', email: 'cy@initech.test' };
    assert.equal(lentChanged(A.dir, it, P), null, 'as listed');
    for (const elsewhere of [CHANGED_ELSEWHERE, 'anything', 42, {}]) assert.equal(lentChanged(A.dir, { ...it, elsewhere }, P), 'another of your events changed while this list was made', String(elsewhere));
    assert.match(lentChanged(A.dir, { ...it, elsewhere: 'f'.repeat(24) }, P) || '', /changed at another of your events since this list was made/);
    assert.equal(lentChanged(A.dir, { ...it, elsewhere: undefined }, P) === null, it.elsewhere === LENT_NOTHING, 'an older item passes only when nothing is lent');
  } finally {
    process.env.FLOORBOSS_HOME = was;
  }
  writeFileSync(l.file, JSON.stringify(items.map((x) => ({ ...x, elsewhere: CHANGED_ELSEWHERE }))));
  const g = guard(A, 'mcp__gmail__send_email', it);
  assert.equal(g.refused, true, g.why);
  assert.match(g.why, /another of your events changed while this list was made: make the list again/);
});

test('N5: a stop or a send at another event after the stage list was made holds the draft at staging', () => {
  for (const what of ['stop', 'sent']) {
    const { A, B, cy } = two({ sending: false });
    const s = cli(A, 'event-outreach', ['stage-list', '--event', A.slug]);
    assert.ok(!s.ERROR, s.ERROR);
    const it = JSON.parse(readFileSync(s.file, 'utf8')).find((x) => x.id === cy);
    assert.ok(it?.elsewhere, 'the stage list records what the other events lend about them');
    assert.equal(record(B, [{ who: 'Cy Ruiz', what, ...(what === 'sent' ? { date: '2026-10-12' } : {}) }]).applied, true);
    const g = guard(A, 'mcp__gmail__create_draft', it);
    assert.equal(g.refused, true, `${what}: ${g.why}`);
    assert.match(g.why, /can't be staged now: something floorboss reads about them changed at another of your events since this list was made \(a stop, a send, an approval or a CRM match answer\): run "outreach stage-list" again/);
    // Made again, the list reads B in full and leaves Cy out.
    const again = cli(A, 'event-outreach', ['stage-list', '--event', A.slug]);
    assert.equal(JSON.parse(readFileSync(again.file, 'utf8')).find((x) => x.id === cy), undefined, what);
  }
});

test('N5: with nothing recorded elsewhere the draft still goes to the prompt; a stage list made while another event changed holds every item', () => {
  const { A, B, cy } = two({ sending: false });
  const s = cli(A, 'event-outreach', ['stage-list', '--event', A.slug]);
  const it = JSON.parse(readFileSync(s.file, 'utf8')).find((x) => x.id === cy);
  assert.equal(guard(A, 'mcp__gmail__create_draft', it).asks, true, 'nothing changed: the user is asked');
  const line = stopLine(B);
  const l = during(line, () => cli(A, 'event-outreach', ['stage-list', '--event', A.slug]));
  assert.ok(!l.ERROR, l.ERROR);
  assert.equal(l.to_stage, 0);
  const marked = JSON.parse(readFileSync(l.file, 'utf8'));
  assert.ok(marked.length > 0 && marked.every((x) => x.elsewhere === CHANGED_ELSEWHERE), 'every item is marked, and kept for the next list to know');
  assert.match(l.waiting.find((x) => x.id === cy)?.why || '', /another of your events changed while this list was made: run stage-list again/);
  const held = guard(A, 'mcp__gmail__create_draft', marked.find((x) => x.id === idOf(A, 'Ana Berg')));
  assert.equal(held.refused, true, 'a marked item is held at staging, even for someone nothing was recorded about');
  assert.match(held.why, /another of your events changed while this list was made: run "outreach stage-list" again/);
});
