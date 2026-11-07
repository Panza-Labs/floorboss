// The guard hook checks every call however its file is reached: by its real path, through a symlink (a plugin
// cache entry linked to its source) or through a path with a space. It once compared import.meta.url with
// argv[1] as strings, so through a link or an encoded path it exited 0 and checked nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './fixtures/harness.mjs';

const T = mkdtempSync(join(tmpdir(), 'fb-guard-path-'));
const HOME = join(T, 'home');
mkdirSync(HOME, { recursive: true });
mkdirSync(join(T, 'with space'), { recursive: true });
symlinkSync(ROOT, join(T, 'link'));
symlinkSync(ROOT, join(T, 'with space', 'fb'));
const env = { ...process.env, HOME, FLOORBOSS_HOME: join(HOME, '.floorboss'), FLOORBOSS_TEST: '1' };
const run = (root, hook, input, args = []) => spawnSync('node', [join(root, 'hooks', hook), ...args], { input, env, encoding: 'utf8' });
const keyRead = JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(HOME, '.ssh', 'id_rsa') } });

for (const [how, root] of [['its real path', ROOT], ['a symlink', join(T, 'link')], ['a path with a space', join(T, 'with space', 'fb')]]) {
  test(`the guard blocks a key read when reached through ${how}`, () => {
    const r = run(root, 'guard.mjs', keyRead);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /floorboss blocked this call/);
  });
  test(`the guard blocks a call it can't read when reached through ${how}`, () => {
    assert.equal(run(root, 'guard.mjs', 'not json {').status, 2);
    assert.equal(run(root, 'guard.mjs', 'not json {', ['post']).status, 0, 'after a call has run, nothing is blocked');
  });
}
