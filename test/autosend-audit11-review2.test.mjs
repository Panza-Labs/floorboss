// Security audit run 11, the second review of its fixes: the user's yes to the data repo is asked, never taken by the
// model (Claude Code's guard holds the command; in Codex the question to the user is the control), compared and
// stored without the token, checked before every fetch as well as every push, and asked in the owner's words; any
// link under .git is refused; misleading https forms are refused. Temp folders, local bare repos, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { world, remoteFor, git, ROOT, envFor, autosend } from './fixtures/autosend-world.mjs';
import * as sync from '../lib/autosend/sync.mjs';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const CLI = join(ROOT, 'skills/autosend/scripts/cli.mjs');
const TOKEN = 'ghpSECRET0123456789';
const TOKEN_URL = `https://someone:${TOKEN}@github.com/me/floorboss-data.git`;
function shipped() {
  const userHome = tmp('fb-a11s-user-');
  const project = join(userHome, 'work', 'downloaded');
  const data = join(project, 'floorboss');
  mkdirSync(join(data, 'events', 'expo'), { recursive: true });
  writeFileSync(join(data, 'config.json'), '{}');
  writeFileSync(join(data, 'events', 'expo', 'event.json'), JSON.stringify({ name: 'Expo', slug: 'expo', autosend: true }));
  writeFileSync(join(data, '.gitignore'), '/*\n!/.gitignore\n');
  git(data, ['init', '-q', '-b', 'main']);
  git(data, ['add', '-A', '-f', '.']);
  git(data, [...ID, 'commit', '-q', '-m', 'init']);
  const bare = join(tmp('fb-a11s-remote-'), 'r.git');
  git(tmpdir(), ['init', '-q', '--bare', '-b', 'main', bare]);
  git(data, ['remote', 'add', 'origin', bare]);
  git(data, ['push', '-q', '-u', 'origin', 'main']);
  return { userHome, project, data, bare };
}
function codex(s, args) {
  const env = { ...process.env, HOME: s.userHome, USERPROFILE: s.userHome, FLOORBOSS_TEST: '1', CODEX_THREAD_ID: 'codex-thread' };
  for (const k of ['FLOORBOSS_HOME', 'CLAUDECODE', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: s.project, env, encoding: 'utf8', timeout: 60000 });
  return `${r.stdout}\n${r.stderr}`;
}
// The printed confirm command, as a list of words (single-quoted url).
const printedConfirm = (text) => {
  const m = /remote --confirm '([^']+)'/.exec(text);
  return m ? m[1] : null;
};

// ---- 1. the guard holds the command in Claude Code, in a subagent too
const guard = (HOME, input) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-x', tool_use_id: 'toolu_x', ...input }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
test('1: in Claude Code the guard holds autosend remote --confirm (main session and subagent)', () => {
  const { HOME } = world({ touches: 1 });
  for (const extra of [{}, { agent_id: 'agent-1' }]) {
    const r = guard(HOME, { tool_name: 'Bash', tool_input: { command: `node ${CLI} remote --confirm 'https://github.com/me/d.git'` }, ...extra });
    assert.equal(r.status, 2, JSON.stringify(extra) + r.stdout + r.stderr);
    assert.match(r.stderr, /floorboss blocked this call/);
  }
});

// ---- 2 + 3. the token: compared without it, never stored or shown, the printed command works as printed
test('2+3: a url with a token: the read-back, the printed command, remotes.json, the confirm output and status never hold the token; the printed command works', () => {
  const s = shipped();
  git(s.data, ['remote', 'set-url', 'origin', TOKEN_URL]);
  const why = String(sync.remoteBindWhy(s.data));
  assert.ok(!why.includes(TOKEN), why);
  const printed = printedConfirm(why);
  assert.equal(printed, 'https://github.com/me/floorboss-data.git', why);
  const out = codex(s, ['remote', '--confirm', printed]);
  assert.match(out, /"confirmed": true/, out);
  assert.ok(!out.includes(TOKEN), out);
  const file = readFileSync(join(s.userHome, '.config', 'floorboss', 'remotes.json'), 'utf8');
  assert.ok(!file.includes(TOKEN) && file.includes('github.com/me/floorboss-data.git'), file);
  const keep = process.env.HOME;
  process.env.HOME = s.userHome;
  try {
    assert.equal(sync.remoteBindWhy(s.data), null);
    // A different repo on the same host is a refusal that shows both, without the token.
    git(s.data, ['remote', 'set-url', 'origin', `https://someone:${TOKEN}@github.com/evil/x.git`]);
    const bad = String(sync.remoteBindWhy(s.data));
    assert.match(bad, /github\.com\/evil\/x\.git/);
    assert.match(bad, /github\.com\/me\/floorboss-data\.git/);
    assert.ok(!bad.includes(TOKEN), bad);
  } finally {
    process.env.HOME = keep;
  }
  assert.ok(!codex(s, ['status']).includes(TOKEN));
  // git's own words that floorboss relays.
  assert.ok(!sync.redact(`fatal: unable to access '${TOKEN_URL}/': Could not resolve host`).includes(TOKEN));
});

// ---- 4. before every fetch
test('4: a remote that is not the confirmed one is refused before a fetch (sync start, pushedAll, repair), not only a push', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  // The remote serves, but its url isn't the one confirmed: a pushurl to a repo nobody confirmed is enough.
  sync.confirmRemote({ home: w.HOME, url: 'https://github.com/me/floorboss-data.git' });
  // The url stays the local bare repo (so a fetch, if one ran, stays on this machine); the pushurl is a repo nobody
  // confirmed. A fetch that ran leaves FETCH_HEAD.
  git(w.HOME, ['config', 'remote.origin.pushurl', 'https://github.com/evil/x.git']);
  const fh = join(w.HOME, '.git', 'FETCH_HEAD');
  const s = sync.start({ home: w.HOME, who: 'laptop', runId: 'r4', nowMs: Date.now() });
  assert.match(String(s.stop), /github\.com\/evil\/x\.git/, JSON.stringify(s));
  assert.ok(!sync.pushedAll({ home: w.HOME }).ok);
  assert.match(String(sync.pushedAll({ home: w.HOME }).why), /github\.com\/evil\/x\.git/);
  const r = sync.repair({ home: w.HOME, who: 'laptop', nowMs: Date.now() });
  assert.match(JSON.stringify(r), /github\.com\/evil\/x\.git/);
  assert.ok(!readdirSync(join(w.HOME, '.git')).includes('FETCH_HEAD'), 'no fetch ran');
});

// ---- 5. any link under .git
test('5: a link anywhere under .git (an objects/xx folder) is refused; control: git writes through it', () => {
  const s = shipped();
  writeFileSync(join(s.data, 'config.json'), '{"a":1}');
  const blob = git(s.data, ['hash-object', 'config.json']).trim();
  const sub = join(s.data, '.git', 'objects', blob.slice(0, 2));
  mkdirSync(sub, { recursive: true });
  const out = tmp('fb-a11s-out-');
  for (const f of readdirSync(sub)) renameSync(join(sub, f), join(out, f));
  spawnSync('rmdir', [sub]);
  symlinkSync(out, sub);
  const why = String(sync.repoConfigWhy(s.data));
  assert.match(why, new RegExp(`\\.git/objects/${blob.slice(0, 2)} is a link`), why);
  git(s.data, ['add', '-f', 'config.json']);
  assert.ok(readdirSync(out).length > 0, 'git wrote the object outside the data folder');
});
test('5: the walk is bounded: a .git with too many entries is refused, and a few thousand objects take little time', () => {
  const s = shipped();
  const objs = join(s.data, '.git', 'objects');
  for (let i = 0; i < 5000; i++) {
    const d = join(objs, (i % 256).toString(16).padStart(2, '0'));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${i.toString(16).padStart(38, '0')}`), '');
  }
  const t = process.hrtime.bigint();
  assert.equal(sync.repoConfigWhy(s.data), null);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`# repoConfigWhy over ~5000 objects: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 5000, `${ms} ms`);
  let deep = join(s.data, '.git', 'refs', 'heads');
  for (let i = 0; i < 40; i++) deep = join(deep, 'd');
  mkdirSync(deep, { recursive: true });
  assert.match(String(sync.repoConfigWhy(s.data)), /too many|too deep/);
});

// ---- 6. misleading https forms
test('6: misleading https forms are refused; one user:token part is still taken', () => {
  for (const u of ['https://github.com@evil.example/x', 'https://a:b@c@evil.example/x', 'https://a\\@evil.example/x', 'https://github.com./me/x', 'https://github.com/me%40x/y', 'https://github.com/me%2fx', 'https://github.com/me\\x']) assert.equal(sync.remoteUrlOk(u), false, u);
  for (const u of ['https://someone:abc123@git.example/test-user/fb-data.git', 'https://x-access-token:abc@' + 'github.com/me/d.git', 'https://github.com/me/d.git']) assert.equal(sync.remoteUrlOk(u), true, u);
});

// ---- 8. the owner's words
test("8: the read-back asks in the owner's words, three numbered answers, GitHub only for github.com", () => {
  const s = shipped();
  git(s.data, ['remote', 'set-url', 'origin', TOKEN_URL]);
  const why = String(sync.remoteBindWhy(s.data));
  assert.match(why, /floorboss keeps a copy of your contacts and messages in a private GitHub repository\. The cloud task reads that copy to send your follow-ups\./);
  assert.match(why, /This folder sends the copy to: https:\/\/github\.com\/me\/floorboss-data\.git/);
  assert.match(why, /Did you make this repository yourself, and is it private\?/);
  assert.match(why, /1\. Yes, it is mine and it is private\. \(floorboss continues\.\)/);
  assert.match(why, /2\. No\. \(floorboss sends nothing to that address and stops\.\)/);
  assert.match(why, /3\. I am not sure\. \(Open the address in your browser\. GitHub shows the word "Private" near the name of the repository\. If you cannot open it, or it is not yours, answer "No"\.\)/);
  git(s.data, ['remote', 'set-url', 'origin', 'https://git.example.org/me/d.git']);
  const other = String(sync.remoteBindWhy(s.data));
  assert.doesNotMatch(other, /GitHub/);
  assert.match(other, /private repository at git\.example\.org/);
});

// ---- 9. a ~/.config floorboss can't write
test('9: with a read-only ~/.config the answer says the full path and what to do', () => {
  const s = shipped();
  const cfg = join(s.userHome, '.config');
  mkdirSync(cfg, { recursive: true });
  chmodSync(cfg, 0o500);
  const keep = process.env.HOME;
  process.env.HOME = s.userHome;
  try {
    const r = sync.confirmRemote({ home: s.data, url: 'https://github.com/me/d.git' });
    assert.ok(r.stop);
    assert.ok(r.stop.includes(join(cfg, 'floorboss', 'remotes.json')), r.stop);
    assert.match(r.stop, /can write to|chmod|terminal/i, r.stop);
  } finally {
    process.env.HOME = keep;
    chmodSync(cfg, 0o700);
  }
});
