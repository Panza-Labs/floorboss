// No file floorboss ships (code, commands, skills, agents, docs) holds a character a reader can't see or that
// reorders text: an instruction hidden that way would read as nothing in an editor and as words to a model.
// Sanitisers write such characters as \u escapes; tests may hold them as inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './fixtures/harness.mjs';

const HIDDEN = /[\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;

test('no hidden or text-reordering characters in anything floorboss ships', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('test/') && /\.(mjs|js|md|json|sh|yml|txt|html)$/.test(f));
  assert.ok(files.length > 50, 'the shipped files were listed');
  const found = files.flatMap((f) => readFileSync(join(ROOT, f), 'utf8').split('\n').map((l, i) => (HIDDEN.test(l) ? `${f}:${i + 1}` : null)).filter(Boolean));
  assert.deepEqual(found, []);
});
