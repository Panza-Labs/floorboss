// readChecked walks to a file by standing in each folder on the way (process.chdir), so the working folder must always
// be put back exactly: after a read, after any failure or refusal at any point of the walk, in a guard run, and code
// that reads a relative path or starts a child in "." right after a read finds the folder it was in. A working folder
// floorboss can't enter again (removed, or not open to it) is refused with a clear message, the process left where it
// was; one removed during a read stops every later read (and no longer counts as a place lists come from).
// (No readChecked runs inside another: the walk calls only the file system, and home() is read before it moves.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChecked } from '../lib/paths.mjs';
import { ROOT } from './fixtures/harness.mjs';

function place() {
  const base = mkdtempSync(join(tmpdir(), 'fb-cwd-'));
  const H = join(base, 'home');
  process.env.FLOORBOSS_HOME = H;
  mkdirSync(join(H, 'events', 'e', 'derived'), { recursive: true });
  writeFileSync(join(H, 'events', 'e', 'derived', 'x.json'), 'BENIGN');
  return { base, H };
}
// Runs fn standing in a folder of its own, and puts the test's folder back after.
function standingIn(dir, fn) {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

test('a failure at any point of the walk, and every refusal, puts the working folder back', () => {
  const P = place();
  // Through a link outside the data folder too, so the walk reads a link on the way.
  symlinkSync(P.H, join(P.base, 'alias'));
  const files = [join(P.H, 'events', 'e', 'derived', 'x.json'), join(P.base, 'alias', 'events', 'e', 'derived', 'x.json')];
  const here = mkdtempSync(join(tmpdir(), 'fb-cwd-here-'));
  standingIn(here, () => {
    const start = process.cwd();
    for (const fn of ['lstatSync', 'readlinkSync', 'openSync', 'fstatSync']) {
      for (const f of files) {
        // The k-th call of fn by a name in the folder the walk stands in (no leading /) fails: every k until the read
        // gets through with none failing.
        for (let k = 1; k < 200; k++) {
          const orig = fs[fn];
          let n = 0;
          let failed = false;
          fs[fn] = function (p, ...rest) {
            if ((typeof p === 'string' && !p.startsWith('/')) || typeof p === 'number') {
              if (++n === k) {
                failed = true;
                throw Object.assign(new Error(`(test) ${fn} failed`), { code: 'EIO' });
              }
            }
            return orig.call(this, p, ...rest);
          };
          syncBuiltinESMExports();
          try {
            readChecked(f);
          } catch {
            /* refused or failed: the folder is what is checked */
          } finally {
            fs[fn] = orig;
            syncBuiltinESMExports();
          }
          assert.equal(process.cwd(), start, `${fn} call ${k} failing (${f})`);
          if (!failed) break;
        }
      }
    }
    // Refusals: a link inside the data folder, a second name, a key place.
    mkdirSync(join(P.base, 'outside', '.ssh'), { recursive: true });
    writeFileSync(join(P.base, 'outside', '.ssh', 'id'), 'KEY');
    symlinkSync(join(P.base, 'outside', '.ssh'), join(P.H, 'events', 'e', 'keys'));
    linkSync(join(P.H, 'events', 'e', 'derived', 'x.json'), join(P.H, 'events', 'e', 'derived', 'twin.json'));
    for (const f of [join(P.H, 'events', 'e', 'keys', 'id'), join(P.H, 'events', 'e', 'derived', 'twin.json'), join(P.base, 'outside', '.ssh', 'id'), join(P.H, 'none.json')]) {
      assert.throws(() => readChecked(f), undefined, f);
      assert.equal(process.cwd(), start, f);
    }
  });
});

test('right after a read, a relative path and a child started in "." are in the folder the code was in', () => {
  const P = place();
  const here = mkdtempSync(join(tmpdir(), 'fb-cwd-here-'));
  writeFileSync(join(here, 'rel.txt'), 'here');
  standingIn(here, () => {
    const start = process.cwd();
    assert.equal(readChecked(join(P.H, 'events', 'e', 'derived', 'x.json')), 'BENIGN');
    assert.equal(readFileSync('rel.txt', 'utf8'), 'here');
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: '.', encoding: 'utf8' });
    assert.equal(r.stdout, start);
  });
});

test('a guard run that reads a file through readChecked ends in the folder it started in', () => {
  const P = place();
  mkdirSync(join(P.H, 'work'), { recursive: true });
  const recipe = join(P.H, 'work', 'r.json');
  writeFileSync(recipe, JSON.stringify({ server: 'gcal', tool: 'freebusy_query' }));
  const pre = join(P.base, 'pre.mjs');
  // Counts the folder changes in the guard's process and says, as it exits, whether it is where it started.
  writeFileSync(
    pre,
    "const start = process.cwd(); let n = 0; const orig = process.chdir; process.chdir = function (d) { n++; return orig.call(process, d); };\n" +
      "process.on('exit', () => process.stderr.write(`\\nCWDCHECK ${JSON.stringify({ n, same: process.cwd() === start })}\\n`));\n"
  );
  const here = mkdtempSync(join(tmpdir(), 'fb-cwd-here-'));
  const input = { tool_name: 'Bash', tool_input: { command: `node ${ROOT}/skills/connectors/scripts/cli.mjs save-recipe --task calendar.busy --recipe-file ${recipe}` } };
  const r = spawnSync(process.execPath, ['--import', pre, join(ROOT, 'hooks', 'guard.mjs')], {
    input: JSON.stringify(input),
    cwd: here,
    env: { ...process.env, FLOORBOSS_HOME: P.H, CLAUDE_PLUGIN_ROOT: ROOT, FLOORBOSS_TEST: '1' },
    encoding: 'utf8'
  });
  const m = /CWDCHECK (\{.*\})/.exec(r.stderr);
  assert.ok(m, r.stderr.slice(-400));
  const c = JSON.parse(m[1]);
  assert.ok(c.n > 0, 'the guard read the recipe through the walk');
  assert.equal(c.same, true);
});

// A child of its own: the working folder is removed or closed to it, which the test process itself must not be.
const child = (code, env = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const PATHS = JSON.stringify(join(ROOT, 'lib', 'paths.mjs'));

test('a working folder removed before the read: refused with a clear message, and the process stays where it was', () => {
  const P = place();
  const out = child(
    `import { mkdtempSync, rmdirSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';
     const { readChecked } = await import(${PATHS});
     import { lstatSync } from 'node:fs';
     const d = mkdtempSync(join(tmpdir(), 'fb-gone-')); process.chdir(d);
     // Its name already known to the process (as after any process.cwd()), then removed.
     process.cwd(); const ino = lstatSync('.').ino; rmdirSync(d);
     let why = null; try { readChecked(process.env.F); } catch (e) { why = e.message; }
     // Still in the removed folder, not moved anywhere (by the folder itself: on macOS process.cwd() in a removed
     // folder takes the better part of a minute).
     const still = lstatSync('.').ino === ino ? 'there' : 'moved';
     process.stdout.write(JSON.stringify({ why, still }));`,
    { FLOORBOSS_HOME: P.H, F: join(P.H, 'events', 'e', 'derived', 'x.json') }
  );
  assert.match(out.why || '', /can't go back to the folder this command runs in \(removed, or not open to you\)\. Run it from a folder that exists and is yours\./);
  assert.equal(out.still, 'there', 'still in the removed folder, not moved anywhere');
});

test('a working folder not open to floorboss: refused with a clear message, and the process stays where it was', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root enters any folder');
  const P = place();
  const d = mkdtempSync(join(tmpdir(), 'fb-closed-'));
  try {
    const out = child(
      `import { chmodSync } from 'node:fs';
       const { readChecked } = await import(${PATHS});
       process.chdir(process.env.D); chmodSync(process.env.D, 0o000);
       let why = null; try { readChecked(process.env.F); } catch (e) { why = e.message; }
       let at = null; try { at = process.cwd(); } catch (e) { at = e.code; }
       chmodSync(process.env.D, 0o700);
       process.stdout.write(JSON.stringify({ why, at }));`,
      { FLOORBOSS_HOME: P.H, F: join(P.H, 'events', 'e', 'derived', 'x.json'), D: d }
    );
    assert.match(out.why || '', /can't go back to the folder this command runs in/);
    assert.equal(fs.realpathSync(out.at === 'EACCES' ? d : out.at), fs.realpathSync(d), 'still in that folder');
  } finally {
    fs.chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

test('a working folder removed during a read: that read and every later one refused', () => {
  const P = place();
  const out = child(
    `import fs, { mkdtempSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
     import { join } from 'node:path'; import { tmpdir } from 'node:os';
     const { readChecked } = await import(${PATHS});
     const d = mkdtempSync(join(tmpdir(), 'fb-gone-')); process.chdir(d);
     // The working folder is removed as the walk looks at its first name.
     const orig = fs.lstatSync; let done = false;
     fs.lstatSync = function (p, ...r) { if (!done && typeof p === 'string' && p !== '.' && !p.startsWith('/')) { done = true; fs.rmSync(d, { recursive: true }); } return orig.call(this, p, ...r); };
     syncBuiltinESMExports();
     let why = null; try { readChecked(process.env.F); } catch (e) { why = e.message; }
     fs.lstatSync = orig; syncBuiltinESMExports();
     let later = null; try { readChecked(process.env.F); } catch (e) { later = e.message; }
     process.stdout.write(JSON.stringify({ why, later }));`,
    { FLOORBOSS_HOME: P.H, F: join(P.H, 'events', 'e', 'derived', 'x.json') }
  );
  assert.match(out.why || '', /the folder this command runs in was removed while it read a file\. Run the command again from a folder that exists\./);
  assert.match(out.later || '', /was removed while it read a file/);
});
