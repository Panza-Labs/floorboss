// The holds carried between events are read from a small index of unlifted hold-1 lines (spec 0.1.7, third review):
// a guard call and a send list stay fast with many events, and a hold at another event is still refused after the
// index is rebuilt, deleted or edited by hand. Invented people at .test domains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { setup, cli, triage, draftApprove, idOf, NOW, ROOT } from './fixtures/harness.mjs';

const RECIPE = { server: 'gmail', tool: 'send_email', args: { to: '{to}', subject: '{subject}', body: '{body}' }, reading: 'x', tool_hash: 'a'.repeat(64), test_draft: { draft_id: 't1', user_confirmed: true } };
const L = '2026-10-12T09:00:00.000Z';
const LIST = 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\nBo Free,COO,Freeco,bo@freeco.test\n';

// probe10's home: this event approved and listed, and 19 others of `per` lines each (a person and a line, a fifth of
// them do-not-contact holds). Ana's own address is held at "other-7" when `anaHeld`.
function bigHome(per, anaHeld = false) {
  const H = setup({ attendees: LIST, settings: { route: ['email', 'email'], sending: { channels: ['email'], followups: 'scheduled' } } });
  writeFileSync(join(H.HOME, 'config.json'), JSON.stringify({ connectors: { 'email.send': RECIPE } }));
  triage(H);
  draftApprove(H);
  for (let k = 0; k < 19; k++) {
    const d = join(H.HOME, 'events', `other-${k}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'event.json'), JSON.stringify({ slug: `other-${k}`, name: `Other ${k}`, time_zone: 'Europe/Amsterdam', start_date: '2026-11-10', end_date: '2026-11-12' }));
    let t = '';
    for (let i = 1; i <= per / 2; i++) {
      const id = `c${String(i).padStart(3, '0')}`;
      const mail = anaHeld && k === 7 && i === 1 ? 'ana@acme.test' : `p${k}x${i}@co${i}.test`;
      t += JSON.stringify({ at: NOW, type: 'person', who: 'floorboss', id, name: anaHeld && k === 7 && i === 1 ? 'Ana Berg' : `Person ${k} ${i}`, company: `Co ${i}`, email: mail }) + '\n';
      t += JSON.stringify(i % 5 && !(anaHeld && k === 7 && i === 1) ? { at: NOW, type: 'answered', who: 'floorboss', ask: 'x', value: 'y' } : { at: NOW, type: 'hold_seen', who: 'floorboss', id, rung: 'do_not_contact', says: `on your do-not-contact list: ${mail} is on the list` }) + '\n';
    }
    writeFileSync(join(d, 'ledger.jsonl'), t);
  }
  return H;
}
const env = (H) => ({ ...process.env, FLOORBOSS_HOME: H.HOME, FLOORBOSS_NOW: L });
const timed = (fn) => { const t0 = process.hrtime.bigint(); const r = fn(); return [Number(process.hrtime.bigint() - t0) / 1e6, r]; };
const sendList = (H) => timed(() => spawnSync('node', [join(ROOT, 'skills/event-outreach/scripts/cli.mjs'), 'send-list', '--event', H.slug], { env: env(H), encoding: 'utf8' }));
const guardSend = (H, it) => {
  writeFileSync(join(H.HOME, 'active.json'), JSON.stringify({ at: L }));
  return timed(() => spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'mcp__gmail__send_email', tool_input: { to: it.to, subject: it.subject, body: it.body } }), env: env(H), encoding: 'utf8' }));
};
const listed = (H) => JSON.parse(readFileSync(join(H.dir, 'derived', 'send-list.json'), 'utf8'));

test('20 events and 38,000 lines: a send list and a guard call stay within 3 times a small home, and under 5 s', { timeout: 600000 }, () => {
  // The baseline, measured here: the same calls on a home with no other events.
  const S = bigHome(0);
  sendList(S);
  const [base1] = sendList(S);
  const [base2] = guardSend(S, listed(S).find((x) => x.id === idOf(S, 'Bo Free')));
  const H = bigHome(2000);
  sendList(H); // the first call builds the index
  const [ms1, r1] = sendList(H);
  assert.equal(r1.status, 0, r1.stderr);
  const it = listed(H).find((x) => x.id === idOf(H, 'Bo Free'));
  assert.ok(it, 'Bo is listed');
  const [ms2, g] = guardSend(H, it);
  assert.doesNotMatch(g.stderr, /took too long/);
  console.log(`small home: send-list ${base1.toFixed(0)} ms, guard ${base2.toFixed(0)} ms | 20 events, 38,000 lines: send-list ${ms1.toFixed(0)} ms, guard ${ms2.toFixed(0)} ms`);
  assert.ok(ms1 <= Math.max(3 * base1, 1500) && ms1 < 5000, `send-list took ${ms1.toFixed(0)} ms (small home ${base1.toFixed(0)} ms)`);
  assert.ok(ms2 <= Math.max(3 * base2, 1500) && ms2 < 5000, `guard took ${ms2.toFixed(0)} ms (small home ${base2.toFixed(0)} ms)`);
});

const indexFile = (H) => join(`${H.HOME}-cache`, 'holds-index.json');
for (const [how, change] of [
  ['rebuilt', () => {}],
  ['deleted', (H) => rmSync(indexFile(H), { force: true })],
  ['edited by hand', (H) => {
    const x = JSON.parse(readFileSync(indexFile(H), 'utf8'));
    for (const ev of Object.values(x.events || {})) ev.holds = [];
    writeFileSync(indexFile(H), JSON.stringify(x));
  }],
  ['damaged', (H) => writeFileSync(indexFile(H), '{not json')],
  // The reviewer's edit: the index emptied and its stamp rewritten to match, so the index itself looks trusted.
  ['edited and restamped', (H) => {
    const x = JSON.parse(readFileSync(indexFile(H), 'utf8'));
    for (const ev of Object.values(x.events || {})) ev.holds = [];
    writeFileSync(indexFile(H), JSON.stringify(x));
    const st = statSync(indexFile(H));
    writeFileSync(`${indexFile(H)}.stamp`, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }));
  }]
])
  test(`a hold at another event is still refused after the index is ${how}`, { timeout: 600000 }, () => {
    const H = bigHome(40, true);
    sendList(H);
    assert.ok(existsSync(indexFile(H)), 'the index is written');
    const ana = listed(H).find((x) => x.id === idOf(H, 'Ana Berg'));
    assert.equal(ana, undefined, 'not listed');
    change(H);
    // A send list made before the hold, used now: the guard refuses it.
    const { readLedger, fold, contactable } = { ...awaitImport() };
    const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl'));
    assert.match(contactable(fold(entries, damaged), idOf(H, 'Ana Berg')) || '', /do-not-contact list/);
    const [, r] = sendList(H);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!listed(H).some((x) => x.id === idOf(H, 'Ana Berg')));
  });
import * as ledgerMod from '../lib/ledger.mjs';
function awaitImport() { return ledgerMod; }

test('the index is never in the data folder (the auto-send repo)', { timeout: 600000 }, () => {
  const H = bigHome(40, true);
  sendList(H);
  assert.ok(!existsSync(join(H.HOME, 'holds-index.json')) && !existsSync(join(H.HOME, 'holds-index.json.stamp')));
  assert.ok(existsSync(indexFile(H)));
});

test('the last check at 20 events and 38,000 lines: a held recipient is refused fast, with the index emptied and restamped', { timeout: 600000 }, () => {
  const H = bigHome(2000, true);
  sendList(H);
  const x = JSON.parse(readFileSync(indexFile(H), 'utf8'));
  for (const ev of Object.values(x.events || {})) ev.holds = [];
  writeFileSync(indexFile(H), JSON.stringify(x));
  const st = statSync(indexFile(H));
  writeFileSync(`${indexFile(H)}.stamp`, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs }));
  // A send to Ana, held at "other-7", as an old list would have it.
  const [ms, g] = guardSend(H, { to: 'ana@acme.test', subject: 'Test Expo', body: 'x' });
  console.log(`last check, held recipient: ${ms.toFixed(0)} ms`);
  assert.equal(g.status, 2, g.stdout.slice(0, 200));
  const { readLedger, fold, contactable } = ledgerMod;
  const t0 = process.hrtime.bigint();
  const { entries, damaged } = readLedger(join(H.dir, 'ledger.jsonl'));
  const why = contactable(fold(entries, damaged), idOf(H, 'Ana Berg'));
  console.log(`contactable in process: ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);
  assert.match(why || '', /do-not-contact list/);
});

test('the shell rule protects the holds index as it does the ledger', () => {
  const H = setup({ attendees: LIST });
  for (const cmd of [`rm ${H.HOME}-cache/holds-index.json`, `touch -r ${H.HOME}-cache/holds-index.json.stamp x`, `cp x ${H.HOME}-cache/holds-index.json.tmp`, 'echo {} > ~/.floorboss-cache/holds-index.json']) {
    const r = spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's1' }), env: env(H), encoding: 'utf8' });
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /holds index/);
  }
});
