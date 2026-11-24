// readChecked looks up a name more than once (the open, the real path, the inode check): a folder inside the data
// folder that is a link to ~/.ssh at some of those looks and a plain folder at the others must never let the key
// through. Here the flips land at exactly those moments, every time (the file system calls are wrapped for this one
// read), not by luck: at the open the folder is a link, at the real path a plain folder, at the inode check a link
// again, and a plain folder after it. (A flipping process found it about once in 25,000 reads.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChecked } from '../lib/paths.mjs';

test('a folder flipped to a link to .ssh and back between the looks of one read: the key is never returned', () => {
  const base = mkdtempSync(join(tmpdir(), 'fb-flip-'));
  const H = join(base, 'home');
  process.env.FLOORBOSS_HOME = H;
  const D = join(H, 'events', 'e', 'derived');
  const ssh = join(base, 'outside', '.ssh');
  mkdirSync(D, { recursive: true });
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(D, 'x.json'), 'BENIGN');
  writeFileSync(join(ssh, 'x.json'), 'SECRET');
  const toLink = () => {
    renameSync(D, `${D}.real`);
    symlinkSync(ssh, D);
  };
  const toPlain = () => {
    unlinkSync(D);
    renameSync(`${D}.real`, D);
  };
  const target = join(D, 'x.json');
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
    if (stage === 2 && String(p).endsWith(join('derived', 'x.json'))) {
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
  assert.equal(stage, 3, 'every flip landed');
  assert.notEqual(got, 'SECRET');
});
