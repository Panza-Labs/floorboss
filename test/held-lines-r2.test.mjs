// Held lines say what really blocks a person, never a remedy that can't work: with whole sequences, a first draft held
// by the critic and a follow-up not written yet name the unwritten follow-up first, and approving by name is said to
// override only the critic hold. A follow-up waiting for the message before it names that message, even when it isn't
// in this round's list, never itself. A grouped hold names every person it holds, with their ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, NOW } from './fixtures/harness.mjs';
import { drive, simplePersona } from './sims/lib/driver.mjs';
import { MOCK, envOf, loadMock, home } from './fixtures/r2.mjs';
import { heldLines } from '../skills/flow/scripts/steps/approval.mjs';

const SEND = { server: 'gmail', tool: 'send_message', args: { to: '{to}', subject: '{subject}', body: '{body}', threadId: '{thread_id}' }, reading: 'the id and threadId it returns', tool_hash: 'b'.repeat(64), test_draft: { draft_id: 'm-test', user_confirmed: true } };
let STATE = null;
// The mock event with whole sequences and LinkedIn notes, at its first approval, unanswered.
function state() {
  if (STATE) return STATE;
  const HOME = home();
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, sending: { channels: ['email'], followups: 'scheduled' }, connectors: { 'email.send': SEND } }));
  loadMock(HOME);
  // The mock's profile links, as LinkedIn ones: each sequence is an email, a LinkedIn note, an email.
  const list = join(HOME, 'events', MOCK, 'attendees.csv');
  writeFileSync(list, readFileSync(list, 'utf8').replaceAll('https://example.com/in/', 'https://www.linkedin.com/in/'));
  const per = simplePersona({ slug: MOCK, asks: { check_these: (s) => s.ask.people.map((p) => `${p.id} different-person`).join('\n'), voice_samples: 'skip', rate: 'skip' } });
  try {
    drive({ HOME, now: NOW, env: envOf(HOME) }, per, { maxSteps: 200, onStep: (s) => { if (s.step === 'approve') throw Object.assign(new Error('at the approval'), { stop: true }); } });
  } catch (e) {
    if (!e.stop) throw e;
  }
  STATE = HOME;
  return HOME;
}
const copy = () => {
  const H = mkdtempSync(join(tmpdir(), 'fb-hl2-'));
  cpSync(state(), H, { recursive: true });
  return H;
};
const run = (H, skill, args) => {
  const env = envOf(H);
  delete env.FLOORBOSS_OUT_OF_TURN;
  return JSON.parse(execFileSync('node', [join(ROOT, `skills/${skill}/scripts/cli.mjs`), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
};
const L = (H) => join(H, 'events', MOCK, 'ledger.jsonl');
const entries = (H) => readFileSync(L(H), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastDrafted = (H, id, t) => entries(H).filter((x) => x.type === 'drafted' && x.id === id && (x.touch ?? 1) === t).pop();
const lineOf = (text, id) => (new RegExp(`[^.]*\\(${id}\\) is held[^]*?(?=(?:[.!?] [A-Z][a-z]+ [A-Z][a-z]+ \\(c\\d+\\))|$)`).exec(text) || [''])[0];

test('a critic-held first draft and an unwritten follow-up: the line names the follow-up, and approve-by-name only overrides the critic', { timeout: 600000 }, () => {
  const H = copy();
  try {
    // c001:1 fails the critic and comes back word for word the same: held after two fails. c001:3 has no draft.
    const d = lastDrafted(H, 'c001', 1);
    appendFileSync(L(H), JSON.stringify({ at: NOW, type: 'critic', who: 'floorboss', id: 'c001', touch: 1, hash: d.hash, verdict: 'FAIL', reasons: ['reads like a template'] }) + '\n');
    appendFileSync(L(H), JSON.stringify({ ...d, at: NOW }) + '\n');
    rmSync(join(H, 'events', MOCK, 'work', 'drafts', 'c001-t3.json'));
    const s = run(H, 'flow', ['next', '--event', MOCK]);
    const t = String(s.tell_user || '');
    const line = lineOf(t, 'c001');
    assert.match(line, /\(c001\) is held until follow-up 2 \(c001:3\) is written/, t.slice(0, 900));
    assert.match(line, /Approving c001 by name overrides only the critic hold on the first message \(c001:1\)/);
    assert.doesNotMatch(line, /approve c001 by name to send it anyway/);
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('a follow-up waiting for a message not in this round\'s list names that message, never itself', { timeout: 600000 }, () => {
  const H = copy();
  try {
    // Touch 2 out of the list, touch 3 in it with a passing draft.
    const f = join(H, 'events', MOCK, 'derived', 'todo.json');
    const todo = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...todo, jobs: todo.jobs.filter((j) => !(j.id === 'c001' && j.touch === 2)) }));
    const a = run(H, 'event-outreach', ['approvable', '--event', MOCK]);
    const r = a.refused.find((x) => x.id === 'c001' && x.touch === 3);
    assert.ok(r, JSON.stringify(a.refused.filter((x) => x.id === 'c001')));
    assert.equal(r.blocking, 'c001:2', JSON.stringify(r));
    const { lines } = heldLines({ refused: a.refused.filter((x) => x.id === 'c001'), offered: [], candidates: ['c001:1', 'c001:3'], nameOf: () => 'Marta Ribeiro', whole: false });
    assert.ok(lines.some((l) => /\(c001:3\) waits for follow-up 1 \(c001:2\)/.test(l)), JSON.stringify(lines));
    assert.ok(!lines.some((l) => /\(c001:3\) waits for follow-up 2 \(c001:3\)/.test(l)), JSON.stringify(lines));
  } finally {
    rmSync(H, { recursive: true, force: true });
  }
});

test('a grouped hold names every person it holds, with their ID', () => {
  const why = "can't be contacted now: line 12 of the ledger is damaged and doesn't say whose it is (it may hold a stop): look at it, fix or delete the line, then run again";
  const names = { c001: 'Ana Berg', c002: 'Bo Li', c003: 'Cy Ng', c004: 'Dee Ho', c005: 'Eli Tan' };
  const refused = Object.keys(names).map((id) => ({ id, touch: 1, kind: 'message', reason: why, cause: 'blocked', blocking: `${id}:1`, blocking_kind: 'message', why }));
  const { lines } = heldLines({ refused, offered: [], candidates: refused.map((r) => `${r.id}:1`), nameOf: (id) => names[id], whole: true });
  const all = lines.join(' ');
  for (const [id, n] of Object.entries(names)) assert.ok(all.includes(`${n} (${id})`), `${n} (${id}): ${all}`);
  assert.doesNotMatch(all, /\d+ more/);
});
