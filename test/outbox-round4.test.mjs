// The outbox page and the send check, review round 4 (14 Nov). A send floorboss let through with no receipt yet was
// still offered to copy (B-F4); a coworker's note whose task was done counted as no change (B-F12); a hand edit more
// than 512 bytes before the end of the record went unseen once a quiet line was added (B-F10, C-D2); a triage decision
// or a cut at one event rebuilt every other page (F5, R2); a stop at another event for someone never messaged there was
// ignored by the page and the send check (B-F7), and the send check read only the sending event's record (B-F3); an
// older event whose page can't be built was reported after every write anywhere (B-F9); a live holder's page lock was
// broken by age, and an empty process-id file waited a minute (B-F8, r3-lock-empty-pid). And the rules the review's
// mutants showed untested (r3-tests, C-T1): a keep or a cap after approval, the day after the event, a write that
// lands during a build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, cpSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, NOW, ROOT } from './fixtures/harness.mjs';
import { outboxStale } from '../skills/event-outreach/scripts/commands/cards.mjs';
import { NO_PAGE_EFFECT } from '../skills/event-outreach/scripts/commands/page-inputs.mjs';

const LIST =
  'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nSigne Dahl,Ops Lead,All Nordic,signe@allnordic.test\nCy Ruiz,Head of Ops,Initech,cy@initech.test\nDee Moss,Supply Chain Lead,Umbrella,dee@umbrella.test\n';
const page = (H) => readFileSync(join(H.dir, 'outbox.html'), 'utf8');
const cards = (H) => [...page(H).matchAll(/<article class="card[^"]*" data-id="(c\d+)" data-touch="(\d+)"[\s\S]*?<\/article>/g)];
const copyable = (H) =>
  cards(H)
    .filter((m) => /class="copy"/.test(m[0]))
    .map((m) => `${m[1]}:${m[2]}`)
    .sort();
let n = 0;
const file = (H, name, o) => {
  const f = join(H.dir, `${name}-${n++}`);
  writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
  return f;
};
const withEnv = (env, fn) => {
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
};
const record = (H, items, { env = {}, now = NOW } = {}) => withEnv(env, () => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, 'rec.json', { items })], now));
const paths = (H) => ({ outbox: join(H.dir, 'outbox.html'), ledger: join(H.dir, 'ledger.jsonl') });
const stale = (H, now = NOW) => outboxStale(paths(H), { now: new Date(now) });
const stamp = (H) => {
  const s = statSync(join(H.dir, 'outbox.html'));
  return `${s.ino}:${s.mtimeMs}`;
};
const ledgerLines = (H) =>
  readFileSync(join(H.dir, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
// What a fresh build offers now, in a copy of the home.
const fresh = (H, now = NOW) => {
  const copy = join(H.HOME, '..', `fresh-${Math.random().toString(36).slice(2)}`);
  cpSync(H.HOME, copy, { recursive: true });
  const C = { ...H, HOME: copy, dir: join(copy, 'events', H.slug) };
  const r = cli(C, 'event-outreach', ['render', '--event', H.slug], now);
  assert.ok(!r.ERROR, r.ERROR);
  const out = copyable(C);
  rmSync(copy, { recursive: true, force: true });
  return out;
};
function approved(list = LIST, settings = {}) {
  const H = setup({ attendees: list, settings });
  triage(H);
  const r = draftApprove(H);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  return H;
}

test('B-F4: a send floorboss let through with no receipt yet is never offered to copy, and the card says it may have gone', () => {
  const H = approved();
  const ana = idOf(H, 'Ana Berg');
  assert.ok(copyable(H).includes(`${ana}:1`));
  const appr = ledgerLines(H).filter((e) => e.type === 'approved' && e.id === ana).pop();
  // The guard's own line, as hooks/guard.mjs writes it when it lets a send through.
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify({ at: '2026-10-12T07:59:00.000Z', type: 'send_released', who: 'guard', id: ana, touch: 1, hash: appr.hash, via: 'email.send', to: 'ana@acme.test' })}\n`);
  assert.equal(stale(H), true, 'a release is something the page reads');
  const r = cli(H, 'flow', ['next', '--event', H.slug]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(!copyable(H).includes(`${ana}:1`), 'no Copy for a message that may have gone');
  const card = cards(H).find((m) => m[1] === ana)?.[0] || '';
  assert.match(card, /floorboss let this message through to send \(2026-10-12 07:59 UTC\) and nothing says what happened: it may have gone/);
  assert.doesNotMatch(card, /data-li="1"/);
  assert.deepEqual(copyable(H), fresh(H));
  for (const t of ['send_released', 'task_created', 'task_done']) assert.equal(NO_PAGE_EFFECT.has(t), false, `${t} is read by the page`);
});

test('B-F12: a coworker\'s note leaves the page when only its task_done line was written (no tasks_read after it)', () => {
  const CRM =
    'First Name,Last Name,Email,Company,Deal Owner,Stage,Last Activity Date,Email Opt Out\nAna,Berg,ana@acme.test,Acme,Sam Rivera,Opportunity,10/02/2026,No\nBo,Li,bo@globex.test,Globex,Kees Jansen,Opportunity,10/02/2026,No\n';
  const H = setup({ attendees: LIST, crm: CRM, settings: { colleague_notes: true } });
  triage(H);
  assert.ok(!draftApprove(H).gate.ERROR);
  const bo = idOf(H, 'Bo Li');
  assert.ok(copyable(H).includes(`${bo}:1`), 'the note to the coworker is offered');
  const tl = cli(H, 'event-outreach', ['task-list', '--event', H.slug]);
  const items = JSON.parse(readFileSync(tl.file, 'utf8'));
  assert.ok(!cli(H, 'event-outreach', ['tasks-created', '--event', H.slug, '--file', file(H, 'tc.json', { tasks: items.map((i, k) => ({ key: i.key, task_id: `T-${k}` })) })]).ERROR);
  const k = items.findIndex((i) => i.id === bo && i.kind === 'coordinate');
  // The task_done line task-status writes, taken from a run in a copy; here the process stops before tasks_read.
  const copy = join(H.HOME, '..', `td-${Math.random().toString(36).slice(2)}`);
  cpSync(H.HOME, copy, { recursive: true });
  const C = { ...H, HOME: copy, dir: join(copy, 'events', H.slug) };
  assert.ok(!cli(C, 'event-outreach', ['task-status', '--event', H.slug, '--file', file(C, 'ts.json', { tasks: [{ task_id: `T-${k}`, status: 'done', completed_at: '2026-10-12T07:30:00Z' }] })]).ERROR);
  const done = ledgerLines(C).filter((e) => e.type === 'task_done').pop();
  rmSync(copy, { recursive: true, force: true });
  assert.ok(done, 'task-status wrote a task_done line');
  appendFileSync(join(H.dir, 'ledger.jsonl'), `${JSON.stringify(done)}\n`);
  assert.ok(!cli(H, 'flow', ['next', '--event', H.slug]).ERROR);
  assert.ok(!copyable(H).includes(`${bo}:1`), 'the coworker has the note: off the page');
  assert.deepEqual(copyable(H), fresh(H));
});

test('B-F10/C-D2: a record edited by hand anywhere in it is seen at the next step, though a quiet line came after', () => {
  const H = approved();
  const ana = idOf(H, 'Ana Berg');
  const led = join(H.dir, 'ledger.jsonl');
  // Quiet lines, so Ana's approval is far (over 512 bytes) from the end; flow next moves the page's record on to them.
  for (let k = 0; k < 12; k++) appendFileSync(led, `${JSON.stringify({ at: NOW, type: 'sync_ran', who: 'floorboss', source: 'mailbox' })}\n`);
  assert.ok(!cli(H, 'flow', ['next', '--event', H.slug]).ERROR);
  assert.equal(stale(H), false);
  const text = readFileSync(led, 'utf8');
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes('"type":"approved"') && l.includes(`"id":"${ana}"`));
  lines[i] = lines[i].replace(/("hash":"[0-9a-f]*)([0-9a-f])"/, (m, a, b) => `${a}${b === '0' ? '1' : '0'}"`);
  const edited = lines.join('\n');
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(text), 'the same size');
  assert.ok(Buffer.byteLength(text) - text.indexOf(lines[i]) > 512, 'more than 512 bytes from the end');
  writeFileSync(led, edited + JSON.stringify({ at: NOW, type: 'sync_ran', who: 'floorboss', source: 'mailbox' }) + '\n');
  assert.equal(stale(H), true);
  assert.ok(!cli(H, 'flow', ['next', '--event', H.slug]).ERROR);
  assert.ok(!copyable(H).includes(`${ana}:1`), 'the approval edited away is not offered');
  assert.deepEqual(copyable(H), fresh(H));
});

// Two events: A approved with a page, B triaged, with one person of its own (Zed Other).
function two() {
  const A = approved();
  const B = setup({ attendees: LIST + 'Zed Other,COO,Othercorp,zed@othercorp.test\n', home: A.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  return { A, B, cy: idOf(A, 'Cy Ruiz') };
}

test('F5/R2: a triage decision or a cut at another event, for someone this page doesn\'t have, leaves this page as it was', () => {
  const { A, B, cy } = two();
  const before = stamp(A);
  const zed = idOf(B, 'Zed Other');
  const d = cli(B, 'crm-triage', ['decide', '--event', B.slug, '--id', zed, '--group', 'warm', '--because', 'met him']);
  assert.ok(!d.ERROR, d.ERROR);
  assert.equal(stamp(A), before, 'a decide at B: A not written again');
  assert.equal(stale(A), false);
  const c = record(B, [{ who: 'Zed Other', what: 'cut', reason: 'not this time' }]);
  assert.equal(c.applied, true, JSON.stringify(c).slice(0, 300));
  assert.equal(stamp(A), before, 'a cut at B: A not written again');
  assert.equal(stale(A), false);
  // A send at B to someone A's page offers still takes them off at once.
  const s = record(B, [{ who: 'Cy Ruiz', what: 'sent', date: '2026-10-12' }]);
  assert.equal(s.applied, true);
  assert.ok(!copyable(A).includes(`${cy}:1`));
  assert.deepEqual(copyable(A), fresh(A));
});

test('B-F7: a stop at another event for someone never messaged there takes them off this page, said as a stop there', () => {
  const { A, B, cy } = two();
  assert.ok(copyable(A).includes(`${cy}:1`));
  const s = record(B, [{ who: 'Cy Ruiz', what: 'stop' }]);
  assert.equal(s.applied, true, JSON.stringify(s).slice(0, 300));
  assert.ok(!copyable(A).includes(`${cy}:1`), 'off A\'s page');
  assert.deepEqual(copyable(A), fresh(A));
  const tr = JSON.parse(readFileSync(join(A.dir, 'derived', 'compat', 'triage.json'), 'utf8'));
  const says = JSON.stringify(tr.final?.[cy] || tr.pre?.[cy] || {});
  assert.match(says, /asked not to be contacted \(said stop at Expo B\)/);
  assert.doesNotMatch(says, /messaged at Expo B on/);
});

// Sending on at A, with its send list made; the guard's check on the send to Cy.
const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
function sending() {
  const A = setup({ attendees: LIST, settings: { sending: { channels: ['email'], followups: 'scheduled' }, touches: 1 } });
  writeFileSync(join(A.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(A);
  assert.ok(!draftApprove(A).gate.ERROR);
  const B = setup({ attendees: LIST, home: A.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  return { A, B, cy: idOf(A, 'Cy Ruiz') };
}
const listed = (A, id) => {
  const l = cli(A, 'event-outreach', ['send-list', '--event', A.slug]);
  assert.ok(!l.ERROR, l.ERROR);
  return { list: l, item: JSON.parse(readFileSync(l.file, 'utf8')).find((x) => x.id === id) };
};
const guard = (A, item) => {
  const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
    input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: { to: item.to, subject: item.subject, body: item.body } }),
    env: { ...process.env, FLOORBOSS_HOME: A.HOME, FLOORBOSS_NOW: NOW },
    encoding: 'utf8'
  });
  return { refused: r.status === 2, asks: /"permissionDecision":"ask"/.test(r.stdout || ''), why: r.stderr || '' };
};

test('B-F3/B-F7: the send check refuses a send after a stop, or a send, for that person at another event since the list was made', () => {
  for (const what of [['stop'], ['sent', 'stop'], ['sent']]) {
    const { A, B, cy } = sending();
    const { item } = listed(A, cy);
    assert.ok(item?.elsewhere, 'the list records what the other events lend about them');
    // (Asked once, the guard marks the send as let through; the next test shows the ask itself.)
    for (const w of what) assert.equal(record(B, [{ who: 'Cy Ruiz', what: w, ...(w === 'sent' ? { date: '2026-10-12' } : {}) }]).applied, true);
    const g = guard(A, item);
    assert.equal(g.refused, true, `${what}: ${g.why}`);
    assert.match(g.why, /something floorboss reads about them changed at another of your events since this list was made \(a stop, a send, an approval or a CRM match answer\): make the list again/);
    // Made again, the list holds them back (the triage view reads B in full).
    const again = listed(A, cy);
    assert.equal(again.item, undefined, `${what}: not listed again`);
  }
});

test('B-F3: a person in touch at another event, and decided warm here after that, is listed and sent as before', () => {
  const { A, B, cy } = sending();
  assert.equal(record(B, [{ who: 'Cy Ruiz', what: 'sent', date: '2026-10-11' }]).applied, true);
  assert.equal(listed(A, cy).item, undefined, 'held as in touch');
  assert.ok(!cli(A, 'crm-triage', ['decide', '--event', A.slug, '--id', cy, '--group', 'warm', '--because', 'met at Expo B, a warm note is fine']).ERROR);
  const { item } = listed(A, cy);
  assert.ok(item, 'listed after the warm decision');
  assert.equal(guard(A, item).asks, true, 'the send check lets it through to the user');
});

test('B-F9: an older event whose page can\'t be built is said once, and again only when something it reads changes', () => {
  const H = approved();
  const O = setup({ attendees: LIST, home: H.HOME, event: { slug: 'old', name: 'Old Fair' } });
  triage(O);
  assert.ok(!draftApprove(O).gate.ERROR);
  rmSync(join(O.dir, 'attendees.csv'));
  const first = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', idOf(H, 'Bo Li'), '--group', 'reach', '--because', 'x']);
  assert.match(first.outbox_not_rebuilt || '', /the outbox page of Old Fair \(old\) could not be rebuilt/);
  assert.match(page(O), /This outbox page is out of date/);
  const again = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', idOf(H, 'Bo Li'), '--group', 'warm', '--because', 'y']);
  assert.ok(!again.ERROR, again.ERROR);
  assert.equal(again.outbox_not_rebuilt, undefined, 'nothing Old Fair reads changed: not said again');
  const cut = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'x' }]);
  assert.equal(cut.outbox_not_rebuilt, undefined);
  // At its own step it is tried again (and said); its list back, it is rebuilt.
  const nx = cli(O, 'flow', ['next', '--event', O.slug]);
  assert.match(JSON.stringify(nx), /could not be rebuilt|No attendee list/);
  writeFileSync(join(O.dir, 'attendees.csv'), LIST);
  assert.ok(!cli(O, 'flow', ['next', '--event', O.slug]).ERROR);
  assert.doesNotMatch(page(O), /This outbox page is out of date/);
});

test('B-F8/r3: the page lock is never broken while its holder runs; an empty or dead holder\'s lock is broken at once', async () => {
  const H = setup({ attendees: LIST });
  const code = (pidText, age) => `
    import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
    import { join } from 'node:path';
    const { withLock } = await import(${JSON.stringify(join(ROOT, 'lib/lock.mjs'))});
    const { PAGE_LOCK } = await import(${JSON.stringify(join(ROOT, 'skills/event-outreach/scripts/commands/cards.mjs'))});
    const lock = join(process.env.FLOORBOSS_HOME, 'outbox-ev.lock');
    mkdirSync(lock, { recursive: true });
    if (${JSON.stringify(pidText)} !== null) writeFileSync(join(lock, 'pid'), ${JSON.stringify(pidText)} === 'PARENT' ? String(process.ppid) : ${JSON.stringify(pidText)});
    const t = new Date(Date.now() - ${age}); utimesSync(lock, t, t);
    const s = Date.now();
    try { withLock('outbox-ev', () => 1, { ...PAGE_LOCK, waitMs: 2500 }); console.log(JSON.stringify({ took: Date.now() - s })); }
    catch (e) { console.log(JSON.stringify({ threw: e.message, after: Date.now() - s })); }`;
  const run = (pid, age) => {
    rmSync(join(H.HOME, 'outbox-ev.lock'), { recursive: true, force: true });
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code(pid, age)], { env: { ...process.env, FLOORBOSS_HOME: H.HOME }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  // Held by a live process (this test), folder 61 s old: waited for (here until the 2.5 s the test allows), never broken.
  const live = run('PARENT', 61000);
  assert.match(live.threw || '', /another floorboss process is busy with outbox-ev/, JSON.stringify(live));
  // An empty process-id file (killed between making it and writing it), 4 s old: the orphan rule, at once.
  const empty = run('', 4000);
  assert.ok(empty.took != null && empty.took < 1500, JSON.stringify(empty));
  // A holder that has ended: at once.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
  const gone = run(dead, 0);
  assert.ok(gone.took != null && gone.took < 1500, JSON.stringify(gone));
});

test('C-T1: a keep or a cap after approval takes the people cut off the page at once', () => {
  const H = approved();
  const before = copyable(H);
  assert.equal(before.length, 5);
  const k = cli(H, 'crm-triage', ['keep', '--event', H.slug, '--top', '1']);
  assert.ok(!k.ERROR, k.ERROR);
  assert.equal(copyable(H).length, 1, JSON.stringify(copyable(H)));
  assert.deepEqual(copyable(H), fresh(H));
  // A cap of one per company, on a list with two at one company.
  const L2 = LIST + 'Al Two,CTO,Acme,al@acme.test\n';
  const C = approved(L2);
  assert.ok(copyable(C).includes(`${idOf(C, 'Al Two')}:1`) && copyable(C).includes(`${idOf(C, 'Ana Berg')}:1`));
  const cap = cli(C, 'crm-triage', ['cap', '--event', C.slug, '--company', 'Acme', '--value', '1']);
  assert.ok(!cap.ERROR, cap.ERROR);
  assert.deepEqual(copyable(C), fresh(C));
  assert.equal(copyable(C).filter((x) => [idOf(C, 'Al Two'), idOf(C, 'Ana Berg')].includes(x.split(':')[0])).length, 1, 'one of the two left');
});

test('C-T1: the day after the event\'s last day, the next step rebuilds the page with nothing to copy', () => {
  const H = approved();
  assert.ok(!cli(H, 'flow', ['next', '--event', H.slug], '2026-11-12T10:00:00Z').ERROR);
  assert.ok(copyable(H).length, 'still on the last day');
  assert.equal(stale(H, '2026-11-12T10:00:00Z'), false);
  assert.equal(stale(H, '2026-11-13T10:00:00Z'), true, 'a new day is something the page reads');
  assert.ok(!cli(H, 'flow', ['next', '--event', H.slug], '2026-11-13T10:00:00Z').ERROR);
  assert.deepEqual(copyable(H), [], 'the event is over');
  assert.match(page(H), /Not going: the event is over/);
});

test('r3-tests: a record line written while the page is being built is seen before the command ends', () => {
  const H = approved();
  const bo = idOf(H, 'Bo Li');
  const line = JSON.stringify({ type: 'decide', who: 'user', id: bo, group: 'skip', because: 'not now', said: 'not now' });
  const r = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'x' }], { env: { FLOORBOSS_PAGE_APPEND: line } });
  assert.equal(r.applied, true, JSON.stringify(r).slice(0, 300));
  assert.ok(ledgerLines(H).some((e) => e.type === 'decide' && e.id === bo && e.group === 'skip'), 'the line landed during the build');
  assert.ok(!copyable(H).includes(`${bo}:1`), 'built again after it');
  assert.deepEqual(copyable(H), fresh(H));
  assert.equal(stale(H), false);
});
