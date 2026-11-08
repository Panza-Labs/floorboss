#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
//
// `npm run self-check`: checks, on your own copy, the claims SECURITY.md makes about what floorboss is and what
// it can reach. It reads the repository and runs the security tests in a throwaway home; it changes nothing,
// installs nothing and makes no network call. Each line says what was checked and whether it held.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
let failed = 0;
const say = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`);
};
const files = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return ['node_modules', '.git', 'test'].includes(d.name) ? [] : files(p);
    return [p];
  });
// This script names the patterns it looks for, so it isn't one of the files it checks.
const code = files('.').filter((f) => /\.(mjs|cjs|js|html)$/.test(f) && f !== 'scripts/self-check.mjs');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// 1. No third-party code.
const pkg = JSON.parse(read('package.json'));
const deps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies'].flatMap((k) => Object.keys(pkg[k] || {}));
say(!deps.length, 'package.json lists no dependencies', deps.join(', '));
const install = Object.keys(pkg.scripts || {}).filter((k) => /^(pre|post)?install$|^prepare$|^prepublish/.test(k));
say(!install.length, 'no install scripts', install.join(', '));
const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'].filter((f) => existsSync(join(ROOT, f)));
say(!locks.length, 'no lockfile (nothing to install)', locks.join(', '));
say(!existsSync(join(ROOT, 'node_modules')), 'no node_modules folder');
const bare = code.flatMap((f) =>
  [...read(f).matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] || m[2])
    .filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
    .map((s) => `${f}: ${s}`)
);
say(!bare.length, "every import is a Node.js built-in (node:) or one of floorboss's own files", bare.join('\n'));

// 2. No network of its own.
const NET = /from\s+['"]node:(http|https|http2|net|tls|dgram|dns)['"]|\bfetch\s*\(|new\s+WebSocket|XMLHttpRequest|import\(\s*['"]https?:/;
const net = code.filter((f) => NET.test(read(f)));
say(!net.length, 'no network modules, fetch or remote imports in any script', net.join('\n'));
// The tests it runs in step 7 too. Tests hold attack text with fetch( in it, and some define their own fetch()
// helper (it asks the guard about a WebFetch call; nothing is fetched). So imports are checked as written, and
// calls only outside strings, with fetch( skipped in a file that defines its own.
const testCode = (function walkTests(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walkTests(join(dir, d.name)) : [join(dir, d.name)]));
})('test').filter((f) => /\.(mjs|cjs|js)$/.test(f));
const NET_IMPORT = /from\s+['"]node:(http|https|http2|net|tls|dgram|dns)['"]|import\(\s*['"](https?:|node:(http|https|http2|net|tls|dgram|dns)['"])|require\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/;
const strip = (t) => t.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
const testNet = testCode.filter((f) => {
  const t = read(f);
  const calls = strip(t);
  const fetchCall = !/(?:const|let|function)\s+fetch\b/.test(t) && /\bfetch\s*\(/.test(calls);
  return NET_IMPORT.test(t) || fetchCall || /new\s+WebSocket|XMLHttpRequest/.test(calls);
});
say(!testNet.length, 'no network modules, fetch or remote imports in the tests', testNet.join('\n'));

// 3. The only processes it starts: Node.js running floorboss's own scripts, and your system's opener for the
// outbox page.
const spawns = code.flatMap((f) =>
  read(f)
    .split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(l) && !/^\s*\/\//.test(l))
    .map(([l, n]) => `${f}:${n}: ${l.trim().slice(0, 140)}`)
);
const unexpected = spawns.filter((s) => !/process\.execPath|spawn\(cmd, \[paths\.outbox\]/.test(s));
say(!unexpected.length, 'processes started are Node.js (floorboss scripts) or the outbox opener', (unexpected.length ? unexpected : spawns).join('\n'));

// 4. What runs on its own: the hooks.
const hooks = JSON.parse(read('hooks/hooks.json'));
const cmds = [];
const walk = (v) =>
  Array.isArray(v)
    ? v.forEach(walk)
    : v && typeof v === 'object'
      ? Object.entries(v).forEach(([k, x]) => (k === 'command' ? cmds.push(String(x)) : walk(x)))
      : null;
walk(hooks.hooks);
say(
  cmds.length > 0 && cmds.every((c) => /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/(guard|remind)\.mjs"( post| end| [a-z-]+)?( \|\| exit 2)?$/.test(c)),
  'hooks run only hooks/guard.mjs and hooks/remind.mjs',
  cmds.join('\n')
);

// 5. CI: actions pinned to a commit, no write access to the code.
const wf = existsSync(join(ROOT, '.github/workflows')) ? readdirSync(join(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`) : [];
const loose = wf.flatMap((f) =>
  [...read(f).matchAll(/uses:\s*(\S+)/g)]
    .map((m) => m[1])
    .filter((u) => !/@[0-9a-f]{40}$/.test(u))
    .map((u) => `${f}: ${u}`)
);
say(!loose.length, 'every GitHub Action is pinned to a full commit', loose.join('\n'));
const writes = wf.filter((f) => /contents:\s*write|write-all/.test(read(f)));
say(!writes.length, 'no workflow can write to the code', writes.join('\n'));

// 6. Data folder permissions in the code: private files and folders. This reads lib/paths.mjs, not ~/.floorboss.
const perms = read('lib/paths.mjs');
say(/0o700/.test(perms) && /0o600/.test(perms), "floorboss's code creates the data folder private (0700 folders, 0600 files); this reads the code, not your folder");

// 7. The security tests, in a throwaway home.
const tests = readdirSync(join(ROOT, 'test'))
  .filter((f) => /^(security-|workflows|fail-closed|prompt|injection)/.test(f) && f.endsWith('.test.mjs'))
  .map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', '--import', './test/fixtures/isolated-home.mjs', ...tests], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, FLOORBOSS_TEST: '1' }
});
const count = (k) => Number((new RegExp(`ℹ ${k} (\\d+)`).exec(r.stdout) || [])[1] || 0);
say(
  r.status === 0 && count('fail') === 0,
  `security tests: ${count('pass')} passed, ${count('fail')} failed (${tests.length} files)`,
  r.status === 0
    ? ''
    : r.stdout
        .split('\n')
        .filter((l) => /^✖/.test(l))
        .join('\n')
);

console.log(failed ? `\n${failed} check(s) failed.` : '\nEvery check held.');
process.exit(failed ? 1 : 0);
