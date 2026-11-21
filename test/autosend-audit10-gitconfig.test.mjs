// Security audit run 10, finding 1: in Codex the data folder is <project>/floorboss, and a project can ship that
// folder with its own .git (an archive or a copied folder can). git honours a repo's own config, so a
// core.fsmonitor or remote.<r>.uploadpack there would run a program each time floorboss runs git. floorboss refuses
// such a data repo in plain words, before any git command that could run one, and never passes git a GIT_* variable
// it didn't set. Every folder is a temp folder, the remote a local bare repo; nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { world, remoteFor, git, ROOT } from './fixtures/autosend-world.mjs';
import * as sync from '../lib/autosend/sync.mjs';

const MARKERS = ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// A project folder whose floorboss/ came with it: data floorboss reads, a .git of its own with a remote that
// works, and the given config lines (written by `git config`, as any archive's author could).
function shipped(config) {
  const userHome = tmp('fb-a10-user-');
  const project = join(userHome, 'work', 'downloaded');
  const data = join(project, 'floorboss');
  const marks = tmp('fb-a10-marks-');
  mkdirSync(join(data, 'events', 'expo'), { recursive: true });
  writeFileSync(join(data, 'config.json'), '{}');
  writeFileSync(join(data, 'events', 'expo', 'event.json'), JSON.stringify({ name: 'Expo', slug: 'expo', autosend: true }));
  writeFileSync(join(data, '.gitignore'), '/*\n!/.gitignore\n');
  git(data, ['init', '-q', '-b', 'main']);
  git(data, ['add', '-A', '-f', '.']);
  git(data, [...ID, 'commit', '-q', '-m', 'init']);
  const bare = join(tmp('fb-a10-remote-'), 'r.git');
  git(tmpdir(), ['init', '-q', '--bare', '-b', 'main', bare]);
  git(data, ['remote', 'add', 'origin', bare]);
  git(data, ['push', '-q', '-u', 'origin', 'main']);
  for (const [k, v] of Object.entries(config(marks))) git(data, ['config', k, v]);
  return { userHome, project, data, marks, bare };
}
const hostile = (m) => ({ 'core.fsmonitor': `touch "${m}/mark-fsmonitor"; false`, 'remote.origin.uploadpack': `touch "${m}/mark-uploadpack"; git-upload-pack` });
const marksIn = (d) => readdirSync(d).filter((f) => f.startsWith('mark-'));
// A floorboss command as Codex runs it from the project folder: a Codex marker, no FLOORBOSS_HOME.
function codex(cwd, userHome, script, args) {
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, FLOORBOSS_TEST: '1', CODEX_THREAD_ID: 'codex-thread' };
  delete env.FLOORBOSS_HOME;
  delete env.CLAUDECODE;
  for (const k of MARKERS) if (k !== 'CODEX_THREAD_ID') delete env[k];
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, text: `${r.stdout}\n${r.stderr}` };
}
const AUTOSEND = 'skills/autosend/scripts/cli.mjs';
const OUTREACH = 'skills/event-outreach/scripts/cli.mjs';
const REFUSAL = /git settings/i;

test('control: a shipped data repo with no such settings is used as before (the marker test can see a run)', () => {
  const s = shipped(() => ({}));
  const r = codex(s.project, s.userHome, AUTOSEND, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-a10']);
  assert.match(r.text, /"started": true/, r.text);
  // And with the settings put back, git itself does run them (outside floorboss): the markers prove a run.
  git(s.data, ['config', 'core.fsmonitor', `touch "${s.marks}/mark-fsmonitor"; false`]);
  git(s.data, ['status', '--porcelain']);
  assert.deepEqual(marksIn(s.marks), ['mark-fsmonitor']);
});

test('sync start refuses a data repo whose own config sets fsmonitor and uploadpack, and runs neither', () => {
  const s = shipped(hostile);
  const r = codex(s.project, s.userHome, AUTOSEND, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-a10']);
  assert.doesNotMatch(r.text, /"started": true/, r.text);
  assert.match(r.text, REFUSAL, r.text);
  assert.match(r.text, /core\.fsmonitor/);
  assert.deepEqual(marksIn(s.marks), [], 'no program from the repo config ran');
});

test('record (an outreach command that writes through the sync) refuses it, and runs neither', () => {
  const s = shipped(hostile);
  const f = join(s.userHome, 'r.json');
  writeFileSync(f, JSON.stringify({ items: [] }));
  const r = codex(s.project, s.userHome, OUTREACH, ['record', '--event', 'expo', '--file', f]);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, REFUSAL, r.text);
  assert.deepEqual(marksIn(s.marks), []);
});

test('init refuses it in plain words, and runs neither', () => {
  const s = shipped(hostile);
  const r = codex(s.project, s.userHome, AUTOSEND, ['init', '--remote', s.bare]);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, REFUSAL, r.text);
  assert.deepEqual(marksIn(s.marks), []);
});

test('every setting that can start a program or reach elsewhere is refused by name', () => {
  for (const [k, v] of [
    ['include.path', '/nonexistent/x'],
    ['includeIf.gitdir:/.path', '/nonexistent/x'],
    ['core.sshCommand', 'true'],
    ['remote.origin.receivepack', 'true'],
    ['filter.x.clean', 'cat'],
    ['diff.x.textconv', 'cat'],
    ['credential.helper', 'store'],
    ['core.worktree', '/nonexistent']
  ]) {
    const s = shipped(() => ({ [k]: v }));
    const why = sync.repoConfigWhy(s.data);
    assert.match(String(why), REFUSAL, k);
    assert.ok(String(why).toLowerCase().includes(k.toLowerCase().replace(/\.path$/, '')), `${k}: ${why}`);
  }
  // A data repo floorboss set up itself has none of them.
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  assert.equal(sync.repoConfigWhy(w.HOME), null);
});

test('git gets no GIT_* variable floorboss did not set: a GIT_CONFIG_* filter in the environment never runs', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  const marks = tmp('fb-a10-env-');
  const attrs = join(marks, 'attrs');
  writeFileSync(attrs, '* filter=x\n');
  writeFileSync(join(w.HOME, 'config.json'), JSON.stringify({ disclaimer_ack: true, changed: 1 }));
  const keep = { ...process.env };
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.attributesFile',
    GIT_CONFIG_VALUE_0: attrs,
    GIT_CONFIG_KEY_1: 'filter.x.clean',
    GIT_CONFIG_VALUE_1: `touch "${marks}/mark-filter"; cat`
  });
  try {
    assert.ok(sync.stageData(w.HOME).ok);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  }
  assert.deepEqual(marksIn(marks), []);
});

test('a remote name that starts with "-" is no upstream (git would read it as an option)', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  assert.ok(sync.upstreamOf(w.HOME));
  execFileSync('git', ['config', 'branch.main.remote', '-oops'], { cwd: w.HOME });
  assert.equal(sync.upstreamOf(w.HOME), null);
});

test('fetch and push name upload-pack and receive-pack themselves (a remote config of them is never used)', () => {
  const code = execFileSync('cat', [join(ROOT, 'lib/autosend/sync.mjs')], { encoding: 'utf8' });
  const calls = [...code.matchAll(/git\(home, \['(fetch|push)'[^\]]*\]/g)];
  assert.ok(calls.length >= 5, `${calls.length} fetch and push calls`);
  assert.ok(code.includes("const UPLOAD = '--upload-pack=git-upload-pack';") && code.includes("const RECEIVE = '--receive-pack=git-receive-pack';"));
  for (const m of calls) assert.match(m[0], m[1] === 'fetch' ? /\bUPLOAD\b/ : /\bRECEIVE\b/, m[0]);
  assert.ok(existsSync(join(ROOT, 'lib/autosend/sync.mjs')));
});
