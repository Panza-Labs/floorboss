// The outbox page is what a user who sends by hand reads and copies from. After any command that changes who is
// on it or what a card says (a cut, a rewrite, a drop, an edit, a send, a stop, a hold), the page is rebuilt, and
// `flow next` rebuilds a page older than the ledger. It never offers a Copy button for a message that is cut,
// dropped, sent back, not approved, or for someone now held or skipped. (Sims e and h, 2026-11-10: the page kept
// a cut person's card and old texts as approved until some later approval happened to rebuild it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync, utimesSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, triage, idOf, draftApprove, NOW, ROOT } from './fixtures/harness.mjs';
import { readLedger, fold, contactable, append } from '../lib/ledger.mjs';

const LIST =
  'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Li,VP Ops,Globex,bo@globex.test\nSigne Dahl,Ops Lead,All Nordic,signe@allnordic.test\nCy Ruiz,Head of Ops,Initech,cy@initech.test\nDee Moss,Supply Chain Lead,Umbrella,dee@umbrella.test\n';

const page = (H) => readFileSync(join(H.dir, 'outbox.html'), 'utf8');
const cards = (H) => [...page(H).matchAll(/<article class="card[^"]*" data-id="(c\d+)" data-touch="(\d+)"[\s\S]*?<\/article>/g)];
// The cards the page lets a user copy from: id:touch.
const copyable = (H) =>
  cards(H)
    .filter((m) => /class="copy"/.test(m[0]))
    .map((m) => `${m[1]}:${m[2]}`)
    .sort();
// A saved draft's text, with a line of the user's own added (times and sign-off kept, so its checks still pass).
const editedText = (H, id, line) => {
  const d = JSON.parse(readFileSync(join(H.dir, 'work', 'drafts', `${id}-t1.json`), 'utf8'));
  return { subject: d.subject, body: d.body.replace(/\n\n/, `\n\n${line}\n\n`), brief: 'x', structure: d.structure || 'question-first', fact_source: d.fact_source || 'list' };
};
const bodyOf = (H, key) => cards(H).find((m) => `${m[1]}:${m[2]}` === key)?.[0] || '';
const file = (H, name, o) => {
  const f = join(H.dir, `${name}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
  return f;
};
const record = (H, items) => cli(H, 'event-outreach', ['record', '--event', H.slug, '--file', file(H, 'rec.json', { items })]);
const state = (H) => fold(readLedger(join(H.dir, 'ledger.jsonl')).entries);
// What the ledger says may be copied now: approved (for the text saved now), not sent, and the person still
// contactable. (Only first messages here: no sequences are turned on.)
const ledgerReady = (H) => {
  const st = state(H);
  const out = [];
  for (const [id, p] of Object.entries(st.people))
    for (const [t, x] of Object.entries(p.touches))
      if (x.approved && x.approved.hash === x.hash && !x.sent && !x.revising && !x.dropped && contactable(st, id, 'message') === null) out.push(`${id}:${t}`);
  return out.sort();
};

function ready() {
  const H = setup({ attendees: LIST });
  triage(H);
  const r = draftApprove(H);
  assert.equal(r.gate.approved, 5, JSON.stringify(r.gate).slice(0, 300));
  const ids = Object.fromEntries(['Ana Berg', 'Bo Li', 'Signe Dahl', 'Cy Ruiz', 'Dee Moss'].map((n) => [n.split(' ')[0], idOf(H, n)]));
  assert.deepEqual(copyable(H), Object.values(ids).map((id) => `${id}:1`).sort());
  return { H, ids };
}

test('a cut person leaves the page as soon as the cut is recorded', () => {
  const { H, ids } = ready();
  assert.match(page(H), /Signe Dahl/);
  const r = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'moved jobs' }]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.equal(r.outbox_not_rebuilt, undefined);
  assert.doesNotMatch(page(H), /Signe Dahl/);
  assert.ok(!copyable(H).includes(`${ids.Signe}:1`));
  assert.deepEqual(copyable(H), ledgerReady(H));
});

test('a message sent back for a rewrite is not offered, old text included', () => {
  const { H, ids } = ready();
  const old = bodyOf(H, `${ids.Bo}:1`);
  assert.match(old, /class="copy"/);
  const r = cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', ids.Bo, '--feedback-file', file(H, 'fb.txt', 'remove the second sentence')]);
  assert.deepEqual(r.revise, [`${ids.Bo}:1`], JSON.stringify(r));
  assert.ok(!copyable(H).includes(`${ids.Bo}:1`));
  assert.doesNotMatch(page(H), /Bo Li/);
  assert.deepEqual(copyable(H), ledgerReady(H));
});

test('an approved message edited by hand is off the page until the new text is approved', () => {
  const { H, ids } = ready();
  const d = editedText(H, ids.Cy, 'A line the user wrote, not approved yet.');
  const s = cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', ids.Cy, '--touch', '1', '--json', JSON.stringify(d)]);
  assert.ok(!s.ERROR, s.ERROR);
  assert.ok(!copyable(H).includes(`${ids.Cy}:1`));
  assert.doesNotMatch(page(H), /not approved yet/);
  assert.deepEqual(copyable(H), ledgerReady(H));
  // Approved again: back on the page, with the new text.
  cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', ids.Cy, '--touch', '1', '--text', 'PASS']);
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${ids.Cy}`]);
  assert.equal(g.approved, 1, JSON.stringify(g).slice(0, 300));
  assert.ok(copyable(H).includes(`${ids.Cy}:1`));
  assert.match(bodyOf(H, `${ids.Cy}:1`), /not approved yet/);
});

test('a drop at the gate, and sends, stops, declines and bounces each take the card off', () => {
  const { H, ids } = ready();
  const g = cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `drop ${ids.Ana}`]);
  assert.ok(!g.ERROR, g.ERROR);
  assert.ok(!copyable(H).includes(`${ids.Ana}:1`), 'dropped');
  for (const [name, what] of [
    ['Bo Li', 'sent'],
    ['Cy Ruiz', 'stop'],
    ['Dee Moss', 'declined'],
    ['Signe Dahl', 'bounced']
  ]) {
    const r = record(H, [{ who: name, what, ...(what === 'sent' ? { date: '2026-10-12' } : {}) }]);
    assert.equal(r.applied, true, `${what}: ${JSON.stringify(r).slice(0, 300)}`);
    assert.ok(!copyable(H).includes(`${ids[name.split(' ')[0]]}:1`), `${what} takes the card off`);
    assert.deepEqual(copyable(H), ledgerReady(H), what);
  }
  assert.deepEqual(copyable(H), []);
});

test('a send confirmed after an unclear send takes the card off', () => {
  const { H, ids } = ready();
  // The guard let the send through (its own line in the ledger), and the tool never answered.
  append(join(H.dir, 'ledger.jsonl'), { type: 'send_released', who: 'guard', id: ids.Ana, touch: 1, hash: state(H).people[ids.Ana].touches[1].approved.hash, via: 'email', to: 'ana@acme.test' }, new Date(NOW));
  const r = cli(H, 'event-outreach', ['send-outcome', '--event', H.slug, '--id', ids.Ana, '--touch', '1', '--went', 'yes', '--said', "it's in my Sent folder"]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(!copyable(H).includes(`${ids.Ana}:1`));
  assert.deepEqual(copyable(H), ledgerReady(H));
});

test('a shortlist change that leaves someone out or holds them for a coworker takes the card off', () => {
  const { H, ids } = ready();
  const s = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ids.Dee, '--group', 'skip', '--because', 'not this time']);
  assert.ok(!s.ERROR, s.ERROR);
  assert.ok(!copyable(H).includes(`${ids.Dee}:1`), 'skipped');
  const c = cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', ids.Bo, '--group', 'colleague', '--because', 'Jo owns Globex']);
  assert.ok(!c.ERROR, c.ERROR);
  assert.ok(!copyable(H).includes(`${ids.Bo}:1`), 'held for a coworker');
  assert.deepEqual(copyable(H), ledgerReady(H));
});

test('flow next rebuilds a page older than the ledger', () => {
  const { H, ids } = ready();
  // Something wrote the ledger without rebuilding the page (an older floorboss, a hand edit): the page is now
  // older than the ledger.
  append(join(H.dir, 'ledger.jsonl'), { type: 'stop', who: 'user', id: ids.Ana, said: 'Ana asked not to be contacted' }, new Date(NOW));
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(H.dir, 'outbox.html'), past, past);
  assert.ok(copyable(H).includes(`${ids.Ana}:1`), 'stale before');
  cli(H, 'flow', ['next', '--event', H.slug]);
  assert.ok(!copyable(H).includes(`${ids.Ana}:1`), 'rebuilt at flow next');
  assert.deepEqual(copyable(H), ledgerReady(H));
  // A page that is current is not written again: flow next only checks it (file sizes and times). Its file is the same
  // file, with the time set here (a rewrite is a new file put in its place).
  const past2 = new Date(Date.now() - 120_000);
  utimesSync(join(H.dir, 'outbox.html'), past2, past2);
  const before = statSync(join(H.dir, 'outbox.html'));
  cli(H, 'flow', ['next', '--event', H.slug]);
  const after = statSync(join(H.dir, 'outbox.html'));
  assert.equal(after.ino, before.ino, 'not rewritten');
  assert.equal(after.mtimeMs, before.mtimeMs, 'not rewritten');
});

test('a page that cannot be rebuilt: the command still succeeds and says so', () => {
  const { H } = ready();
  rmSync(join(H.dir, 'outbox.html'), { force: true });
  mkdirSync(join(H.dir, 'outbox.html', 'blocked'), { recursive: true });
  const r = record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'moved jobs' }]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.match(r.outbox_not_rebuilt || '', /Saved, but the outbox page of Test Expo \(ev\) could not be rebuilt/);
  assert.equal(state(H).people[idOf(H, 'Signe Dahl')].decision?.group, 'skip', 'the cut is saved');
});

test('the review page shows drafts not yet approved with nothing to copy', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  const r = draftApprove(H, NOW, `drop ${idOf(H, 'Cy Ruiz')}`);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  const o = cli(H, 'event-outreach', ['open', '--event', H.slug, '--review', '--no-open']);
  assert.ok(!o.ERROR, o.ERROR);
  assert.match(page(H), /pending your approval/);
  assert.ok(cards(H).length >= 4, 'the drafts are there to read');
  assert.deepEqual(copyable(H), [], 'and none can be copied');
  assert.doesNotMatch(page(H), /data-tick="sent"/);
});

// Property-style: after a random sequence of commands that change the page, the cards it lets a user copy are
// exactly the messages the ledger has as approved and unsent, for people who may still be contacted.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
for (const seed of [7, 2026, 31337, 4242]) {
  test(`random commands (seed ${seed}): the copyable cards are the ledger's approved and unsent`, () => {
    const { H, ids } = ready();
    const rand = rng(seed);
    const people = Object.entries(ids);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const ops = {
      cut: ([n]) => record(H, [{ who: ids[n], what: 'cut', reason: 'not this time' }]),
      sent: ([n]) => record(H, [{ who: ids[n], what: 'sent', date: '2026-10-12' }]),
      stop: ([n]) => record(H, [{ who: ids[n], what: 'stop' }]),
      declined: ([n]) => record(H, [{ who: ids[n], what: 'declined' }]),
      bounced: ([n]) => record(H, [{ who: ids[n], what: 'bounced' }]),
      revise: ([, id]) => cli(H, 'event-outreach', ['revise', '--event', H.slug, '--ids', id, '--feedback-file', file(H, 'fb.txt', 'shorter')]),
      drop: ([, id]) => cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `drop ${id}`]),
      skip: ([, id]) => cli(H, 'crm-triage', ['decide', '--event', H.slug, '--id', id, '--group', 'skip', '--because', 'leave them']),
      edit: ([, id]) =>
        cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', id, '--touch', '1', '--json', JSON.stringify(editedText(H, id, `Edited by hand ${Math.floor(rand() * 1e6)}.`))]),
      approve: ([, id]) => {
        cli(H, 'event-outreach', ['save-draft', '--event', H.slug, '--id', id, '--touch', '1', '--json', JSON.stringify(editedText(H, id, `Rewritten ${Math.floor(rand() * 1e6)}.`))]);
        cli(H, 'event-outreach', ['verdict', '--event', H.slug, '--id', id, '--touch', '1', '--text', 'PASS']);
        return cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', `approve ${id}`]);
      }
    };
    // Weighted towards edits and approvals, so cards come back as well as go.
    const names = [...Object.keys(ops), 'approve', 'approve', 'edit'];
    const done = [];
    for (let i = 0; i < 10; i++) {
      const op = pick(names);
      const who = pick(people);
      const r = ops[op](who);
      done.push(`${op} ${who[0]}${r?.ERROR || r?.approved === 0 ? ' (refused)' : ''}`);
      assert.equal(r?.outbox_not_rebuilt, undefined);
      assert.deepEqual(copyable(H), ledgerReady(H), `after: ${done.join(', ')}`);
    }
  });
}

// Review round 2.
import { spawn } from 'node:child_process';
import { renderOutbox } from '../skills/event-outreach/scripts/outbox.mjs';
import { outboxStale } from '../skills/event-outreach/scripts/commands/cards.mjs';

const recordAsync = (H, items) =>
  new Promise((res) => {
    const p = spawn('node', [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'record', '--event', H.slug, '--file', file(H, 'rec.json', { items })], {
      env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => res({ code, out }));
  });
const paths = (H) => ({ outbox: join(H.dir, 'outbox.html'), ledger: join(H.dir, 'ledger.jsonl') });

test('four record commands at once, 20 times: the page always equals the ledger, and is stamped as current', async () => {
  const LIST6 = `${LIST}Eli Katz,COO,Hooli,eli@hooli.test\n`;
  const H = setup({ attendees: LIST6 });
  triage(H);
  draftApprove(H);
  const names = ['Ana Berg', 'Bo Li', 'Signe Dahl', 'Cy Ruiz'];
  for (let t = 0; t < 20; t++) {
    const what = t % 2 === 0 ? 'cut' : 'added';
    const rs = await Promise.all(names.map((who) => recordAsync(H, [{ who, what, reason: 'x' }])));
    assert.ok(rs.every((r) => r.code === 0 && !/outbox_not_rebuilt/.test(r.out)), JSON.stringify(rs).slice(0, 400));
    assert.deepEqual(copyable(H), ledgerReady(H), `trial ${t} (${what})`);
    assert.equal(outboxStale(paths(H), { now: new Date(NOW) }), false, `trial ${t}: stamped with what it was built from`);
  }
});

test('a page whose file time is in the future, or equal to the ledger, is still rebuilt after a write', () => {
  const { H, ids } = ready();
  const future = new Date(Date.now() + 86400000);
  utimesSync(join(H.dir, 'outbox.html'), future, future);
  record(H, [{ who: 'Signe Dahl', what: 'cut', reason: 'moved jobs' }]);
  assert.ok(!copyable(H).includes(`${ids.Signe}:1`));
  const st = readFileSync(join(H.dir, 'ledger.jsonl'));
  const at = new Date();
  utimesSync(join(H.dir, 'outbox.html'), at, at);
  utimesSync(join(H.dir, 'ledger.jsonl'), at, at);
  assert.ok(st.length > 0);
  record(H, [{ who: 'Bo Li', what: 'stop' }]);
  assert.ok(!copyable(H).includes(`${ids.Bo}:1`));
  assert.deepEqual(copyable(H), ledgerReady(H));
});

test('a setting changed with event-context config, a do-not-contact list edited by hand: the page follows', () => {
  const { H, ids } = ready();
  // The do-not-contact list edited by hand (no floorboss command): the next step rebuilds the page.
  writeFileSync(join(H.dir, 'dnc.txt'), 'ana@acme.test\n');
  const ev = JSON.parse(readFileSync(join(H.dir, 'event.json'), 'utf8'));
  writeFileSync(join(H.dir, 'event.json'), JSON.stringify({ ...ev, dnc_path: join(H.dir, 'dnc.txt') }));
  assert.ok(copyable(H).includes(`${ids.Ana}:1`), 'not rebuilt by a hand edit');
  cli(H, 'flow', ['next', '--event', H.slug]);
  assert.ok(!copyable(H).includes(`${ids.Ana}:1`), 'rebuilt at the next step');
  // A setting saved through floorboss's own command: the page is rebuilt when it ends, though the ledger is unchanged
  // (here a page left out of step, with the right ledger stamp, shows that it was written again).
  writeFileSync(join(H.dir, 'outbox.html'), page(H).replace('</body>', '<!-- left over --></body>'));
  assert.equal(outboxStale(paths(H), { now: new Date(NOW) }), false);
  const r = cli(H, 'event-context', ['config', '--set-file', file(H, 'set.json', { colleagues: ['Jordan Fisk'] })]);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(existsSync(join(H.HOME, 'config.json')));
  assert.doesNotMatch(page(H), /left over/);
});

test('a stop recorded at another event takes the person off this event\'s page', () => {
  const { H, ids } = ready();
  const B = setup({ attendees: LIST, home: H.HOME, event: { slug: 'evb', name: 'Expo B' } });
  triage(B);
  // Written to there too, and Cy said stop there.
  const r = record(B, [
    { who: 'Cy Ruiz', what: 'sent', date: '2026-10-12' },
    { who: 'Cy Ruiz', what: 'stop', said: 'Cy asked us to stop' }
  ]);
  assert.equal(r.applied, true, JSON.stringify(r));
  assert.ok(!copyable(H).includes(`${ids.Cy}:1`), 'off the first event\'s page');
});

test('the review page from an old drafting list offers nothing sent or replied, and a bounced address gets no card', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  const r = draftApprove(H, NOW, `drop ${idOf(H, 'Dee Moss')}`);
  assert.ok(!r.gate.ERROR, r.gate.ERROR);
  record(H, [{ who: 'Ana Berg', what: 'sent', date: '2026-10-12' }]);
  record(H, [{ who: 'Bo Li', what: 'replied', said: 'Tuesday works' }]);
  cli(H, 'event-outreach', ['open', '--event', H.slug, '--review', '--no-open']);
  assert.doesNotMatch(page(H), /Ana Berg|Bo Li/);
  assert.ok(cards(H).length >= 2, 'the others are there to read');
  // A bounced address with no new one, then "reach" again: no email card for them.
  const H2 = setup({ attendees: LIST });
  triage(H2);
  draftApprove(H2);
  const cy = idOf(H2, 'Cy Ruiz');
  record(H2, [{ who: 'Cy Ruiz', what: 'bounced' }]);
  cli(H2, 'crm-triage', ['decide', '--event', H2.slug, '--id', cy, '--group', 'reach', '--because', 'try again']);
  assert.ok(!copyable(H2).includes(`${cy}:1`));
  assert.doesNotMatch(page(H2), /Cy Ruiz/);
});

test('the final page says how many drafts wait for approval and are not on it', () => {
  const H = setup({ attendees: LIST });
  triage(H);
  const ids = ['Ana Berg', 'Bo Li', 'Signe Dahl', 'Cy Ruiz', 'Dee Moss'].map((n) => idOf(H, n));
  const r = draftApprove(H, NOW, `approve ${ids[0]} ${ids[1]}`);
  assert.equal(r.gate.approved, 2, JSON.stringify(r.gate).slice(0, 300));
  assert.match(page(H), /3 drafts are waiting for your approval and are not shown here\./);
  assert.deepEqual(copyable(H), [`${ids[0]}:1`, `${ids[1]}:1`].sort());
  cli(H, 'event-outreach', ['gate', '--event', H.slug, '--answers', 'approve all']);
  assert.doesNotMatch(page(H), /waiting for your approval/);
});

test('a card pending approval is never in the LinkedIn queue; an approved LinkedIn card is', () => {
  const card = (pending) => ({ id: 'c001', touch: 1, name: 'Ana', title: 'COO', company: 'Acme', kind: 'message', channel: 'paste', profile_url: 'https://www.linkedin.com/in/ana', body: 'Hi', slots: [], earliest: '', pending });
  const html = (pending) => renderOutbox({ event: { name: 'Test' }, cards: [card(pending)], slots: [], counts: {} });
  assert.doesNotMatch(html(true), /data-li="1"/);
  assert.doesNotMatch(html(true), /class="copy"/);
  assert.match(html(false), /data-li="1"/);
  assert.match(html(false), /class="copy"/);
});
