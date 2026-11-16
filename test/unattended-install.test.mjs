// Installing and removing the morning brief's launchd job (scripts/unattended.mjs), in a throwaway home with a
// stand-in launchctl: the real launchctl is never started and nothing is written under the real ~/Library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, chmodSync, mkdirSync, statSync, lstatSync, symlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefPlist, checkedPath, BRIEF_LABEL } from '../lib/unattended.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPT = join(ROOT, 'scripts/unattended.mjs');

// A strict reader for the plist's XML: tags balanced, text holding no raw "<" or "&", only the five named
// entities. Returns the top dict as a plain object.
function parsePlist(xml) {
  const head = /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\n/.exec(xml);
  assert.ok(head, 'the plist header');
  const unescape = (t) => {
    assert.doesNotMatch(t.replace(/&(amp|lt|gt|quot|apos);/g, ''), /[&<>]/, `raw markup in text: ${t.slice(0, 60)}`);
    return t.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]);
  };
  const toks = [];
  const re = /<(\/?)([a-z]+)( version="1\.0")?(\/?)>|([^<]+)/g;
  let m,
    at = head[0].length;
  while ((m = re.exec(xml.slice(head[0].length)))) {
    assert.equal(m.index + head[0].length, at, `unreadable XML at ${at}: ${xml.slice(at, at + 40)}`);
    at += m[0].length;
    if (m[5] !== undefined) toks.push({ text: m[5] });
    else toks.push({ close: !!m[1], name: m[2], self: !!m[4] });
  }
  assert.equal(at, xml.length, 'read to the end');
  let i = 0;
  const skip = () => {
    while (toks[i]?.text !== undefined && !toks[i].text.trim()) i++;
  };
  const value = () => {
    skip();
    const t = toks[i++];
    assert.ok(t && !t.close && t.name, 'a value');
    if (t.self) return t.name === 'true' ? true : t.name === 'false' ? false : assert.fail(`<${t.name}/>`);
    if (t.name === 'string' || t.name === 'integer' || t.name === 'key') {
      let text = '';
      if (toks[i].text !== undefined) text = toks[i++].text;
      assert.deepEqual([toks[i].close, toks[i].name], [true, t.name]);
      i++;
      return t.name === 'integer' ? Number(text) : unescape(text);
    }
    if (t.name === 'array' || t.name === 'plist') {
      const out = [];
      for (skip(); !(toks[i].close && toks[i].name === t.name); skip()) out.push(value());
      i++;
      return t.name === 'plist' ? out[0] : out;
    }
    if (t.name === 'dict') {
      const out = {};
      for (skip(); !(toks[i].close && toks[i].name === 'dict'); skip()) {
        const k = value();
        out[k] = value();
      }
      i++;
      return out;
    }
    assert.fail(`unexpected <${t.name}>`);
  };
  const top = value();
  skip();
  assert.equal(i, toks.length, 'nothing after </plist>');
  return top;
}

function world({ floorbossHome = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fb-inst-'));
  const HOME = join(base, 'home');
  mkdirSync(HOME);
  const calls = join(base, 'launchctl.log');
  const fake = join(base, 'launchctl');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${calls}'\nif [ -f '${base}/fail' ] && [ "$1" = bootstrap ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi\nexit 0\n`);
  chmodSync(fake, 0o755);
  const fbHome = floorbossHome === null ? join(HOME, '.floorboss') : floorbossHome;
  // PATH holds one "node", a link to the Node running the tests: the name a user's shell would run.
  const bin = join(base, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  // FLOORBOSS_TTY stands in for a real terminal on both ends, which a test's pipes are not (it does nothing
  // without FLOORBOSS_TEST=1). A test of the no-terminal refusal takes it away.
  const env = { ...process.env, PATH: bin, HOME, FLOORBOSS_HOME: fbHome, FLOORBOSS_TEST: '1', FLOORBOSS_PLATFORM: 'darwin', FLOORBOSS_LAUNCHCTL: fake, FLOORBOSS_TTY: '1' };
  delete env.CLAUDECODE;
  const run = (args, extra = {}, input = '') => {
    const e = { ...env, ...extra };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    // Never without the test switch: without it the script would reach for the real launchctl.
    assert.equal(e.FLOORBOSS_TEST, '1');
    return spawnSync(process.execPath, [SCRIPT, ...args], { env: e, encoding: 'utf8', input });
  };
  return {
    base,
    node: join(bin, 'node'),
    HOME,
    fbHome,
    plist: join(HOME, 'Library', 'LaunchAgents', `${BRIEF_LABEL}.plist`),
    run,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
  };
}
const uid = process.getuid();

test('install-brief --yes: writes the launchd file, loads it with launchctl, says what it did and how to remove it', () => {
  const W = world();
  const r = W.run(['install-brief', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // The warning, before anything is done.
  assert.match(r.stdout, /Every day at 07:00 on this Mac's clock/);
  assert.match(r.stdout, /Nothing is sent\. Nothing leaves this machine\. No Claude session starts and no network is used\./);
  assert.ok(r.stdout.indexOf('Nothing is sent') < r.stdout.indexOf('Installed.'));
  // What was installed, and how to stop and remove it.
  assert.ok(r.stdout.includes(`- File: ${W.plist}`));
  assert.ok(r.stdout.includes(`node "${SCRIPT}" off`));
  assert.ok(r.stdout.includes(`node "${SCRIPT}" uninstall-brief`));
  const xml = readFileSync(W.plist, 'utf8');
  const p = parsePlist(xml);
  assert.deepEqual(Object.keys(p).sort(), ['EnvironmentVariables', 'Label', 'ProcessType', 'ProgramArguments', 'RunAtLoad', 'StartCalendarInterval']);
  assert.equal(p.Label, 'com.floorboss.brief');
  assert.deepEqual(p.ProgramArguments, [W.node, join(ROOT, 'scripts/scheduled.mjs'), 'brief'], 'Node by the full path the shell runs, the launcher by its full path, no shell');
  assert.deepEqual(p.StartCalendarInterval, { Hour: 7, Minute: 0 }, '07:00 every day');
  assert.equal(p.RunAtLoad, false);
  assert.deepEqual(p.EnvironmentVariables, { FLOORBOSS_HOME: W.fbHome }, 'FLOORBOSS_HOME and nothing else: no token, no PATH');
  assert.doesNotMatch(xml, /token|secret|password|api[_-]?key|\/bin\/(ba|z)?sh|KeepAlive|WatchPaths/i);
  assert.equal(statSync(W.plist).mode & 0o777, 0o600);
  assert.deepEqual(W.calls(), [`bootstrap gui/${uid} ${W.plist}`]);
  const info = JSON.parse(readFileSync(join(W.fbHome, 'unattended', 'brief-installed.json'), 'utf8'));
  assert.deepEqual([info.label, info.plist, info.launcher], [BRIEF_LABEL, W.plist, join(ROOT, 'scripts/scheduled.mjs')]);

  // status says so; it starts no launchctl.
  const s = W.run(['status']);
  assert.match(s.stdout, /Morning brief: installed/);
  assert.match(s.stdout, /brief_installed/);
  assert.equal(W.calls().length, 1);

  // Installed again: the old job is unloaded first, then the new file loaded.
  assert.equal(W.run(['install-brief', '--yes']).status, 0);
  assert.deepEqual(W.calls().slice(1), [`bootout gui/${uid}/${BRIEF_LABEL}`, `bootstrap gui/${uid} ${W.plist}`]);

  // uninstall-brief unloads it and removes the file.
  const u = W.run(['uninstall-brief']);
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!existsSync(W.plist));
  assert.ok(!existsSync(join(W.fbHome, 'unattended', 'brief-installed.json')));
  assert.equal(W.calls().pop(), `bootout gui/${uid}/${BRIEF_LABEL}`);
  assert.match(u.stdout, /Removed .*com\.floorboss\.brief\.plist\.\nUnloaded the job/);
  assert.match(W.run(['status']).stdout, /Morning brief: not installed/);
  // Removing what isn't there is fine.
  assert.equal(W.run(['uninstall-brief']).status, 0);
});

test('install-brief: without FLOORBOSS_HOME set, the file still names the data folder (~/.floorboss), and nothing else', () => {
  // Fixed by the install, never left to a variable set later for every job (launchctl setenv): review finding A6.
  const W = world();
  const r = W.run(['install-brief', '--yes'], { FLOORBOSS_HOME: '' });
  assert.equal(r.status, 0, r.stderr);
  const p = parsePlist(readFileSync(W.plist, 'utf8'));
  assert.deepEqual(p.EnvironmentVariables, { FLOORBOSS_HOME: join(W.HOME, '.floorboss') });
  assert.ok(existsSync(join(W.HOME, '.floorboss', 'unattended', 'brief-installed.json')), 'its own note went under the throwaway home');
});

test('install-brief: in a terminal, without --yes, only a typed "yes" installs', () => {
  for (const input of ['', 'no\n', 'y\n', 'yes please\n', 'sure\n']) {
    const W = world();
    const r = W.run(['install-brief'], {}, input);
    assert.equal(r.status, 1, JSON.stringify(input));
    assert.match(r.stdout, /Install it\? Type yes: /);
    assert.match(r.stdout, /Nothing was installed/);
    assert.ok(!existsSync(join(W.HOME, 'Library')), 'no file, no folder');
    assert.deepEqual(W.calls(), [], 'launchctl never started');
  }
  for (const input of ['yes\n', ' YES \n']) {
    const W = world();
    const r = W.run(['install-brief'], {}, input);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(W.plist));
    assert.equal(W.calls().length, 1);
  }
  // An argument that isn't --yes is refused outright.
  const W = world();
  assert.equal(W.run(['install-brief', '--yes', '--force']).status, 2);
  assert.equal(W.run(['install-brief', 'yes']).status, 2);
  assert.ok(!existsSync(join(W.HOME, 'Library')));
});

test('install-brief: on Linux and Windows it says it is macOS only for now and installs nothing', () => {
  for (const FLOORBOSS_PLATFORM of ['linux', 'win32']) {
    const W = world();
    const r = W.run(['install-brief', '--yes'], { FLOORBOSS_PLATFORM });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Running on its own is macOS only for now\. Linux \(systemd timers\) and Windows \(Task Scheduler\) are planned; everything else in floorboss works on all three\.\nNothing was installed\./);
    assert.ok(!existsSync(join(W.HOME, 'Library')));
    assert.ok(!existsSync(W.fbHome), 'nothing written at all');
    assert.deepEqual(W.calls(), []);
    assert.equal(W.run(['uninstall-brief'], { FLOORBOSS_PLATFORM }).status, 0);
    assert.deepEqual(W.calls(), []);
  }
});

test('install-brief, uninstall-brief and on refuse to run from a shell Claude Code started; off and status do not', () => {
  const W = world();
  for (const sub of [['install-brief', '--yes'], ['uninstall-brief'], ['on']]) {
    const r = W.run(sub, { CLAUDECODE: '1' });
    assert.equal(r.status, 1, sub[0]);
    assert.match(r.stdout, /in your own terminal window, not from a Claude Code session/);
  }
  assert.ok(!existsSync(join(W.HOME, 'Library')));
  assert.deepEqual(W.calls(), []);
  assert.equal(W.run(['off'], { CLAUDECODE: '1' }).status, 0);
  assert.ok(existsSync(join(W.fbHome, 'unattended', 'off')));
  assert.equal(W.run(['status'], { CLAUDECODE: '1' }).status, 0);
  assert.equal(W.run(['on'], { CLAUDECODE: '1' }).status, 1);
  assert.ok(existsSync(join(W.fbHome, 'unattended', 'off')), 'still off');
});

test('off writes the off file, on removes it, and both are logged', () => {
  const W = world();
  const off = join(W.fbHome, 'unattended', 'off');
  assert.equal(W.run(['off']).status, 0);
  assert.ok(existsSync(off));
  assert.equal(statSync(off).mode & 0o777, 0o600);
  assert.equal(W.run(['off']).status, 0, 'twice is fine');
  assert.match(W.run(['status']).stdout, /Switched off/);
  assert.equal(W.run(['on']).status, 0);
  assert.ok(!existsSync(off));
  assert.match(W.run(['status']).stdout, /Not switched off/);
  const types = readFileSync(join(W.fbHome, 'unattended', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ['unattended_off', 'unattended_on']);
  assert.equal(W.run(['nonsense']).status, 2);
  assert.equal(W.run(['off', '--yes']).status, 2);
});

test('install-brief: a launchctl that fails leaves nothing installed', () => {
  const W = world();
  writeFileSync(join(W.base, 'fail'), '');
  const r = W.run(['install-brief', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /launchctl couldn't load the job \(Bootstrap failed: 5: Input\/output error\)\. The file was removed again; nothing is installed\./);
  assert.ok(!existsSync(W.plist));
  assert.deepEqual(readdirSync(join(W.HOME, 'Library', 'LaunchAgents')), []);
  assert.ok(!existsSync(join(W.fbHome, 'unattended', 'brief-installed.json')));
});

test('install-brief: a link or a folder at the launchd file\'s name is never written through', () => {
  const W = world();
  mkdirSync(join(W.HOME, 'Library', 'LaunchAgents'), { recursive: true });
  const target = join(W.base, 'elsewhere.txt');
  writeFileSync(target, 'mine');
  symlinkSync(target, W.plist);
  const r = W.run(['install-brief', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't a plain file, so nothing was installed/);
  assert.equal(readFileSync(target, 'utf8'), 'mine');
  assert.deepEqual(W.calls(), []);
});

test('the launchd file: a path with quotes, &, <, $(…) or a tag in it stays one string; a line break is refused', () => {
  const node = '/usr/local/bin/node';
  const hostile = [
    '/srv/x/it\'s "here"/plugin/scripts/scheduled.mjs',
    '/srv/x/a&b/<c>/scripts/scheduled.mjs',
    '/srv/x/$(touch /tmp/pwned)/`id`/scripts/scheduled.mjs',
    '/srv/x/</string><string>--eval</string><string>require("child_process")/scripts/scheduled.mjs',
    '/srv/x/</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><array>/scheduled.mjs',
    '/srv/x/]]><!-- --><![CDATA[/scheduled.mjs',
    '/srv/x/&lt;already&amp;escaped&gt;/scheduled.mjs',
    '/srv/x/ spaces  and\ttabs?/scheduled.mjs'.replace('\t', ' '),
    '/srv/x/\u202egnp.exe/\u00e9\u4e2d/scheduled.mjs'
  ];
  for (const launcher of hostile) {
    for (const floorbossHome of [null, launcher.replace('scheduled.mjs', 'home')]) {
      const p = parsePlist(briefPlist({ node, launcher, floorbossHome }));
      assert.deepEqual(p.ProgramArguments, [node, launcher, 'brief'], launcher);
      assert.equal(p.RunAtLoad, false);
      assert.equal(p.Label, BRIEF_LABEL);
      assert.deepEqual(p.StartCalendarInterval, { Hour: 7, Minute: 0 });
      assert.ok(!('KeepAlive' in p));
      if (floorbossHome) assert.deepEqual(p.EnvironmentVariables, { FLOORBOSS_HOME: floorbossHome });
      else assert.ok(!('EnvironmentVariables' in p));
    }
  }
  const refused = ['/srv/x/a\nb/scheduled.mjs', '/srv/x/a\rb/s.mjs', '/srv/x/a\u0000b/s.mjs', '/srv/x/a\u2028b/s.mjs', '/srv/x/a\u001bb/s.mjs', '/srv/x/a\ud800b/s.mjs', 'relative/scheduled.mjs', '', `/${'a'.repeat(1100)}`, null, 7];
  for (const bad of refused) {
    assert.throws(() => briefPlist({ node, launcher: bad }), /nothing was installed/, JSON.stringify(bad));
    assert.throws(() => briefPlist({ node: bad, launcher: '/x/scheduled.mjs' }), /nothing was installed/);
    if (bad !== null) assert.throws(() => briefPlist({ node, launcher: '/x/scheduled.mjs', floorbossHome: bad }), /nothing was installed/, JSON.stringify(bad));
  }
  assert.equal(checkedPath('/a/b/../c', 'x'), '/a/c');
});

test('install-brief: a hostile FLOORBOSS_HOME goes into the file as one string, or is refused; never as markup or arguments', () => {
  const W0 = world();
  const evil = join(W0.base, `fb "q" & <x> $(touch ${join(W0.base, 'pwned')}) </string><string>-e`);
  const W = world({ floorbossHome: evil });
  const r = W.run(['install-brief', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  const p = parsePlist(readFileSync(W.plist, 'utf8'));
  assert.deepEqual(p.EnvironmentVariables, { FLOORBOSS_HOME: evil });
  assert.equal(p.ProgramArguments.length, 3);
  assert.ok(!existsSync(join(W0.base, 'pwned')), 'nothing in the path was run');
  // launchctl got the file's path as one argument.
  assert.deepEqual(W.calls(), [`bootstrap gui/${uid} ${W.plist}`]);
  const W2 = world({ floorbossHome: join(W0.base, 'line\nbreak') });
  const r2 = W2.run(['install-brief', '--yes']);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /FLOORBOSS_HOME has a line break or a control character in it, so nothing was installed/);
  assert.ok(!existsSync(join(W2.HOME, 'Library')));
  assert.deepEqual(W2.calls(), []);
});

test('install-brief, uninstall-brief and on need a real terminal, with --yes or without; off and status do not', () => {
  const W = world();
  // Installed first (with the terminal stand-in), so there is something to remove and switch.
  assert.equal(W.run(['install-brief', '--yes']).status, 0);
  assert.equal(W.run(['off']).status, 0);
  const before = W.calls().length;
  const NO_TTY = { FLOORBOSS_TTY: undefined };
  for (const args of [['install-brief'], ['install-brief', '--yes'], ['uninstall-brief'], ['on']]) {
    for (const input of ['', 'yes\n']) {
      const r = W.run(args, NO_TTY, input);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stdout, /is done by you, in your own terminal window, not from a script or a pipe \(this command has no terminal\)/, args.join(' '));
      assert.match(r.stdout, /Nothing was changed\./);
    }
  }
  assert.equal(W.calls().length, before, 'launchctl was not started');
  assert.ok(existsSync(W.plist), 'still installed');
  assert.ok(existsSync(join(W.fbHome, 'unattended', 'off')), 'still off');
  // The stand-in's other spellings are not a terminal.
  for (const FLOORBOSS_TTY of ['0', 'true', 'yes', '']) assert.equal(W.run(['on'], { FLOORBOSS_TTY }).status, 1, JSON.stringify(FLOORBOSS_TTY));
  // Turning off, and looking, need none.
  assert.equal(W.run(['off'], NO_TTY).status, 0);
  assert.equal(W.run(['status'], NO_TTY).status, 0);
  // A fresh home: nothing at all is written by a refused install.
  const W2 = world();
  assert.equal(W2.run(['install-brief', '--yes'], NO_TTY).status, 1);
  assert.ok(!existsSync(join(W2.HOME, 'Library')) && !existsSync(W2.fbHome));
  assert.deepEqual(W2.calls(), []);
});

test('a shell Claude Code started is refused even in a terminal, whatever the variable holds', () => {
  for (const CLAUDECODE of ['1', '0', '', 'false']) {
    const W = world();
    for (const args of [['install-brief', '--yes'], ['uninstall-brief'], ['on']]) {
      const r = W.run(args, { CLAUDECODE });
      assert.equal(r.status, 1, `${args[0]} with CLAUDECODE=${JSON.stringify(CLAUDECODE)}`);
      assert.match(r.stdout, /not from a Claude Code session/);
    }
    assert.ok(!existsSync(join(W.HOME, 'Library')));
    assert.deepEqual(W.calls(), []);
  }
});

test('the stand-ins for launchctl, the opener, the platform and the terminal do nothing without FLOORBOSS_TEST=1', async () => {
  // Asked of the functions that choose, never by running the script: without the test switch the script would
  // start the real launchctl.
  const u = await import('../lib/unattended.mjs');
  const standIns = { FLOORBOSS_LAUNCHCTL: '/tmp/stand-in', FLOORBOSS_OPENER: '/tmp/stand-in', FLOORBOSS_PLATFORM: 'darwin', FLOORBOSS_TTY: '1' };
  const pipe = { isTTY: false }, tty = { isTTY: true };
  for (const FLOORBOSS_TEST of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 1]) {
    const env = { ...standIns, ...(FLOORBOSS_TEST === undefined ? {} : { FLOORBOSS_TEST }) };
    assert.equal(u.launchctlFor(env), '/bin/launchctl', JSON.stringify(FLOORBOSS_TEST));
    assert.equal(u.openerFor(env, 'darwin'), '/usr/bin/open');
    assert.equal(u.openerFor(env, 'linux'), '/usr/bin/xdg-open');
    assert.equal(u.platformFor(env, 'linux'), 'linux');
    assert.equal(u.terminalPresent(env, pipe, pipe), false);
    assert.equal(u.terminalPresent(env, tty, pipe), false, 'both ends');
    assert.equal(u.terminalPresent(env, pipe, tty), false);
    assert.equal(u.terminalPresent(env, tty, tty), true);
  }
  // Under the tests the stand-ins are used, and the real programs never: no stand-in named is no program at all.
  const t = { ...standIns, FLOORBOSS_TEST: '1' };
  assert.equal(u.launchctlFor(t), '/tmp/stand-in');
  assert.equal(u.openerFor(t, 'darwin'), '/tmp/stand-in');
  assert.equal(u.platformFor({ FLOORBOSS_TEST: '1', FLOORBOSS_PLATFORM: 'win32' }, 'darwin'), 'win32');
  assert.equal(u.terminalPresent(t, pipe, pipe), true);
  assert.equal(u.launchctlFor({ FLOORBOSS_TEST: '1' }), null);
  assert.equal(u.openerFor({ FLOORBOSS_TEST: '1' }, 'darwin'), null);
  assert.equal(u.terminalPresent({ FLOORBOSS_TEST: '1' }, pipe, pipe), false);
});

test('the Node named in the launchd file is the one the shell runs when that is this same program, else the exact one', async () => {
  const { stableNodePath } = await import('../lib/unattended.mjs');
  const d = mkdtempSync(join(tmpdir(), 'fb-node-'));
  const same = join(d, 'same'), other = join(d, 'other'), empty = join(d, 'empty');
  for (const x of [same, other, empty]) mkdirSync(x);
  symlinkSync(process.execPath, join(same, 'node'));
  writeFileSync(join(other, 'node'), '#!/bin/sh\n');
  chmodSync(join(other, 'node'), 0o755);
  assert.equal(stableNodePath(process.execPath, same), join(same, 'node'), 'a link to this Node, as on PATH');
  assert.equal(stableNodePath(process.execPath, `${empty}:${same}`), join(same, 'node'));
  assert.equal(stableNodePath(process.execPath, `${other}:${same}`), process.execPath, 'the shell would run another program: the exact path');
  assert.equal(stableNodePath(process.execPath, ''), process.execPath);
  assert.equal(stableNodePath(process.execPath, `.:bin:${empty}`), process.execPath, 'a relative PATH entry is never used');
  // In the file: the other program on PATH is not named.
  const W = world();
  const r = W.run(['install-brief', '--yes'], { PATH: other });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parsePlist(readFileSync(W.plist, 'utf8')).ProgramArguments[0], process.execPath);
});

test('status says to reinstall when the Node or the launcher it recorded is gone, and prints logged text clean', () => {
  const W = world();
  assert.equal(W.run(['install-brief', '--yes']).status, 0);
  assert.doesNotMatch(W.run(['status']).stdout, /is gone/);
  const f = join(W.fbHome, 'unattended', 'brief-installed.json');
  const info = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(info.node, W.node);
  writeFileSync(f, JSON.stringify({ ...info, node: join(W.base, 'cellar', 'node', '25.9.0', 'bin', 'node') }));
  assert.match(W.run(['status']).stdout, /The Node\.js it runs is gone \(.*cellar\/node\/25\.9\.0\/bin\/node\): Node\.js moved or was updated\. Run install-brief again from your terminal\./);
  writeFileSync(f, JSON.stringify({ ...info, launcher: `${W.base}/old-plugin/\u202escripts/scheduled.mjs` }));
  const s = W.run(['status']).stdout;
  assert.match(s, /Its launcher is gone \(.*old-plugin\/scripts\/scheduled\.mjs\)/);
  // A log line holding control and invisible characters, and far too much text.
  writeFileSync(join(W.fbHome, 'unattended', 'log.jsonl'), `${JSON.stringify({ at: '2026-11-10T06:00:00.000Z', type: 'brief_failed\u001b[2J\u202e', reason: `x\u202ey\u200bz\u0007 ${'A'.repeat(5000)}` })}\n`);
  const out = W.run(['status']).stdout;
  assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e]/);
  assert.match(out, /2026-11-10 06:00Z {2}brief_failed \[2J {2}\{"reason":"xyz  AAAA/);
  assert.doesNotMatch(out, /u0007|u202e/, 'nor their escapes');
  assert.ok(out.split('\n').every((l) => l.length < 400));
});

test('install-brief: a relative FLOORBOSS_HOME is refused; a failed load over an earlier install leaves no note of one', () => {
  const W = world();
  for (const rel of ['fb-home', './fb-home', '../x']) {
    const r = W.run(['install-brief', '--yes'], { FLOORBOSS_HOME: rel });
    assert.equal(r.status, 1, rel);
    assert.match(r.stderr, /FLOORBOSS_HOME isn't an absolute path, so nothing was installed\./);
  }
  assert.ok(!existsSync(join(W.HOME, 'Library')));
  assert.deepEqual(W.calls(), []);
  assert.equal(W.run(['install-brief', '--yes']).status, 0);
  const note = join(W.fbHome, 'unattended', 'brief-installed.json');
  assert.ok(existsSync(note));
  writeFileSync(join(W.base, 'fail'), '');
  assert.equal(W.run(['install-brief', '--yes']).status, 1);
  assert.ok(!existsSync(W.plist), 'the file is gone');
  assert.ok(!existsSync(note), 'and so is the note that said it was installed');
  assert.match(W.run(['status']).stdout, /Morning brief: not installed/);
});

test('status and off never wait on, or read through, something planted where the log should be', () => {
  const run = (W, args) => {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: W.HOME, FLOORBOSS_HOME: W.fbHome, FLOORBOSS_TEST: '1', FLOORBOSS_PLATFORM: 'darwin' }, encoding: 'utf8', timeout: 8000 });
    return { ...r, ms: Date.now() - t0 };
  };
  // A link at log.jsonl to a file outside the data folder: not followed, and none of that file is shown.
  {
    const W = world();
    mkdirSync(join(W.fbHome, 'unattended'), { recursive: true });
    const outside = join(W.base, 'outside.jsonl');
    writeFileSync(outside, [1, 2, 3].map((n) => JSON.stringify({ at: '2026-11-10T06:00:00.000Z', type: 'note', secret: `OUTSIDE-FILE-LINE-${n} token=abc123` })).join('\n') + '\n');
    symlinkSync(outside, join(W.fbHome, 'unattended', 'log.jsonl'));
    const r = run(W, ['status']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /OUTSIDE-FILE|token=abc123/);
    assert.match(r.stdout, /The log can't be shown: .*log\.jsonl isn't a plain file/);
  }
  // A pipe at log.jsonl: status says so and returns; off switches off and returns.
  for (const sub of ['status', 'off']) {
    const W = world();
    mkdirSync(join(W.fbHome, 'unattended'), { recursive: true });
    execFileSync('mkfifo', [join(W.fbHome, 'unattended', 'log.jsonl')]);
    const r = run(W, [sub]);
    assert.equal(r.signal, null, `${sub} did not hang`);
    assert.equal(r.status, 0, `${sub}: ${r.stderr}`);
    assert.ok(r.ms < 4000, `${sub} took ${r.ms} ms`);
    if (sub === 'status') assert.match(r.stdout, /The log can't be shown: .*isn't a plain file/);
    else {
      assert.ok(existsSync(join(W.fbHome, 'unattended', 'off')), 'off is off');
      assert.match(r.stdout, /It couldn't be noted in the log: .*isn't a plain file/);
      assert.match(r.stdout, /Unattended runs are off/);
    }
    assert.ok(lstatSync(join(W.fbHome, 'unattended', 'log.jsonl')).isFIFO(), 'the pipe is left as it was');
  }
  // A folder where the log should be, and a link where the unattended folder should be.
  {
    const W = world();
    mkdirSync(join(W.fbHome, 'unattended', 'log.jsonl'), { recursive: true });
    assert.match(run(W, ['status']).stdout, /The log can't be shown/);
    const W2 = world();
    mkdirSync(W2.fbHome, { recursive: true });
    const elsewhere = join(W2.base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'log.jsonl'), `${JSON.stringify({ at: '2026-11-10T06:00:00.000Z', type: 'ELSEWHERE' })}\n`);
    symlinkSync(elsewhere, join(W2.fbHome, 'unattended'));
    const r = run(W2, ['status']);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /ELSEWHERE/);
  }
  // A very long log: only its end is read, and the last runs are shown.
  {
    const W = world();
    mkdirSync(join(W.fbHome, 'unattended'), { recursive: true });
    const line = (n) => JSON.stringify({ at: '2026-11-10T06:00:00.000Z', type: 'brief_skipped', reason: `run ${n} ${'x'.repeat(150)}` });
    writeFileSync(join(W.fbHome, 'unattended', 'log.jsonl'), Array.from({ length: 60000 }, (_, n) => line(n)).join('\n') + '\n');
    const r = run(W, ['status']);
    assert.equal(r.status, 0);
    assert.ok(r.ms < 4000);
    assert.match(r.stdout, /run 59999 /);
    assert.equal((r.stdout.match(/brief_skipped/g) || []).length, 5);
  }
});
