import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readChecked } from '../lib/paths.mjs';
const fs = createRequire(import.meta.url)('node:fs');
const fds = () => readdirSync('/dev/fd').length;
test('a checked read whose stat fails closes the file it opened (audit 0.1.7 #5)', () => {
  const d = join(process.env.HOME, 'scan-home', 'p'); mkdirSync(d, { recursive: true });
  const f = join(d, 'list.csv'); writeFileSync(f, 'a,b\n');
  readChecked(f); const base = fds();
  const orig = fs.fstatSync; let n = 0;
  fs.fstatSync = function (...a) { if (++n === 2) throw Object.assign(new Error('probe EIO'), { code: 'EIO' }); return orig.apply(this, a); };
  syncBuiltinESMExports();
  let err; try { readChecked(f); } catch (e) { err = e; }
  fs.fstatSync = orig; syncBuiltinESMExports();
  assert.equal(err?.message, 'probe EIO');
  assert.equal(fds(), base, 'no file is left open');
  assert.equal(readChecked(f), 'a,b\n', 'later reads still work');
});
