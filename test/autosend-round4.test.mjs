// Round 4 (the independent review of 8e9f440..0d276e9): a message the user sends by hand ends auto-send for the
// rest of that sequence (and a missed one is approved again only on the user's word it wasn't sent); a sender read two
// ways across fields stops the run, and an empty thread counts its own sender; the guard-marker hold on the laptop's
// readback; discardUnpushed checks the tree; the data repo's .gitignore lets nothing through by itself; Claude Code's
// output as at 8e9f440 (check_these wording, replies_since, todo.json); offered times already past are held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { world, approvedLines, addLines, ledgerLines, remoteFor, cloneOf, git, PEOPLE, NOW } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { dueNow } from '../lib/autosend/plan.mjs';
import { decide } from '../lib/autosend/replycheck.mjs';
import * as sync from '../lib/autosend/sync.mjs';
import { checkTheseQuestion } from '../skills/flow/scripts/steps/triage.mjs';
import { sentHome, runAs } from './fixtures/codex-sent.mjs';
import { MOCK } from './fixtures/r2.mjs';

const at = (iso) => Date.parse(iso);
const SENTENCE = 'auto-send these sequences';
function approved(opts = {}) {
  const w = world({ touches: 2, ...opts });
  process.env.FLOORBOSS_HOME = w.HOME;
  const r = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: r.digest, said: SENTENCE }, at(NOW));
  return w;
}
const waitOf = (r, id) => r.waits.find((w) => w.id === id)?.why || '';

test('item 1: message 1 sent by hand ends auto-send for the rest of that sequence; the readback re-offers the follow-up for a fresh yes', () => {
  const w = approved();
  addLines(w.evDir, [{ at: '2026-10-15T10:00:00Z', type: 'sent', who: 'user', id: 'c001', touch: 1, via: 'email.send', channel: 'email', date: '2026-10-15', said: 'sent it by hand' }]);
  for (const d of ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-26', '2026-10-27']) {
    const p = dueNow(w.HOME, at(`${d}T10:00:00Z`));
    assert.ok(!p.due.some((y) => y.id === 'c001'), d);
  }
  assert.match(waitOf(dueNow(w.HOME, at('2026-10-21T10:00:00Z')), 'c001'), /yours to send/);
  const rb = readback(w.evDir, at('2026-10-16T08:30:00Z'));
  const mine = rb.items.filter((x) => x.id === 'c001');
  assert.deepEqual(mine.map((x) => x.touch), [2]);
  // (Bo's and Cy's first messages missed their day meanwhile: the user's word that they weren't sent by hand.)
  approve(w.evDir, { digest: rb.digest, said: SENTENCE, notSentSaid: "I didn't send Bo's or Cy's" }, at('2026-10-16T08:30:00Z'));
  const due = dueNow(w.HOME, at(`${mine[0].planned_day}T10:00:00Z`)).due.find((x) => x.id === 'c001');
  assert.equal(due?.touch, 2, JSON.stringify(dueNow(w.HOME, at(`${mine[0].planned_day}T10:00:00Z`)).waits.find((x) => x.id === 'c001')));
  // A send auto-send made, settled as "it went" on the laptop, doesn't end anything.
  const w2 = approved({ people: [PEOPLE[1]] });
  addLines(w2.evDir, [{ at: '2026-10-12T10:00:00Z', type: 'sent', who: 'user', id: 'c002', touch: 1, via: 'email.send', channel: 'email', date: '2026-10-12', source: 'autosend', settled: true, said: 'in Sent' }]);
  assert.ok(!/yours to send/.test(waitOf(dueNow(w2.HOME, at('2026-10-19T10:00:00Z')), 'c002')));
});

test('item 2: { from: own, sender: them } and other fields naming two people stop the run; an empty thread counts its own sender', () => {
  const item = { to: 'ana@north.example', since_ms: at(NOW) };
  const own = 'sam@lanecraft.example';
  for (const m of [{ from: own, sender: 'ana@north.example' }, { from: own, headers: { From: 'Ana <ana@north.example>' } }, { from_email: own, from: 'bo@east.example' }])
    assert.match(decide(item, JSON.stringify([m]), { own }).error || '', /reads two ways/, JSON.stringify(m));
  assert.deepEqual(decide(item, JSON.stringify([{ from: own, sender: 'Sam <sam+x@lanecraft.example>' }]), { own }), { go: true }, 'one person two ways is one person');
  assert.equal(decide(item, JSON.stringify({ threads: [{ id: 't', from: 'ana@north.example', messages: [] }] }), { own }).stop, 'reply');
});

test('item 3: the laptop readback holds a step the guard has a marker for (laptop-only: the markers are never in the repo)', () => {
  const w = world({ touches: 2 });
  process.env.FLOORBOSS_HOME = w.HOME;
  mkdirSync(join(w.evDir, 'released'), { recursive: true });
  writeFileSync(join(w.evDir, 'released', 'c001-1-0'), '');
  const rb = readback(w.evDir, at(NOW));
  assert.match(rb.refused.find((x) => x.id === 'c001')?.why || '', /guard has a mark/);
  assert.ok(!sync.DATA_RE.test('events/harbor-expo/released/c001-1-0'));
});

test('item 4: discardUnpushed refuses an upstream whose tree isn\'t floorboss\'s, and changes nothing', () => {
  const { HOME, bare } = (() => {
    const w = world({ touches: 1 });
    return { ...w, ...remoteFor(w.HOME) };
  })();
  const c = cloneOf(bare, 'other');
  writeFileSync(join(c, 'browser-send.json'), '{}');
  git(c, ['add', '-f', '-A']);
  git(c, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'plant']);
  git(c, ['push', '-q']);
  git(HOME, ['fetch', '-q']);
  const head = git(HOME, ['rev-parse', 'HEAD']).trim();
  assert.match(sync.discardUnpushed({ home: HOME }).stop || '', /isn't floorboss's data/);
  assert.equal(git(HOME, ['rev-parse', 'HEAD']).trim(), head);
  assert.ok(!existsSync(join(HOME, 'browser-send.json')));
});

test('item 5: the data repo\'s .gitignore lets nothing through by itself (the reviewer\'s paths), and floorboss stages exactly DATA_RE', () => {
  const d = mkdtempSync(join(tmpdir(), 'fb-as-gi-'));
  git(d, ['init', '-q']);
  writeFileSync(join(d, '.gitignore'), sync.GITIGNORE);
  const odd = ['events/ab/drafts/notes.md', 'events/ab/drafts/sub/x.json', 'autosend/runs/x/1-search.json', 'autosend/log-x.md', 'events/top.json', 'events/ab_c/ledger.jsonl'];
  const good = ['config.json', 'events/ab/ledger.jsonl', 'events/ab/event.json', `events/ab/drafts/${'a'.repeat(24)}.json`, 'autosend/runs/r-1.json', 'autosend/log-2026-10-12.md'];
  for (const f of [...odd, ...good]) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), '{}');
  }
  git(d, ['add', '-A']);
  assert.deepEqual(git(d, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean), ['.gitignore'], 'a hand-made add -A adds nothing else');
  git(d, ['reset', '-q']);
  assert.deepEqual(sync.stageData(d), { ok: true });
  const staged = git(d, ['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(staged, [...good, '.gitignore'].sort());
  for (const f of odd) assert.equal(sync.DATA_RE.test(f), false, f);
});

test('item 6a: check_these reads as at 8e9f440 in Claude Code; plain choices only in hand-send with no CRM', () => {
  const OLD = 'For each person in check-these: same-person (name the CRM row), different-person, not-in-crm (the CRM lookup gave no answer and the CRM has nobody for them), reach, warm or skip, with a word on why.';
  assert.equal(checkTheseQuestion({ ob: { ans: {} } }, { CLAUDECODE: '1' }), OLD);
  assert.equal(checkTheseQuestion({ ob: { ans: { crm_choice: 'connector' } } }, { CODEX_SESSION_ID: 's' }), OLD);
  assert.match(checkTheseQuestion({ ob: { ans: {} } }, { CODEX_SESSION_ID: 's' }), /same person as the one shown beside them/);
});

test('item 6b and 6c: in Claude Code, replies_since and todo.json are as at 8e9f440; in Codex "recorded" takes the count as it is now', { timeout: 600000 }, () => {
  const OLD_FORMAT = '"none"; or first record what they told you (write it as items and run outreach record, as in the event-outreach skill\'s "Recording what happened"), then answer {"answer":"recorded","ledger_lines":<this step\'s ledger_lines>}';
  for (const codex of [false, true]) {
    const { HOME, sent } = sentHome(codex);
    const env = { FLOORBOSS_NOW: '2026-10-13T09:00:00Z' };
    const s = runAs(HOME, codex, 'flow', ['next', '--event', MOCK], env);
    assert.equal(s.step, 'replies_since', JSON.stringify(s).slice(0, 300));
    const note = join(HOME, 'events', MOCK, 'work', 'replies-asked.json');
    const todo = JSON.parse(readFileSync(join(HOME, 'events', MOCK, 'derived', 'todo.json'), 'utf8'));
    if (!codex) {
      assert.equal(s.ask.answer_format, OLD_FORMAT);
      assert.equal(existsSync(note), false, 'nothing written in Claude Code');
      assert.equal('autosend' in todo, false, 'no autosend key in todo.json with auto-send off');
      continue;
    }
    assert.equal(existsSync(note), true);
    assert.equal('autosend' in todo, false);
    writeFileSync(join(HOME, 'work', 'reply.json'), JSON.stringify({ items: [{ who: sent[0], what: 'replied', said: 'she wrote back yes' }] }));
    assert.ok(!runAs(HOME, true, 'event-outreach', ['record', '--event', MOCK, '--file', join(HOME, 'work', 'reply.json')], env).ERROR);
    const now = ledgerLines(join(HOME, 'events', MOCK)).length;
    const f = join(HOME, 'work', 'rs.json');
    writeFileSync(f, JSON.stringify({ answer: 'recorded', ledger_lines: now }));
    const a = runAs(HOME, true, 'flow', ['answer', '--event', MOCK, '--ask', 'replies_since', '--value-file', f], env);
    assert.ok(!a.ERROR, a.ERROR);
  }
  void readdirSync;
});

test('item 7: an offered time already past holds the message; the hours are checked before 09:00 too', () => {
  // As the real code writes it: the text by saveDraft, the time it offers on its drafted line (never in the draft
  // file), then the content approval and the second yes.
  const w = world({ touches: 2 });
  process.env.FLOORBOSS_HOME = w.HOME;
  const slots = [{ id: 's20261012-0800', start: '2026-10-12T08:00:00Z', end: '2026-10-12T08:30:00Z' }];
  writeFileSync(join(w.evDir, 'slots.json'), JSON.stringify({ slots }));
  const m = approvedLines(w.evDir, PEOPLE[0], 1, { at: '2026-10-12T07:30:00Z', extra: ' Monday at 08:00 suits?', slot_ids: ['s20261012-0800'] });
  addLines(w.evDir, m.lines);
  const rb = readback(w.evDir, at(NOW));
  approve(w.evDir, { digest: rb.digest, said: SENTENCE }, at(NOW));
  assert.ok(!('slot_ids' in JSON.parse(readFileSync(join(w.evDir, 'drafts', `${m.hash}.json`), 'utf8'))));
  assert.match(waitOf(dueNow(w.HOME, at('2026-10-12T09:00:00Z')), 'c001'), /already past/);
  // Before 09:00 in Lisbon (the review moved finding 6's check to 16:30Z): nothing goes, the hours say why.
  const w2 = approved();
  assert.match(waitOf(dueNow(w2.HOME, at('2026-10-12T07:58:00Z')), 'c002'), /08:58 in Lisbon/);
  void execFileSync;
});
