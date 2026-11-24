import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readChecked } from '../lib/paths.mjs';
const fds = () => readdirSync('/dev/fd').length;
test('a checked read whose folder restore fails closes the file it opened (audit 0.1.7 #5)', () => {
  const d = join(process.env.HOME, 'scan-home', 'p'); mkdirSync(d, { recursive: true });
  const f = join(d, 'list.csv'); writeFileSync(f, 'a,b\n');
  assert.equal(readChecked(f), 'a,b\n'); // control
  const base = fds();
  readChecked(f); assert.equal(fds(), base, 'control read is balanced');
  const saved = process.cwd(); const orig = process.chdir; let n = 0;
  process.chdir = function (to) { if (to === saved && ++n > 1) throw Object.assign(new Error('probe'), { code: 'ENOENT' }); return orig.call(process, to); };
  let err; try { readChecked(f); } catch (e) { err = e; }
  process.chdir = orig;
  assert.match(String(err?.message), /removed while it read a file/);
  assert.equal(fds(), base, 'no file is left open');
});
