// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Windows-style paths (backslashes, a drive root) reach the path classifiers as they would on Windows, and the
// classifiers still refuse key, credential and config places. On macOS and Linux these are no-ops or stricter:
// the POSIX cases below must hold exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { secretPlace, sensitiveKind, followed } from '../lib/paths.mjs';
import { listFileProblem } from '../lib/security.mjs';

test('secret places are found in backslash paths', () => {
  assert.equal(secretPlace('D:\\Profiles\\o\\.ssh\\id_rsa'), true);
  assert.equal(secretPlace('D:\\Profiles\\o\\.aws\\credentials'), true);
  assert.equal(secretPlace('D:\\Profiles\\o\\project\\.env'), true);
  assert.equal(secretPlace('D:\\Profiles\\o\\project\\.env.d\\db'), true);
  // and in POSIX paths, as before
  assert.equal(secretPlace('/srv/o/.ssh/id_rsa'), true);
  assert.equal(secretPlace('/srv/o/project/.env'), true);
  assert.equal(secretPlace('/srv/o/Downloads/attendees.csv'), false);
  assert.equal(secretPlace('D:\\Profiles\\o\\Downloads\\attendees.csv'), false);
});

test('config places are found in backslash paths', () => {
  const base = realpathSync(tmpdir());
  assert.equal(sensitiveKind(join(base, 'x\\.claude\\settings.json')), 'config');
  assert.equal(sensitiveKind(join(base, 'x', '.claude', 'settings.json')), 'config');
  assert.equal(sensitiveKind(join(base, 'x', 'list.csv')), null);
});

test('list files under .git or node_modules are refused with either slash', () => {
  assert.match(listFileProblem('C:\\work\\.git\\list.csv', 10) || '', /\.git or node_modules/);
  assert.match(listFileProblem('C:\\work\\node_modules\\x\\list.csv', 10) || '', /\.git or node_modules/);
  assert.match(listFileProblem('/work/.git/list.csv', 10) || '', /\.git or node_modules/);
});

test('followed: links are still walked from the root on macOS and Linux', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fb-winpaths-')));
  try {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const r = followed(join(dir, 'link', 'out.txt'));
    assert.equal(r.to, join(dir, 'real', 'out.txt'));
    assert.deepEqual(r.links, [join(dir, 'link')]);
    const n = followed(join(dir, 'nothing', 'here.txt'));
    assert.equal(n.to, join(dir, 'nothing', 'here.txt'));
    assert.deepEqual(n.links, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
