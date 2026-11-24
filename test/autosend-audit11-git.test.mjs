// Security audit run 11. (A) A denylist of risky git config names missed core.alternateRefsCommand, which, with an
// objects/info/alternates in a shipped data folder's .git, runs a command at fetch: only the settings floorboss and a
// plain init or clone write are taken now, and an alternates file is refused. (B) A data folder with no .git of its
// own made git find the project's .git above it (core.worktree, filters): every git call is now pinned to the data
// folder's own .git. A plain clone of the user's private repo, with their name, email and credential helper in their
// global config, still works. Temp folders only, a local bare repo as the remote; markers are files in the temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { git, ROOT } from './fixtures/autosend-world.mjs';
import * as sync from '../lib/autosend/sync.mjs';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const marksIn = (d) => readdirSync(d).filter((f) => f.startsWith('mark-'));
const AUTOSEND = 'skills/autosend/scripts/cli.mjs';
function codex(cwd, userHome, args, extra = {}) {
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, FLOORBOSS_TEST: '1', CODEX_THREAD_ID: 'codex-thread', ...extra };
  for (const k of ['FLOORBOSS_HOME', 'CLAUDECODE', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) delete env[k];
  const r = spawnSync(process.execPath, [join(ROOT, AUTOSEND), ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return `${r.stdout}\n${r.stderr}`;
}
function dataIn(data) {
  mkdirSync(join(data, 'events', 'expo'), { recursive: true });
  writeFileSync(join(data, 'config.json'), '{}');
  writeFileSync(join(data, 'events', 'expo', 'event.json'), JSON.stringify({ name: 'Expo', slug: 'expo', autosend: true }));
  writeFileSync(join(data, '.gitignore'), '/*\n!/.gitignore\n');
}
const bareRepo = () => {
  const bare = join(tmp('fb-a11-remote-'), 'r.git');
  git(tmpdir(), ['init', '-q', '--bare', '-b', 'main', bare]);
  return bare;
};
// A project whose floorboss/ came with its own .git, pushed to a working remote.
function shipped() {
  const userHome = tmp('fb-a11-user-');
  const project = join(userHome, 'work', 'downloaded');
  const data = join(project, 'floorboss');
  dataIn(data);
  git(data, ['init', '-q', '-b', 'main']);
  git(data, ['add', '-A', '-f', '.']);
  git(data, [...ID, 'commit', '-q', '-m', 'init']);
  const bare = bareRepo();
  git(data, ['remote', 'add', 'origin', bare]);
  git(data, ['push', '-q', '-u', 'origin', 'main']);
  return { userHome, project, data, bare, marks: tmp('fb-a11-marks-') };
}

// ---- A
function altRefs(s) {
  const other = bareRepo();
  git(s.data, ['config', 'core.alternateRefsCommand', `touch "${s.marks}/mark-altrefs"; true`]);
  writeFileSync(join(s.data, '.git', 'objects', 'info', 'alternates'), join(other, 'objects') + '\n');
}
test('A control: git itself runs core.alternateRefsCommand at fetch in such a repo (the marker can see a run)', () => {
  const s = shipped();
  altRefs(s);
  git(s.data, ['fetch', '-q', 'origin']);
  assert.deepEqual(marksIn(s.marks), ['mark-altrefs']);
});
test('A: sync start refuses a data repo with core.alternateRefsCommand and alternates, in plain words, and runs nothing', () => {
  const s = shipped();
  altRefs(s);
  const why = String(sync.repoConfigWhy(s.data));
  assert.match(why, /core\.alternaterefscommand/i, why);
  assert.match(why, /alternates/, why);
  const text = codex(s.project, s.userHome, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-a11']);
  assert.doesNotMatch(text, /"started": true/, text);
  assert.match(text, /git settings/i, text);
  assert.deepEqual(marksIn(s.marks), []);
});
test('A: an alternates file alone is refused (objects read from another repository)', () => {
  const s = shipped();
  writeFileSync(join(s.data, '.git', 'objects', 'info', 'alternates'), join(bareRepo(), 'objects') + '\n');
  assert.match(String(sync.repoConfigWhy(s.data)), /objects\/info\/alternates/);
});
test('A: a setting floorboss does not know is refused by name (an allowlist, not a denylist)', () => {
  for (const k of ['core.alternateRefsCommand', 'core.alternateRefsPrefixes', 'url.x.insteadOf', 'uploadpack.packObjectsHook', 'remote.origin.proxy', 'http.proxy', 'core.pager']) {
    const s = shipped();
    git(s.data, ['config', k, 'true']);
    const why = String(sync.repoConfigWhy(s.data));
    assert.ok(why.toLowerCase().includes(k.toLowerCase()), `${k}: ${why}`);
    assert.match(why, /git config --unset/, why);
  }
});

// ---- A, kept working: a plain clone of the user's private repo, https or ssh.
test("A: a plain clone (https or ssh URL) with the user's global name, email and credential helper is taken", () => {
  for (const url of ['https://github.com/someone/floorboss-data.git', 'git@' + 'github.com:someone/floorboss-data.git']) {
    const userHome = tmp('fb-a11-clone-');
    const bare = bareRepo();
    const seed = join(userHome, 'seed');
    dataIn(seed);
    git(seed, ['init', '-q', '-b', 'main']);
    git(seed, ['add', '-A', '-f', '.']);
    git(seed, [...ID, 'commit', '-q', '-m', 'init']);
    git(seed, ['push', '-q', bare, 'main']);
    const env = { HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config') };
    writeFileSync(join(userHome, '.gitconfig'), '[user]\n\tname = Sam\n\temail = sam@example.com\n[credential]\n\thelper = store\n[init]\n\tdefaultBranch = main\n');
    const data = join(userHome, 'floorboss');
    git(userHome, ['clone', '-q', bare, data], env);
    // What a clone of the GitHub repo leaves, plus what editors and git itself commonly add.
    git(data, ['remote', 'set-url', 'origin', url], env);
    git(data, ['config', 'remote.origin.url', bare], env); // reachable here, same keys
    git(data, ['config', 'branch.main.vscode-merge-base', 'origin/main'], env);
    git(data, ['config', 'user.name', 'Sam'], env);
    git(data, ['config', 'user.email', 'sam@example.com'], env);
    git(data, ['config', 'core.ignorecase', 'true'], env);
    git(data, ['config', 'core.precomposeunicode', 'true'], env);
    assert.equal(sync.repoConfigWhy(data), null, url);
    const keep = process.env.HOME;
    process.env.HOME = userHome;
    try {
      assert.ok(sync.isRepo(data));
      assert.deepEqual(sync.upstreamOf(data), { remote: 'origin', ref: 'refs/heads/main' });
      writeFileSync(join(data, 'config.json'), '{"changed":1}');
      assert.ok(sync.stageData(data).ok);
      assert.ok(sync.pushedAll({ home: data }).ok === false); // committed? not yet: says so, no error from git
    } finally {
      process.env.HOME = keep;
    }
  }
});
// ---- B
function nested() {
  const userHome = tmp('fb-a11-nest-');
  const project = join(userHome, 'work', 'downloaded');
  const data = join(project, 'floorboss');
  const marks = tmp('fb-a11-marks-');
  dataIn(data);
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'core.worktree', data]);
  git(project, ['config', 'filter.x.clean', `touch "${marks}/mark-filter"; cat`]);
  writeFileSync(join(project, '.git', 'info', 'attributes'), '* filter=x\n');
  const bare = bareRepo();
  git(project, ['remote', 'add', 'origin', bare]);
  return { userHome, project, data, marks };
}
test("B control: git in the data folder finds the project's .git and runs its filter", () => {
  const s = nested();
  git(s.data, ['add', '-A', '-f', '.']);
  assert.deepEqual(marksIn(s.marks), ['mark-filter']);
});
test("B: a data folder with no .git of its own is not a checkout, and the project's config never runs", () => {
  const s = nested();
  assert.equal(sync.isRepo(s.data), false);
  sync.stageData(s.data);
  assert.equal(sync.remoteUrl(s.data), null);
  const text = codex(s.project, s.userHome, ['sync', 'start', '--who', 'laptop', '--run', 'laptop-a11']);
  assert.doesNotMatch(text, /"started": true/, text);
  assert.deepEqual(marksIn(s.marks), []);
});
test('B: GIT_DIR, GIT_WORK_TREE and GIT_CONFIG_* from the caller do not redirect git', () => {
  const s = nested();
  const keep = { ...process.env };
  Object.assign(process.env, {
    GIT_DIR: join(s.project, '.git'),
    GIT_WORK_TREE: s.data,
    GIT_CONFIG_PARAMETERS: `'filter.x.clean'='touch ${s.marks}/mark-env; cat'`,
    GIT_CONFIG_GLOBAL: join(s.project, '.git', 'config'),
    GIT_CEILING_DIRECTORIES: ''
  });
  try {
    assert.equal(sync.isRepo(s.data), false);
    sync.stageData(s.data);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  }
  assert.deepEqual(marksIn(s.marks), []);
  assert.ok(dirname(s.data) === s.project);
});
