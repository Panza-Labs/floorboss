// Security audit run 11, the review of its fixes. A data repo's remote url is checked (https, ssh as git@, no
// credentials, no helper "x::"), and is the one the user confirmed, recorded outside the data folder; git is limited
// to the https and ssh protocols; links in the main .git entries are refused; read-only settings people commonly have
// are taken, and core.fsmonitor and core.hooksPath only because floorboss's own -c beats them; a refusal names the
// command that removes each setting. Temp folders only, local bare repos, markers in the temp folder, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, realpathSync, symlinkSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { world, remoteFor, git, ROOT } from './fixtures/autosend-world.mjs';
import * as sync from '../lib/autosend/sync.mjs';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const marksIn = (d) => readdirSync(d).filter((f) => f.startsWith('mark-'));
function shipped() {
  const userHome = tmp('fb-a11r-user-');
  const project = join(userHome, 'work', 'downloaded');
  const data = join(project, 'floorboss');
  mkdirSync(join(data, 'events', 'expo'), { recursive: true });
  writeFileSync(join(data, 'config.json'), '{}');
  writeFileSync(join(data, 'events', 'expo', 'event.json'), JSON.stringify({ name: 'Expo', slug: 'expo', autosend: true }));
  writeFileSync(join(data, '.gitignore'), '/*\n!/.gitignore\n');
  git(data, ['init', '-q', '-b', 'main']);
  git(data, ['add', '-A', '-f', '.']);
  git(data, [...ID, 'commit', '-q', '-m', 'init']);
  const bare = join(tmp('fb-a11r-remote-'), 'r.git');
  git(tmpdir(), ['init', '-q', '--bare', '-b', 'main', bare]);
  git(data, ['remote', 'add', 'origin', bare]);
  git(data, ['push', '-q', '-u', 'origin', 'main']);
  return { userHome, project, data, bare, marks: tmp('fb-a11r-marks-') };
}
function codex(s, args, extra = {}) {
  const env = { ...process.env, HOME: s.userHome, USERPROFILE: s.userHome, FLOORBOSS_TEST: '1', CODEX_THREAD_ID: 'codex-thread', ...extra };
  for (const k of ['FLOORBOSS_HOME', 'CLAUDECODE', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']) delete env[k];
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, 'skills/autosend/scripts/cli.mjs'), ...args], { cwd: s.project, env, encoding: 'utf8', timeout: 90000 });
  return { text: `${r.stdout}\n${r.stderr}`, ms: Date.now() - t };
}

// ---- 1a. the remote url's value
test('1a: a remote url that is not plain https or ssh (a helper, an option, another scheme, another ssh user) is refused', () => {
  for (const url of ['zzz::foo', 'fd::0', 'ext::sh -c touch% x', '-oProxyCommand=x', 'file:///tmp/x.git', 'git://github.com/me/d.git', 'ssh://evil@' + 'github.com/me/d.git', 'https://github.com/me/d.git::x']) {
    const s = shipped();
    git(s.data, ['config', 'remote.origin.url', url]);
    const why = String(sync.repoConfigWhy(s.data));
    assert.match(why, /remote\.origin\.url/, `${url}: ${why}`);
    assert.match(why, /git remote set-url origin/, why);
  }
  for (const url of ['https://github.com/me/d.git', 'https://someone:abc123@git.example/me/d.git', 'ssh://git@' + 'github.com/me/d.git', 'git@' + 'github.com:me/d.git', 'https://gitlab.example.com:8443/team/d']) {
    const s = shipped();
    git(s.data, ['remote', 'set-url', 'origin', url]);
    assert.equal(sync.repoConfigWhy(s.data), null, url);
  }
});
test('1a: a pushurl gets the same check', () => {
  const s = shipped();
  git(s.data, ['config', 'remote.origin.pushurl', 'zzz::foo']);
  assert.match(String(sync.repoConfigWhy(s.data)), /remote\.origin\.pushurl/);
  git(s.data, ['config', 'remote.origin.pushurl', 'git@' + 'github.com:me/d.git']);
  assert.equal(sync.repoConfigWhy(s.data), null);
});
test('1a: a local path is a remote only in the test suite (FLOORBOSS_TEST)', () => {
  const s = shipped();
  assert.equal(sync.repoConfigWhy(s.data), null);
  const keep = process.env.FLOORBOSS_TEST;
  delete process.env.FLOORBOSS_TEST;
  try {
    assert.match(String(sync.repoConfigWhy(s.data)), /remote\.origin\.url/);
  } finally {
    process.env.FLOORBOSS_TEST = keep;
  }
});
test('1a: zzz:: never starts a git-remote-zzz on PATH, and fd::0 is refused at once (no 120 s hang)', () => {
  const s = shipped();
  const bin = tmp('fb-a11r-bin-');
  writeFileSync(join(bin, 'git-remote-zzz'), `#!/bin/sh\ntouch "${s.marks}/mark-helper"\nexit 1\n`);
  chmodSync(join(bin, 'git-remote-zzz'), 0o755);
  const PATH = `${bin}:${process.env.PATH}`;
  // Control: git itself does run it.
  spawnSync('git', ['fetch', '-q', 'zzz::foo'], { cwd: s.data, env: { ...process.env, PATH }, encoding: 'utf8' });
  assert.deepEqual(marksIn(s.marks), ['mark-helper']);
  readdirSync(s.marks).forEach(() => spawnSync('rm', ['-f', join(s.marks, 'mark-helper')]));
  git(s.data, ['remote', 'set-url', 'origin', 'zzz::foo']);
  const a = codex(s, ['sync', 'start', '--who', 'laptop', '--run', 'r1'], { PATH });
  assert.doesNotMatch(a.text, /"started": true/, a.text);
  assert.deepEqual(marksIn(s.marks), []);
  git(s.data, ['remote', 'set-url', 'origin', 'fd::0']);
  const b = codex(s, ['sync', 'start', '--who', 'laptop', '--run', 'r2']);
  assert.match(b.text, /remote\.origin\.url/, b.text);
  assert.ok(b.ms < 20000, `${b.ms} ms`);
});
test('1b: every git call carries protocol limits: none but https and ssh (and file, in the test suite only)', () => {
  const code = spawnSync('cat', [join(ROOT, 'lib/autosend/sync.mjs')], { encoding: 'utf8' }).stdout;
  for (const s of ["'protocol.allow=never'", "'protocol.https.allow=always'", "'protocol.ssh.allow=always'"]) assert.ok(code.includes(s), s);
  assert.match(code, /protocol\.file\.allow=\$\{process\.env\.FLOORBOSS_TEST === '1' \? 'always' : 'never'\}/);
});

// ---- 1c. the remote is the one the user confirmed
test('1c: a push goes only to the repo the user confirmed: a different url is refused with both shown, before any push', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://attacker.example/x.git']);
  sync.confirmRemote({ home: w.HOME, url: 'https://github.com/me/floorboss-data.git' });
  writeFileSync(join(w.HOME, 'config.json'), '{"changed":2}');
  const c = sync.checkpoint({ home: w.HOME, message: 'x' });
  assert.ok(c.stop, JSON.stringify(c));
  assert.match(c.stop, /https:\/\/attacker\.example\/x\.git/);
  assert.match(c.stop, /https:\/\/github\.com\/me\/floorboss-data\.git/);
  assert.doesNotMatch(c.stop, /the push failed: .*(resolve|Could not)/i, 'refused before git tried the network');
});
test('1c: with nothing recorded yet, the url is read back for a yes (one command), not refused for good; a yes records it', () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  git(w.HOME, ['remote', 'set-url', 'origin', 'https://github.com/me/floorboss-data.git']);
  const why = sync.remoteBindWhy(w.HOME);
  assert.match(String(why), /https:\/\/github\.com\/me\/floorboss-data\.git/);
  assert.match(String(why), /remote --confirm/);
  sync.confirmRemote({ home: w.HOME, url: 'https://github.com/me/floorboss-data.git' });
  assert.equal(sync.remoteBindWhy(w.HOME), null);
  // The record is outside the data folder, where a shipped project can't put one.
  assert.ok(!existsSync(join(w.HOME, 'remotes.json')));
  assert.ok(existsSync(sync.remotesFile()) && !sync.remotesFile().startsWith(w.HOME));
});
test('1c: the CLI remote --confirm records it, and refuses a url that is not the repo\'s', () => {
  const s = shipped();
  git(s.data, ['remote', 'set-url', 'origin', 'https://github.com/me/floorboss-data.git']);
  const bad = codex(s, ['remote', '--confirm', 'https://github.com/someone-else/x.git']);
  assert.match(bad.text, /isn't the data folder's remote/, bad.text);
  const ok = codex(s, ['remote', '--confirm', 'https://github.com/me/floorboss-data.git']);
  assert.match(ok.text, /"confirmed": true/, ok.text);
});

// ---- 2. links in the main .git entries
test('2: a .git whose objects, refs, info or HEAD is a link is refused (git would write outside the data folder)', () => {
  for (const e of ['objects', 'refs', 'info', 'HEAD']) {
    const s = shipped();
    const out = join(tmp('fb-a11r-out-'), e);
    renameSync(join(s.data, '.git', e), out);
    symlinkSync(out, join(s.data, '.git', e));
    const why = String(sync.repoConfigWhy(s.data));
    assert.match(why, new RegExp(`\\.git/${e} is a link`), `${e}: ${why}`);
  }
});
test('2 control: git itself writes objects through such a link', () => {
  const s = shipped();
  const out = join(tmp('fb-a11r-out-'), 'objects');
  renameSync(join(s.data, '.git', 'objects'), out);
  symlinkSync(out, join(s.data, '.git', 'objects'));
  const before = spawnSync('find', [out, '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').length;
  writeFileSync(join(s.data, 'config.json'), '{"x":1}');
  git(s.data, ['add', '-f', 'config.json']);
  assert.ok(spawnSync('find', [out, '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n').length > before);
});

// ---- 3. read-only settings taken; partial clones refused
// core.fsmonitor stays refused in a repo's own config: test/autosend-audit10-gitconfig.test.mjs holds floorboss to
// naming it. The override test below sets it in the user's global config instead.
test('3: common read-only settings are taken', () => {
  const s = shipped();
  for (const [k, v] of [['pull.rebase', 'true'], ['pull.ff', 'only'], ['core.autocrlf', 'input'], ['core.eol', 'lf'], ['core.safecrlf', 'warn'], ['remote.origin.prune', 'true'], ['remote.origin.tagopt', '--no-tags'], ['fetch.prune', 'true'], ['core.untrackedcache', 'true'], ['lfs.repositoryformatversion', '0'], ['branch.main.description', 'mine'], ['core.hooksPath', '.githooks']])
    git(s.data, ['config', k, v]);
  assert.equal(sync.repoConfigWhy(s.data), null);
});
test('3: a partial clone is refused, with clone again without --filter', () => {
  for (const [k, v] of [['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none'], ['extensions.partialclone', 'origin']]) {
    const s = shipped();
    git(s.data, ['config', k, v]);
    const why = String(sync.repoConfigWhy(s.data));
    assert.match(why, new RegExp(k.replace(/\./g, '\\.')), why);
    assert.match(why, /without --filter/, why);
  }
});
test("3: floorboss's own -c beats a repo's core.fsmonitor and core.hooksPath (neither runs on status, commit or push)", () => {
  const w = world({ touches: 1 });
  remoteFor(w.HOME);
  sync.confirmRemote({ home: w.HOME, url: git(w.HOME, ['remote', 'get-url', 'origin']).trim() });
  const marks = tmp('fb-a11r-marks-');
  const hooks = tmp('fb-a11r-hooks-');
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction']) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch "${marks}/mark-${h}"\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const mon = join(hooks, 'mon.sh');
  writeFileSync(mon, `#!/bin/sh\ntouch "${marks}/mark-fsmonitor"\n`);
  chmodSync(mon, 0o755);
  git(w.HOME, ['config', 'core.hooksPath', hooks]);
  // core.fsmonitor from the user's global config (floorboss reads that one as git does).
  writeFileSync(join(process.env.HOME, '.gitconfig'), `[core]\n\tfsmonitor = ${mon}\n`);
  // Control: git itself runs both.
  writeFileSync(join(w.HOME, 'config.json'), '{"c":1}');
  spawnSync('git', ['add', '-f', 'config.json'], { cwd: w.HOME });
  spawnSync('git', [...ID, 'commit', '-q', '-m', 'c'], { cwd: w.HOME });
  assert.ok(marksIn(marks).includes('mark-fsmonitor') && marksIn(marks).includes('mark-pre-commit'), marksIn(marks).join());
  for (const f of marksIn(marks)) spawnSync('rm', ['-f', join(marks, f)]);
  assert.equal(sync.repoConfigWhy(w.HOME), null);
  writeFileSync(join(w.HOME, 'config.json'), '{"c":2}');
  const c = sync.checkpoint({ home: w.HOME, message: 'x' });
  try {
    assert.ok(c.ok, JSON.stringify(c));
    assert.deepEqual(marksIn(marks), []);
  } finally {
    spawnSync('rm', ['-f', join(process.env.HOME, '.gitconfig')]);
  }
});

// ---- 4. the command per key
test('4: the refusal gives the exact command for each setting', () => {
  const s = shipped();
  git(s.data, ['config', 'color.ui', 'always']);
  git(s.data, ['config', 'Url.https://x.example/.insteadOf', 'https://github.com/']);
  const why = String(sync.repoConfigWhy(s.data));
  assert.match(why, /git config --unset color\.ui/, why);
  assert.match(why, /git config --unset url\.https:\/\/x\.example\/\.insteadof/, why);
});
