// The outbox page records what it was built from (page-inputs.mjs): its own event's record and files, the settings,
// and every other event's record and lists. Any command that writes checks the pages (file sizes and times) and
// rebuilds only those whose inputs changed; flow next does the same. Review round 3 (14 Nov): a send or an approval at
// another event left this page offering Copy (B-1/C3); a lock left by a killed process stalled the next command for a
// minute (B-3); open and render wrote outside the lock (B-4); a failed rebuild left the old page copyable (B-5); folders
// that aren't events were rebuilt and named badly (B-6); a hand rewrite at the same size went unseen (B-8); every flow
// next and every connection check rebuilt every page (C4, C5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setup, cli, triage, idOf, draftApprove, NOW, ROOT } from './fixtures/harness.mjs';
import { outboxStale } from '../skills/event-outreach/scripts/commands/cards.mjs';
import { readLedger, fold } from '../lib/ledger.mjs';
import { pageInputs, watchedFolders } from '../skills/event-outreach/scripts/commands/page-inputs.mjs';

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
const record = (H, items, env = {}) => {
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    return cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, 'rec.json', { items })]);
  } finally {
    for (const k of Object.keys(env)) if (before[k] === undefined) delete process.env[k];
    else process.env[k] = before[k];
  }
};
const paths = (H) => ({ outbox: join(H.dir, 'outbox.html'), ledger: join(H.dir, 'ledger.jsonl') });
const stale = (H) => outboxStale(paths(H), { now: new Date(NOW) });
const ino = (H) => statSync(join(H.dir, 'outbox.html')).ino;
// What the ledgers allow at this event: approved for the text saved now, not sent, and contactable (a send or an
// approval at another event holds the person here as in touch, which only the full view knows: a fresh render).
const fresh = (H) => {
  const copy = join(H.HOME, `..`, `fresh-${Math.random().toString(36).slice(2)}`);
  cpSync(H.HOME, copy, { recursive: true });
  const C = { ...H, HOME: copy, dir: join(copy, 'events', H.slug) };
  const r = cli(C, 'event-outreach', ['render', '--event', H.slug]);
  assert.ok(!r.ERROR, r.ERROR);
  const out = copyable(C);
  rmSync(copy, { recursive: true, force: true });
  return out;
};
function two() {
  const A = setup({ attendees: LIST });
  triage(A);
  const r = draftApprove(A);
  assert.equal(r.gate.approved, 5, JSON.stringify(r.gate).slice(0, 300));
  const B = setup({ attendees: LIST, home: A.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  return { A, B, cy: idOf(A, 'Cy Ruiz') };
}

test('B-1/C3: a send recorded at another event takes the person off this page at once', () => {
  const { A, B, cy } = two();
  assert.ok(copyable(A).includes(`${cy}:1`));
  const r = record(B, [{ who: 'Cy Ruiz', what: 'sent', date: '2026-10-12' }]);
  assert.equal(r.applied, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.outbox_not_rebuilt, undefined);
  assert.ok(!copyable(A).includes(`${cy}:1`), "off the first event's page");
  assert.deepEqual(copyable(A), fresh(A));
  assert.equal(stale(A), false);
});

test('B-1: an approval at another event takes the person off this page, so one person never has two pages to copy from', () => {
  const { A, B, cy } = two();
  const d = cli(B, 'crm-triage', ['decide', '--event', B.slug, '--id', idOf(B, 'Cy Ruiz'), '--group', 'warm', '--because', 'met at the fair']);
  assert.ok(!d.ERROR, d.ERROR);
  const g = draftApprove(B, NOW, `approve ${idOf(B, 'Cy Ruiz')}`);
  assert.ok(!g.gate.ERROR, g.gate.ERROR);
  assert.ok(copyable(B).includes(`${idOf(B, 'Cy Ruiz')}:1`), 'approved at B');
  assert.ok(!copyable(A).includes(`${cy}:1`), 'so no longer offered at A');
  assert.deepEqual(copyable(A), fresh(A));
});

test('B-1: a line at another event that no other event reads (a sync, a note) leaves this page as it was', () => {
  const { A, B } = two();
  const before = ino(A);
  const led = join(B.dir, 'ledger.jsonl');
  writeFileSync(led, readFileSync(led, 'utf8') + JSON.stringify({ at: NOW, type: 'sync_ran', who: 'floorboss', source: 'mailbox' }) + '\n');
  assert.equal(stale(A), false, 'a sync line is quiet');
  cli(B, 'crm-triage', ['note', '--event', B.slug, '--id', idOf(B, 'Bo Li'), '--text', 'likes trains']);
  assert.equal(stale(A), false, 'a note at B is nothing A reads');
  assert.equal(ino(A), before, 'not written again');
});

test('B-2: a read that meets a file swapped at that moment is tried again before the page is called out of date', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const before = copyable(H);
  const once = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'moved jobs' }], { FLOORBOSS_PAGE_SWAP: '1' });
  assert.equal(once.applied, true);
  assert.equal(once.outbox_not_rebuilt, undefined, 'tried again, and rebuilt');
  assert.ok(!copyable(H).includes(`${idOf(H, 'Signe Dahl')}:1`));
  assert.equal(before.length - 1, copyable(H).length);
  // Swapped twice in a row: said, and the page offers nothing until it is rebuilt.
  const twice = record(H, [{ who: 'Bo Li', what: 'cut', reason: 'x' }], { FLOORBOSS_PAGE_SWAP: '2' });
  assert.match(twice.outbox_not_rebuilt || '', /could not be rebuilt: \(test\) derived\/todo\.json changed while floorboss read it\./);
  assert.match(page(H), /This outbox page is out of date/);
  assert.deepEqual(copyable(H), []);
  assert.doesNotMatch(page(H), /class="copy"|data-tick/);
  // The next step puts it right.
  cli(H, 'flow', ['next', '--event', H.slug]);
  assert.deepEqual(copyable(H), fresh(H));
});

test('B-3: a page lock left by a killed process is broken at once; one with no holder after 3 seconds', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  // A lock whose holder is gone: its process id, of a process that has ended.
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(join(H.HOME, 'outbox-ev.lock'));
  writeFileSync(join(H.HOME, 'outbox-ev.lock', 'pid'), gone);
  let t0 = Date.now();
  const r = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'moved jobs' }]);
  const ms = Date.now() - t0;
  assert.equal(r.applied, true);
  assert.equal(r.outbox_not_rebuilt, undefined);
  assert.ok(ms < 20000, `took ${ms} ms (a minute before)`);
  assert.ok(!copyable(H).includes(`${idOf(H, 'Signe Dahl')}:1`));
  assert.ok(!existsSync(join(H.HOME, 'outbox-ev.lock')), 'released');
  // A lock folder with no holder's id in it (left by an older version, or a process killed the moment it took it).
  mkdirSync(join(H.HOME, 'outbox-ev.lock'));
  t0 = Date.now();
  const r2 = record(H, [{ who: 'Bo Li', what: 'cut', reason: 'x' }]);
  const ms2 = Date.now() - t0;
  assert.equal(r2.outbox_not_rebuilt, undefined);
  assert.ok(ms2 < 25000, `took ${ms2} ms`);
  assert.ok(!copyable(H).includes(`${idOf(H, 'Bo Li')}:1`));
});

test('B-4: open writes the page through its lock: it waits for a rebuild in progress', async () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const lock = join(H.HOME, 'outbox-ev.lock');
  mkdirSync(lock);
  // Held by a live process (this one).
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const before = ino(H);
  const done = new Promise((res) => {
    const p = spawn('node', [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'open', '--event', H.slug, '--no-open'], {
      env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW },
      stdio: 'ignore'
    });
    p.on('close', res);
  });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ino(H), before, 'not written while another holds the lock');
  rmSync(lock, { recursive: true, force: true });
  assert.equal(await done, 0);
  assert.notEqual(ino(H), before, 'written once the lock was free');
  assert.equal(stale(H), false);
});

test('B-5: a page that can\'t be rebuilt is replaced by one that offers nothing to copy and says it is out of date', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  assert.ok(copyable(H).length);
  const r = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'moved jobs' }], { FLOORBOSS_FAIL_PAGE: '9' });
  assert.equal(r.applied, true);
  assert.match(r.outbox_not_rebuilt, /^Saved, but the outbox page of Test Expo \(ev\) could not be rebuilt: \(test\) the page could not be built\. The page now says it is out of date and offers nothing to copy\./);
  assert.match(page(H), /This outbox page is out of date/);
  assert.deepEqual(copyable(H), []);
  assert.doesNotMatch(page(H), /Signe Dahl|class="copy"|data-tick|<script/);
  // Round 3 (B-F9): it is tried again at a step at its own event, or once anything it is built from changes; a write
  // at another event that changes nothing it reads leaves it be (no note on every command).
  assert.equal(stale(H), false, 'what it was built from is recorded with it');
  assert.equal(outboxStale(paths(H), { now: new Date(NOW), retryFailed: true }), true, 'a step at its own event tries it again');
  cli(H, 'flow', ['next', '--event', H.slug]);
  assert.ok(copyable(H).length);
  assert.ok(!copyable(H).includes(`${idOf(H, 'Signe Dahl')}:1`));
});

test('M29: a command that saved part of its work and then failed still leaves the page in step', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H, NOW, `approve ${idOf(H, 'Ana Berg')}`);
  assert.deepEqual(copyable(H), [`${idOf(H, 'Ana Berg')}:1`]);
  const before = { ...process.env };
  process.env.FLOORBOSS_FAIL_PAGE = '1';
  let g;
  try {
    g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${idOf(H, 'Bo Li')}`]);
  } finally {
    if (before.FLOORBOSS_FAIL_PAGE === undefined) delete process.env.FLOORBOSS_FAIL_PAGE;
  }
  assert.match(g.ERROR || '', /The answer was saved, but the outbox page could not be rebuilt/);
  assert.ok(copyable(H).includes(`${idOf(H, 'Bo Li')}:1`), 'the approval stands, and the page shows it');
  assert.equal(stale(H), false);
});

test('B-6: folders that are not events are skipped, and a note names the event it is about', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  // A copy made by hand ("ev copy": not an event name) and an older event whose list is gone.
  cpSync(H.dir, join(H.HOME, 'events', 'ev copy'), { recursive: true });
  const O = setup({ attendees: LIST, home: H.HOME, event: { slug: 'old', name: 'Old Fair' } });
  triage(O);
  draftApprove(O);
  rmSync(join(O.dir, 'attendees.csv'));
  const r = cli(H, 'event-context', ['config', '--set-file', file(H, 'set.json', { colleagues: ['Jordan Fisk'] })]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.doesNotMatch(JSON.stringify(r), /ev copy/);
  assert.match(r.outbox_not_rebuilt || '', /the outbox page of Old Fair \(old\) could not be rebuilt/);
  assert.match(r.outbox_not_rebuilt, /"event-outreach open --event old --no-open" rebuilds it/);
});

test('B-8: a record rewritten by hand at the same size is seen (size and time), at the next command that writes', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const led = join(H.dir, 'ledger.jsonl');
  const text = readFileSync(led, 'utf8');
  // Ana's approval, one hex digit of its hash flipped: the same number of bytes.
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes('"type":"approved"') && l.includes(`"id":"${ana}"`));
  assert.ok(i >= 0);
  lines[i] = lines[i].replace(/("hash":"[0-9a-f]*)([0-9a-f])"/, (m, a, b) => `${a}${b === '0' ? '1' : '0'}"`);
  writeFileSync(led, lines.join('\n'));
  assert.equal(readFileSync(led).length, Buffer.byteLength(text), 'the same size');
  assert.equal(stale(H), true);
  // A command that writes only this event's drafting list checks the page, and puts it right.
  const t = cli(H, 'event-outreach', ['todo', '--event', H.slug]);
  assert.ok(!t.ERROR, t.ERROR);
  assert.equal(stale(H), false);
  assert.deepEqual(copyable(H), fresh(H));
});

test('C4/C5: flow next and a connection check leave a current page alone (no load, no rewrite)', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  // A saved connection, checked before each use: its check time is written to the settings every time.
  const cfgPath = join(H.HOME, 'config.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, connectors: { 'crm.lookup': { server: 'hubspot', tool: 'mcp__hubspot__search', tool_hash: 'x'.repeat(16) } } }));
  cli(H, 'flow', ['next', '--event', H.slug]);
  const before = ino(H);
  const tools = file(H, 'tools.json', [{ name: 'mcp__hubspot__search', description: 'search', inputSchema: {} }]);
  for (let k = 0; k < 2; k++) {
    const c1 = cli(H, 'connectors', ['check', '--tools-file', tools], k ? '2026-10-12T09:00:00Z' : NOW);
    assert.ok(!c1.ERROR, c1.ERROR);
  }
  assert.ok(JSON.parse(readFileSync(cfgPath, 'utf8')).connectors['crm.lookup'].verified?.at, 'the check was written to the settings');
  assert.equal(ino(H), before, 'a connection check changes nothing the page shows');
  cli(H, 'flow', ['next', '--event', H.slug]);
  assert.equal(ino(H), before, 'flow next only checked');
});

test('M27: a write to the slots alone, the ledger unchanged, rebuilds the page', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const ledBefore = statSync(join(H.dir, 'ledger.jsonl')).size;
  const before = ino(H);
  const r = cli(H, 'slot-finder', ['remove', '--event', H.slug, '--ids', 's20261110T1300']);
  assert.ok(!r.ERROR, r.ERROR);
  assert.equal(statSync(join(H.dir, 'ledger.jsonl')).size, ledBefore, 'the ledger is unchanged');
  assert.notEqual(ino(H), before, 'rebuilt');
  assert.equal(stale(H), false);
});

test('M31: a shortlist answer that skips someone after approval (one write for the whole answer) takes their card off', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const dee = idOf(H, 'Dee Moss');
  assert.ok(copyable(H).includes(`${dee}:1`));
  const g = cli(H, 'crm-triage', ['gate', '--event', H.slug, '--answers', `skip ${dee} because not this time`]);
  assert.ok(!g.ERROR, g.ERROR);
  assert.ok(!copyable(H).includes(`${dee}:1`));
  assert.deepEqual(copyable(H), fresh(H));
});

// (Round 2's mutant M22, a card ready when merely approved, is the same as the code here: a card exists only for the
// text and address approved, and an approval for another address or text is not "approved" in the record.)
test('a bounce with a new address takes the approved message off both pages until it is approved for the new one', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  draftApprove(H);
  const ana = idOf(H, 'Ana Berg');
  const r = record(H, [{ who: 'Ana Berg', what: 'bounced', new_email: 'ana.berg@acme.test' }]);
  assert.equal(r.applied, true, JSON.stringify(r).slice(0, 300));
  assert.ok(!copyable(H).includes(`${ana}:1`), 'approved for the old address only');
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--review', '--no-open']);
  const card = cards(H).find((m) => m[1] === ana)?.[0] || '';
  assert.doesNotMatch(card, /class="copy"/, 'nothing to copy on the review page either');
  assert.equal(fold(readLedger(join(H.dir, 'ledger.jsonl')).entries).people[ana].touches[1].approved, null, 'to be approved again');
});

// Every file a forced build reads is one the page records (or one of its outputs): the drift a list of inputs can't
// catch by itself. The build runs in a child with node:fs watched.
test('the inputs the page records cover every file a build reads', () => {
  const CRM = 'First Name,Last Name,Email,Company,Deal Owner,Stage,Last Activity Date,Email Opt Out\nAna,Berg,ana@acme.test,Acme,Sam Rivera,Opportunity,09/12/2026,No\nBo,Li,bo@globex.test,Globex,Kees Jansen,Opportunity,09/12/2026,No\n';
  const H = setup({ attendees: LIST, crm: CRM, dnc: 'nobody@nowhere.test\n', accounts: 'Company,Owner\nUmbrella,Kees Jansen\n' });
  const known = join(H.HOME, 'Connections.csv');
  writeFileSync(known, 'First Name,Last Name,Email Address,Company,Connected On\nZed,Zane,zed@zane.test,Zane,01 Jan 2026\n');
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ known_contacts_paths: [known] }));
  triage(H);
  mkdirSync(join(H.dir, 'profiles'), { recursive: true });
  writeFileSync(join(H.dir, 'profiles', `${idOf(H, 'Ana Berg')}.json`), JSON.stringify({ identity_confirmed: false }));
  writeFileSync(join(H.dir, 'enriched.json'), '{}');
  draftApprove(H);
  const B = setup({ attendees: LIST, crm: CRM, home: H.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  record(B, [{ who: 'Cy Ruiz', what: 'sent', date: '2026-10-12' }]);
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const seen = new Set(); let on = false;
    for (const fn of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync']) {
      const orig = fs[fn];
      const w = function (p, ...rest) { if (on && typeof p === 'string') seen.add(p); return orig.call(this, p, ...rest); };
      for (const k of Object.keys(orig)) w[k] = orig[k];
      fs[fn] = w;
    }
    syncBuiltinESMExports();
    const { rebuildOutbox } = await import(${JSON.stringify(join(ROOT, 'skills/event-outreach/scripts/commands/cards.mjs'))});
    on = true; rebuildOutbox('ev', {}, { force: true }); on = false;
    process.stdout.write(JSON.stringify([...seen]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  const home = H.HOME;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const w = pageInputs(H.dir, new Date(NOW));
  const watched = new Set([...Object.keys(w.files), ...Object.keys(w.ledgers), join(home, 'config.json')].map(real));
  const listed = new Set(watchedFolders(H.dir).map(real));
  // Every folder on the way to a recorded file (the path checks look at each).
  const ancestors = new Set();
  for (const p of watched) for (let d = dirname(p); d.length > 1 && d !== dirname(d); d = dirname(d)) ancestors.add(d);
  const events = join(home, 'events');
  const outsideHome = (p) => !real(p).startsWith(real(home));
  const unwatched = seen.filter((p) => {
    const rp = real(p);
    if (watched.has(rp) || rp.startsWith(real(ROOT))) return false;
    // Folders on the way (path checks), and the folders whose every file is recorded.
    if (ancestors.has(rp) || real(home).startsWith(rp + '/') || rp === real(home) || rp === real(events) || listed.has(rp)) return false;
    // An absent file inside a recorded folder (a list not given): it appears in that folder's files.
    if (!existsSync(p) && listed.has(dirname(rp))) return false;
    // The temp folder's own checks, and the build's outputs and lock.
    if (outsideHome(p) && /^(\/private)?(\/tmp|\/var\/folders)/.test(rp) && !rp.startsWith(real(home))) return false;
    // The page's .eml files (mail/) are outputs too: emptied and written again by each build.
    if (/\/derived\/(?!todo\.json$)|\/outbox\.html(\.tmp-\d+)?$|\/mail(\/[a-z0-9-]+\.eml)?$|\.tmp-\d+$|\/outbox-ev\.lock/.test(rp) && rp.startsWith(real(H.dir))) return false;
    if (rp.startsWith(real(join(home, 'outbox-ev.lock')))) return false;
    if (rp === real(H.dir) || rp === real(B.dir)) return false;
    // Another event's view of its own list (titles for a carried match): it follows that event's list and record,
    // which the page records.
    if (rp === real(join(B.dir, 'derived', 'contacts.json'))) return false;
    return true;
  });
  assert.deepEqual(unwatched.map((p) => p.replace(home, '<home>')), []);
});
