// A read that can't put the process back in the folder it started in, the same folder by its identity, never leaves it
// where the walk stopped (inside the data folder) or in another folder put at the old name: the process goes to an
// empty folder of floorboss's own, which nobody can put anything in (mode 500), and every later read is refused. Where the process
// ends is checked by the folder itself (dev and inode), not only by what later reads say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './fixtures/harness.mjs';

const PATHS = JSON.stringify(join(ROOT, 'lib', 'paths.mjs'));
// One child per case: the working folder is renamed away (a), or renamed and another folder made at its name (b), as
// the walk looks at derived/.
function run(change) {
  const code = `
    import fs, { mkdirSync, writeFileSync, mkdtempSync, renameSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join, resolve } from 'node:path';
    import { tmpdir } from 'node:os';
    const base = mkdtempSync(join(tmpdir(), 'fb-restore-'));
    const H = join(base, 'home'); process.env.FLOORBOSS_HOME = H;
    const D = join(H, 'events', 'e', 'derived'); mkdirSync(D, { recursive: true });
    const f = join(D, 'x.json'); writeFileSync(f, '{"ok":1}'); writeFileSync(join(D, 'marker.txt'), 'DERIVED');
    const C = join(base, 'cwd'); mkdirSync(C); writeFileSync(join(C, 'marker.txt'), 'CWD'); process.chdir(C);
    const { readChecked, allowedPath } = await import(${PATHS});
    const id = (p) => { const s = lstatSync(p); return s.dev + ':' + s.ino; };
    const C0 = id(C), D0 = id(D), ROOT0 = id('/');
    const orig = fs.lstatSync; let done = false;
    fs.lstatSync = function (p, ...r) { if (!done && p === 'derived') { done = true; ${change} } return orig.call(this, p, ...r); };
    syncBuiltinESMExports();
    let why = null; try { readChecked(f); why = 'read'; } catch (e) { why = e.message; }
    fs.lstatSync = orig; syncBuiltinESMExports();
    const here = id('.');
    let marker; try { marker = readFileSync('marker.txt', 'utf8'); } catch (e) { marker = e.code; }
    let listing; try { listing = readdirSync('.'); } catch (e) { listing = e.code; }
    let made; try { writeFileSync('planted.txt', 'x'); made = 'written'; } catch (e) { made = e.code; }
    let later; try { readChecked(f); later = 'read'; } catch (e) { later = e.message; }
    let rel; try { rel = allowedPath('rec.json'); } catch (e) { rel = 'refused'; }
    process.stdout.write(JSON.stringify({ why, here, C0, D0, ROOT0, newAtName: (() => { try { return id(C); } catch { return null; } })(),
      marker, listing, made, later, relInData: typeof rel === 'string' && resolve(rel).startsWith(H) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const check = (o) => {
  assert.match(o.why, /the folder this command runs in was removed while it read a file/, 'that read is refused');
  assert.match(o.later, /was removed while it read a file/, 'and every later one');
  assert.notEqual(o.here, o.D0, 'not left where the walk stopped');
  assert.notEqual(o.here, o.ROOT0, 'not the top folder');
  assert.notEqual(o.here, o.C0, 'not the old folder under its new name');
  if (o.newAtName) assert.notEqual(o.here, o.newAtName, 'not the folder now at the old name');
  assert.ok(!['DERIVED', 'CWD', 'IMPOSTOR'].includes(o.marker), `a relative name reads nothing: ${o.marker}`);
  assert.notEqual(o.made, 'written', 'nothing can be put in the folder it is in');
  assert.deepEqual(o.listing, [], 'an empty folder');
  assert.equal(o.relInData, false, 'a relative path is not one in the data folder');
};

test('the working folder renamed away during a read: the process goes to an empty folder of its own, and reads stop', () => {
  check(run(`renameSync(C, C + '.moved');`));
});

test('the working folder renamed and another made at its name during a read: never put back into the other one', () => {
  check(run(`renameSync(C, C + '.moved'); mkdirSync(C); writeFileSync(join(C, 'marker.txt'), 'IMPOSTOR');`));
});
