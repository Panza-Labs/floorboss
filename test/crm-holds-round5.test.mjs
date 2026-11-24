// Fifth review of the CRM holds (R1 to R4). Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setup, cli, triage, todoJobs, draftApprove, idOf, NOW, ROOT } from './fixtures/harness.mjs';
import { readLedger, fold, contactable } from '../lib/ledger.mjs';

const LIST = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,https://www.linkedin.com/in/ana-berg-test\nBo Free,COO,Freeco,bo@freeco.test,https://www.linkedin.com/in/bo-free-test\n';
const S = { route: ['email', 'app', 'linkedin', 'email'], linkedin_messages: true };
const put = (H, name, text) => { mkdirSync(join(H.dir, 'work'), { recursive: true }); const p = join(H.dir, 'work', name); writeFileSync(p, text); return p; };
const guard = (H, input) => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ session_id: 's1', ...input }), env: { ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: NOW }, encoding: 'utf8' });
const idx = (H) => join(`${H.HOME}-cache`, 'holds-index.json');
const held = (H, name = 'Ana Berg') => {
  const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl'));
  return contactable(fold(entries, damaged), idOf(H, name));
};
function twoEvents(attendees2 = LIST) {
  const E1 = setup({ attendees: LIST, dnc: 'ana@acme.test\n', settings: S });
  triage(E1);
  const E2 = setup({ home: E1.HOME, attendees: attendees2, event: { slug: 'ev2', name: 'Second Expo', app_name: 'Grip' }, settings: S });
  triage(E2);
  return { E1, E2 };
}

test('R1a: Write and Edit never reach the holds index folder', () => {
  const { E2 } = twoEvents();
  assert.ok(existsSync(idx(E2)));
  for (const input of [
    { tool_name: 'Write', tool_input: { file_path: idx(E2), content: '{}' } },
    { tool_name: 'Write', tool_input: { file_path: `${idx(E2)}.stamp`, content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: idx(E2), old_string: 'ana', new_string: 'x' } },
    { tool_name: 'MultiEdit', tool_input: { file_path: idx(E2), edits: [{ old_string: 'ana', new_string: 'x' }] } }
  ]) {
    const r = guard(E2, input);
    assert.equal(r.status, 2, `${input.tool_name}: ${r.stdout}`);
    assert.match(r.stderr, /one of floorboss's own records/);
  }
});

test('R1b: an index emptied and restamped never shows her: no draft, no card, no mailto, no LinkedIn paste job', () => {
  const { E2 } = twoEvents();
  const x = JSON.parse(readFileSync(idx(E2), 'utf8'));
  for (const ev of Object.values(x.events || {})) ev.holds = [];
  writeFileSync(idx(E2), JSON.stringify(x));
  const st = statSync(idx(E2));
  writeFileSync(`${idx(E2)}.stamp`, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }));
  triage(E2);
  const ana = idOf(E2, 'Ana Berg');
  const r = JSON.parse(readFileSync(join(E2.dir, 'derived', 'resolved.json'), 'utf8'))[ana];
  assert.equal(r.group, 'skip', JSON.stringify(r).slice(0, 200));
  const jobs = todoJobs(E2).jobs.filter((j) => j.id === ana);
  assert.deepEqual(jobs.map((j) => [j.kind, j.touch, j.channel]), []);
  draftApprove(E2);
  const ob = existsSync(join(E2.dir, 'outbox.html')) ? readFileSync(join(E2.dir, 'outbox.html'), 'utf8') : '';
  assert.ok(!new RegExp(`data-id="${ana}"`).test(ob), 'no card');
  assert.doesNotMatch(ob, /mailto:ana@acme\.test/);
});

test('R2: a merged person\'s other address counts at the last check', () => {
  const E1 = setup({ attendees: LIST, dnc: 'ana@acme.test\n', settings: S });
  triage(E1);
  const a1 = idOf(E1, 'Ana Berg');
  appendFileSync(join(E1.dir, 'ledger.jsonl'), JSON.stringify({ at: NOW, type: 'person', who: 'floorboss', id: a1, name: 'Ana Berg', company: 'Acme', keys: ['e:ana.b@gmail.example'] }) + '\n');
  const E2 = setup({ home: E1.HOME, attendees: 'Name,Title,Company,Email\nAna Berg,COO,Other Co,ana.b@gmail.example\n', event: { slug: 'ev2', name: 'Second Expo' }, settings: S });
  triage(E2);
  assert.match(held(E2) || '', /do-not-contact list/);
});

test('R3: lifted at the second event only, the send is no longer refused there', () => {
  const { E2 } = twoEvents();
  const ana = idOf(E2, 'Ana Berg');
  assert.match(held(E2) || '', /another of your events|do-not-contact/);
  cli(E2, 'crm-triage', ['lift-hold', '--event', E2.slug, '--id', ana]);
  const r = cli(E2, 'crm-triage', ['lift-hold', '--event', E2.slug, '--id', ana, '--answer', '1', '--said', 'she asked us to write']);
  assert.ok(r.lifted >= 1, JSON.stringify(r));
  assert.equal(held(E2), null);
});

test('R4: a hold line at another event that does not parse refuses the send', () => {
  const { E1, E2 } = twoEvents();
  appendFileSync(join(E1.dir, 'ledger.jsonl'), '{"at":"2026-10-12T08:00:00Z","type":"hold_seen","id":"c002","rung":"do_not_con\n');
  assert.equal(held(E2, 'Bo Free'), "floorboss can't check another event's do-not-contact holds: nothing was sent");
});

// S1: another event's hold line that doesn't parse holds her on its own rung: no lift, no decision, until it reads again.
test('S1: a hold line cut in two at another event holds her; lift-hold and a reach are refused; repaired, she is judged normally', () => {
  const E1 = setup({ attendees: LIST, settings: S });
  triage(E1);
  const E2 = setup({ home: E1.HOME, attendees: LIST, event: { slug: 'ev2', name: 'Second Expo', app_name: 'Grip' }, settings: S });
  const led1 = join(E1.dir, 'ledger.jsonl');
  const good = readFileSync(led1, 'utf8');
  const line = JSON.stringify({ at: NOW, type: 'hold_seen', who: 'floorboss', id: idOf(E1, 'Ana Berg'), rung: 'do_not_contact', says: 'on your do-not-contact list: ana@acme.test is on the list' });
  writeFileSync(led1, good + line.slice(0, 60) + '\n' + line.slice(60) + '\n');
  triage(E2);
  const ana = idOf(E2, 'Ana Berg');
  const r = JSON.parse(readFileSync(join(E2.dir, 'derived', 'resolved.json'), 'utf8'))[ana];
  assert.equal(r.group, 'skip');
  assert.equal(r.says, "floorboss can't read another of your events' records right now, so it can't check whether Ana Berg is on a do-not-contact list there. Nothing goes to them until it can.");
  const lh = cli(E2, 'crm-triage', ['lift-hold', '--event', E2.slug, '--id', ana]);
  assert.match(lh.ERROR || '', /This isn't a hold you can lift: it ends by itself once that file can be read\. Nothing was changed\./);
  assert.ok(cli(E2, 'crm-triage', ['decide', '--event', E2.slug, '--id', ana, '--group', 'reach', '--because', 'I know her']).ERROR, 'no decision lifts it');
  triage(E2);
  assert.deepEqual(todoJobs(E2).jobs.filter((j) => j.id === ana).map((j) => [j.kind, j.touch, j.channel]), []);
  draftApprove(E2);
  const ob = existsSync(join(E2.dir, 'outbox.html')) ? readFileSync(join(E2.dir, 'outbox.html'), 'utf8') : '';
  assert.ok(!new RegExp(`data-id="${ana}"`).test(ob));
  assert.doesNotMatch(ob, /mailto:ana@acme\.test/);
  // The file repaired (the line written whole): the real hold takes over.
  writeFileSync(led1, good + line + '\n');
  triage(E2);
  assert.match(JSON.parse(readFileSync(join(E2.dir, 'derived', 'resolved.json'), 'utf8'))[ana].says, /^on your do-not-contact list.*\(at your event Test Expo\)$/);
  // And without the line at all: judged as anyone.
  writeFileSync(led1, good);
  triage(E2);
  assert.notEqual(JSON.parse(readFileSync(join(E2.dir, 'derived', 'resolved.json'), 'utf8'))[ana].group, 'skip');
});
