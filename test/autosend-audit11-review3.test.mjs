// Security audit run 11, the third review of its fixes. In Claude Code the laptop steps that go through the sync
// (on, approve, revoke, draft-gone) meet an unconfirmed data repo too: `remote --confirm` runs there behind the
// guard's ask (refused to a subagent, and for any other argument), a stop never waits on the confirm, the .git walk
// runs once per command, an old record's token is taken out, a pushurl gets its own words, a user name with no
// token is the same repo, and answer 2 says what to do. Temp folders, local bare repos, no network.
import { withSeen, withoutRecord } from './fixtures/guard-seen.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { world, remoteFor, git, ROOT, envFor, autosend, addLines, ledgerLines, said, PEOPLE, NOW, EVENT, SLUG, OWN } from './fixtures/autosend-world.mjs';
import { readback, approve } from '../lib/autosend/approval.mjs';
import { AUTO_PICK, choiceFor, recordPick } from '../lib/autosend/pick.mjs';
import { ROUTINE_MODE } from '../lib/autosend/routine.mjs';
import * as sync from '../lib/autosend/sync.mjs';

const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const [ANA, BO] = PEOPLE;
const GM = 'mcp__claude_ai_Gmail__';
const nowMs = Date.parse(NOW);
// A data repo whose fetch stays on this machine (the url is a local bare repo) but whose push address nobody
// confirmed: the binding check stops it before any fetch.
const unconfirmed = (HOME) => {
  remoteFor(HOME);
  git(HOME, ['config', 'remote.origin.pushurl', 'https://github.com/me/floorboss-data.git']);
};
function routineWorld({ approved = true } = {}) {
  const w = world({ touches: 3, people: [ANA, BO], event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  if (!approved) return w;
  approve(w.evDir, { digest: readback(w.evDir, nowMs).digest, said: AUTO_PICK }, nowMs);
  const yes = ledgerLines(w.evDir).filter((e) => e.type === 'autosend_approved');
  const lines = [];
  [ANA, BO].forEach((p, i) => {
    const h = (t) => yes.find((e) => e.id === p.id && e.touch === t).hash;
    lines.push({ at: NOW, type: 'sent', who: 'floorboss', id: p.id, touch: 1, via: 'email.send', channel: 'email', date: '2026-10-09', message_id: `m${i}1`, thread_id: `t${i}`, hash: h(1), source: 'autosend' });
    for (let t = 2; t <= 3; t++) {
      lines.push({ at: NOW, type: 'call_result', who: 'guard', id: p.id, touch: t, kind: 'draft', message_id: `m${i}${t}`, thread_id: `t${i}`, draft_id: `r${i}${t}`, tool: `${GM}create_draft` });
      lines.push({ at: NOW, type: 'autosend_drafted', who: 'floorboss', id: p.id, touch: t, hash: h(t), to: p.email, due: `2026-10-${20 + t}`, draft_id: `r${i}${t}`, message_id: `m${i}${t}`, thread_id: `t${i}`, threaded: true, run: 'run-1' });
    }
  });
  addLines(w.evDir, lines);
  return w;
}
const claude = { claude: true };

// ---- 1c. the four verbs in Claude Code
test('1c on: in Claude Code, an unconfirmed repo asks the owner\'s question, and names remote --confirm', () => {
  const w = world({ touches: 2 });
  unconfirmed(w.HOME);
  const r = autosend(w.HOME, withSeen(w.HOME, ['on', '--event', SLUG, '--said-file', said(w.HOME, 'yes turn it on'), '--own', OWN]), claude);
  assert.match(String(r.ERROR), /Did you make this repository yourself/, r.ERROR);
  assert.match(String(r.ERROR), /remote --confirm 'https:\/\/github\.com\/me\/floorboss-data\.git'/, r.ERROR);
});
test('1c approve: the same', () => {
  const w = routineWorld({ approved: false });
  unconfirmed(w.HOME);
  const rb = readback(w.evDir, nowMs);
  const c = choiceFor({ slug: SLUG, digest: rb.digest, messages: rb.items.length, people: 2, autosendReady: true });
  const q = c.ask_user_question.questions[0];
  assert.equal(recordPick(w.HOME, { session_id: 's1', tool_use_id: 'tu-1', tool_name: 'AskUserQuestion', tool_input: c.ask_user_question, tool_response: { questions: c.ask_user_question.questions, answers: { [q.question]: q.options[0].label } } }, nowMs), true);
  const r = autosend(w.HOME, withSeen(w.HOME, ['approve', '--event', SLUG, '--digest', rb.digest]), claude);
  assert.match(String(r.ERROR), /remote --confirm/, r.ERROR);
});
test('1c revoke: saved here whatever the confirm, and the answer says so first, then the one thing to do now', () => {
  const w = routineWorld();
  unconfirmed(w.HOME);
  const r = autosend(w.HOME, withSeen(w.HOME, ['revoke', '--event', SLUG, '--ids', ANA.id, '--said-file', said(w.HOME, 'stop auto-send for Ana')]), claude);
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_revoked' || /revok/.test(e.type)), 'the revoke is in the ledger here');
  const text = JSON.stringify(r);
  assert.match(text, /Saved here on this computer\. The cloud task doesn't know yet/, text);
});
test('1c draft-gone: saved here whatever the confirm', () => {
  const w = routineWorld();
  autosend(w.HOME, withSeen(w.HOME, ['revoke', '--event', SLUG, '--ids', ANA.id, '--said-file', said(w.HOME, 'stop auto-send for Ana')]), claude);
  unconfirmed(w.HOME);
  // Past its day: before that, draft-gone refuses and the delete step settles it (the audit11-send rule).
  const later = new Date(nowMs + 21 * 86400000).toISOString();
  const r = autosend(w.HOME, withSeen(w.HOME, ['draft-gone', '--event', SLUG, '--id', ANA.id, '--touch', '2', '--said-file', said(w.HOME, "I looked: it's not in Sent and not in Drafts")]), { ...claude, now: later });
  assert.ok(!r.ERROR, r.ERROR);
  assert.ok(ledgerLines(w.evDir).some((e) => e.type === 'autosend_draft_deleted'));
  assert.match(JSON.stringify(r), /Saved here on this computer/);
});

// ---- 1a. the guard's ask
const guard = (HOME, command, extra = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-r', tool_use_id: 'toolu_r', tool_name: 'Bash', tool_input: { command }, ...extra }), env: envFor(HOME, claude), encoding: 'utf8' });
const decision = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput;
  } catch {
    return null;
  }
};
test("1a: remote --confirm <the repo's address> asks the user in Claude Code (the owner's words, Allow and Deny); a subagent and any other argument are refused", () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://someone:tok123@' + 'github.com/me/floorboss-data.git']);
  const ok = guard(w.HOME, `node ${CLI} remote --confirm 'https://github.com/me/floorboss-data.git'`);
  const d = decision(ok);
  assert.equal(d?.permissionDecision, 'ask', ok.stdout + ok.stderr);
  const why = String(d.permissionDecisionReason);
  assert.match(why, /This folder sends the copy to: https:\/\/github\.com\/me\/floorboss-data\.git/);
  assert.match(why, /1\. Yes, it is mine and it is private/);
  assert.match(why, /Allow/);
  assert.match(why, /Deny/);
  assert.ok(!why.includes('tok123'));
  assert.equal(guard(w.HOME, `node ${CLI} remote --confirm 'https://github.com/me/floorboss-data.git'`, { agent_id: 'a1' }).status, 2);
  for (const c of [`node ${CLI} remote --confirm 'https://github.com/evil/x.git'`, `node ${CLI} remote`, `node ${CLI} remote --confirm 'https://github.com/me/floorboss-data.git' --x y`, `node ${CLI} remote --set 'https://github.com/me/floorboss-data.git'`])
    assert.equal(guard(w.HOME, c).status, 2, c);
  // The command itself works in Claude Code once allowed.
  const r = autosend(w.HOME, withSeen(w.HOME, ['remote', '--confirm', 'https://github.com/me/floorboss-data.git']), claude);
  assert.equal(r.confirmed, true, r.ERROR);
});

// ---- 2. one walk per command
test('2: one laptopWrite walks .git once', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  sync.forgetWalks();
  const before = sync.walkCount();
  sync.laptopWrite({ home: w.HOME, nowMs, what: 'test' }, () => writeFileSync(join(w.HOME, 'config.json'), '{"x":1}'));
  assert.equal(sync.walkCount() - before, 1);
});

// ---- 3. an old record with a token
test('3: an old remotes.json record that holds a token is written back without it', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://someone:tok123@' + 'github.com/me/floorboss-data.git']);
  mkdirSync(join(process.env.HOME, '.config', 'floorboss'), { recursive: true });
  const f = sync.remotesFile();
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(f, 'utf8'));
  } catch {}
  const { realpathSync } = await_import_fs();
  writeFileSync(f, JSON.stringify({ ...cur, [realpathSync(w.HOME)]: 'https://someone:tok123@' + 'github.com/me/floorboss-data.git' }));
  assert.equal(sync.remoteBindWhy(w.HOME), null);
  assert.ok(!readFileSync(f, 'utf8').includes('tok123'), readFileSync(f, 'utf8'));
});
import * as fsAll from 'node:fs';
function await_import_fs() {
  return fsAll;
}

// ---- 4. a pushurl
test('4: a pushurl other than the confirmed address: the words say to remove it (the right command), no confirm that cannot pass', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://github.com/me/floorboss-data.git']);
  sync.confirmRemote({ home: w.HOME, url: 'https://github.com/me/floorboss-data.git' });
  git(w.HOME, ['config', 'remote.origin.pushurl', 'https://github.com/evil/x.git']);
  const why = String(sync.remoteBindWhy(w.HOME));
  assert.match(why, /git config --unset remote\.origin\.pushurl/, why);
  assert.doesNotMatch(why, /remote --confirm 'https:\/\/github\.com\/evil/, why);
});
test('4: confirm uses the remote the upstream names, not always origin', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  const bare = git(w.HOME, ['remote', 'get-url', 'origin']).trim();
  git(w.HOME, ['remote', 'rename', 'origin', 'data']);
  git(w.HOME, ['remote', 'add', 'origin', 'https://github.com/someone/else.git']);
  git(w.HOME, ['remote', 'set-url', 'data', 'https://github.com/me/floorboss-data.git']);
  assert.deepEqual(sync.upstreamOf(w.HOME)?.remote, 'data');
  const r = autosend(w.HOME, ['remote', '--confirm', 'https://github.com/me/floorboss-data.git']);
  assert.equal(r.confirmed, true, r.ERROR);
  assert.ok(bare);
});

// ---- 5. a user name with no token
test('5: https://u@host/... is taken, and is the same repo as without the name', () => {
  assert.equal(sync.remoteUrlOk('https://u@' + 'github.com/o/r.git'), true);
  assert.equal(sync.bareUrl('https://u@' + 'github.com/o/r.git'), 'https://github.com/o/r.git');
});

// ---- 6. wording
test('6: answer 2 says what to do next; a changed address says what happened and the two choices before the command', () => {
  const q = sync.confirmQuestion('https://github.com/me/d.git');
  assert.match(q, /2\. No\. \(floorboss sends nothing to that address and stops\.\) This folder came from someone else or points at the wrong place: don't use it for auto-send, and ask floorboss to set up your own\./, q);
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://github.com/me/floorboss-data.git']);
  sync.confirmRemote({ home: w.HOME, url: 'https://github.com/me/floorboss-data.git' });
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://github.com/other/x.git']);
  const why = String(sync.remoteBindWhy(w.HOME));
  assert.match(why, /This folder's repository address changed since you confirmed it\. Either you moved your data yourself, and you confirm the new address; or you didn't, and you set it back\./, why);
  assert.ok(why.indexOf('changed since you confirmed') < why.indexOf('git remote set-url'));
});

// The one-use record (0.1.7): the same kind of call with no record of the guard's is refused, and changes nothing.
test('without the guard\'s record, on is refused in Claude Code and changes nothing', async () => {
  const r = await withoutRecord('on');
  assert.match(r.error, /safety check did not see this command/);
  assert.ok(r.unchanged);
});
