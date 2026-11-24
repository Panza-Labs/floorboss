// readChecked finds where the file it opened really is by walking the folders on its way, one at a time: a path into
// the data folder spelled another way (another case on a case-insensitive disk, or through a link outside it) gets the
// same checks as one spelled as floorboss spells it, a folder flipped to a link to ~/.ssh between the looks of one read
// never lets the key through, and writes landing in the data folder meanwhile never fail a read. A file with a second
// name (a hard link) is never read, wherever it is: a list in the working folder too. Each refusal says what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, unlinkSync, linkSync, existsSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChecked, allowedPath } from '../lib/paths.mjs';
import { ROOT } from './fixtures/harness.mjs';

function place() {
  const base = mkdtempSync(join(tmpdir(), 'fb-walk-'));
  const H = join(base, 'home');
  process.env.FLOORBOSS_HOME = H;
  const D = join(H, 'events', 'e', 'derived');
  const ssh = join(base, 'outside', '.ssh');
  mkdirSync(D, { recursive: true });
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(D, 'x.json'), 'BENIGN');
  writeFileSync(join(ssh, 'x.json'), 'SECRET');
  return { base, H, D, ssh };
}

// One read of `target` with the folder D flipped at exactly these moments: a link to .ssh at the open, a plain folder
// at the real path, a link at the inode check, a plain folder after it. Returns what the read gave and how many flips
// landed.
function flippedRead(P, target) {
  const toLink = () => {
    renameSync(P.D, `${P.D}.real`);
    symlinkSync(P.ssh, P.D);
  };
  const toPlain = () => {
    unlinkSync(P.D);
    renameSync(`${P.D}.real`, P.D);
  };
  const real = { openSync: fs.openSync, lstatSync: fs.lstatSync, native: fs.realpathSync.native };
  let stage = 0;
  fs.openSync = (p, ...rest) => {
    if (stage === 0 && p === target) {
      stage = 1;
      toLink();
    }
    return real.openSync(p, ...rest);
  };
  fs.realpathSync.native = (p, ...rest) => {
    if (stage === 1 && p === target) {
      stage = 2;
      toPlain();
    }
    return real.native(p, ...rest);
  };
  fs.lstatSync = (p, ...rest) => {
    if (stage === 2 && String(p).toLowerCase().endsWith(join('derived', 'x.json'))) {
      stage = 3;
      toLink();
      try {
        return real.lstatSync(p, ...rest);
      } finally {
        toPlain();
      }
    }
    return real.lstatSync(p, ...rest);
  };
  syncBuiltinESMExports();
  let got;
  try {
    got = readChecked(target);
  } catch (e) {
    got = `refused: ${e.message}`;
  } finally {
    fs.openSync = real.openSync;
    fs.lstatSync = real.lstatSync;
    fs.realpathSync.native = real.native;
    syncBuiltinESMExports();
  }
  return { got, stage };
}

test('a path into the data folder spelled in another case: a flipped folder never lets the key through', (t) => {
  const P = place();
  const target = join(P.D, 'x.json').replace(`${'/'}home${'/'}`, '/HOME/');
  if (!existsSync(target)) return t.skip('this disk tells case apart');
  const { got, stage } = flippedRead(P, target);
  assert.equal(stage, 3, 'every flip landed');
  assert.notEqual(got, 'SECRET');
});

test('a path into the data folder through a link outside it: a flipped folder never lets the key through', () => {
  const P = place();
  symlinkSync(P.H, join(P.base, 'alias'));
  const target = join(P.base, 'alias', 'events', 'e', 'derived', 'x.json');
  const { got, stage } = flippedRead(P, target);
  assert.equal(stage, 3, 'every flip landed');
  assert.notEqual(got, 'SECRET');
});

test('a link inside the data folder, reached by another spelling: refused, and the refusal says what to do', (t) => {
  const P = place();
  rmSync(P.D, { recursive: true });
  symlinkSync(P.ssh, P.D);
  symlinkSync(P.H, join(P.base, 'alias'));
  const spellings = [join(P.base, 'alias', 'events', 'e', 'derived', 'x.json')];
  const upper = join(P.D, 'x.json').replace('/home/', '/HOME/');
  if (existsSync(upper)) spellings.push(upper);
  else t.diagnostic('this disk tells case apart');
  for (const s of spellings) assert.throws(() => readChecked(s), /link[\s\S]*Put the folder itself there in place of the link\./, s);
  assert.throws(() => readChecked(join(P.D, 'x.json')), /Put the folder itself there in place of the link\./);
});

test('writes landing in the data folder, events/ and the event folder while a file is read: no read fails, none waits', async () => {
  const P = place();
  const f = join(P.D, 'x.json');
  // Three writers, as floorboss writes (a new file renamed over the old), one in each folder on the way.
  const code = `const fs=require('node:fs');const [d,i]=process.argv.slice(1);for(;;){fs.writeFileSync(d+'/f.tmp'+i,'x');fs.renameSync(d+'/f.tmp'+i,d+'/w'+i+'.json');}`;
  const dirs = [P.H, join(P.H, 'events'), join(P.H, 'events', 'e')];
  const ps = dirs.map((d, i) => spawn(process.execPath, ['-e', code, d, String(i)], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 300));
  let reads = 0;
  let max = 0;
  const failed = [];
  try {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      const t0 = performance.now();
      try {
        assert.equal(readChecked(f), 'BENIGN');
      } catch (e) {
        failed.push(e.message);
      }
      reads++;
      max = Math.max(max, performance.now() - t0);
    }
  } finally {
    await Promise.all(ps.map((p) => new Promise((res) => (p.exitCode !== null ? res() : (p.once('exit', res), p.kill('SIGKILL'))))));
  }
  assert.deepEqual(failed.slice(0, 3), [], `${failed.length} of ${reads} reads failed`);
  assert.ok(max < 250, `the slowest read took ${max.toFixed(0)} ms (${reads} reads)`);
});

test('a list in the working folder that is a hard link to a key: refused, and the refusal says what to do', () => {
  const P = place();
  // The working folder outside the data and temp folders (in this copy of floorboss), the key beside it on one disk.
  const cwd = mkdtempSync(join(ROOT, '.tmp-cwdlink-'));
  const before = process.cwd();
  try {
    mkdirSync(join(cwd, 'outside', '.ssh'), { recursive: true });
    const key = join(cwd, 'outside', '.ssh', 'id_test');
    writeFileSync(key, '-----BEGIN OPENSSH ' + 'PRIVATE KEY----- abc');
    linkSync(key, join(cwd, 'attendees.csv'));
    process.chdir(cwd);
    const p = join(cwd, 'attendees.csv');
    assert.throws(() => readChecked(allowedPath(p, { list: true })), /hard link[\s\S]*Copy it to a new file, then use the copy\./);
    // Anywhere else too: a file with a second name is never read.
    writeFileSync(join(cwd, 'plain.txt'), 'x');
    linkSync(join(cwd, 'plain.txt'), join(cwd, 'twin.txt'));
    assert.throws(() => readChecked(join(cwd, 'twin.txt')), /hard link[\s\S]*Copy it to a new file, then use the copy\./);
  } finally {
    process.chdir(before);
    rmSync(cwd, { recursive: true, force: true });
  }
  assert.ok(P);
});

test('every read leaves the working folder where it was', () => {
  const P = place();
  const before = process.cwd();
  assert.equal(readChecked(join(P.D, 'x.json')), 'BENIGN');
  assert.throws(() => readChecked(join(P.D, 'nothing.json')));
  assert.equal(process.cwd(), before);
});
