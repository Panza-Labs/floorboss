// readChecked judges the place it read by the real path its inode check used, never by the name a second time: a
// folder on the way that flips between a plain folder (or a harmless link) and a link to ~/.ssh can't pass a key
// off as floorboss's own file. And a link anywhere inside the data folder is refused on a read, as on a write
// (lib/paths.mjs linkRefusal): floorboss never makes one there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChecked } from '../lib/paths.mjs';

// A data folder of its own (FLOORBOSS_HOME) with a "key" outside it, in a folder named .ssh.
function place() {
  const base = mkdtempSync(join(tmpdir(), 'fb-readlink-'));
  const H = join(base, 'home');
  process.env.FLOORBOSS_HOME = H;
  mkdirSync(join(H, 'events', 'e'), { recursive: true });
  mkdirSync(join(base, 'benign'), { recursive: true });
  mkdirSync(join(base, 'outside', '.ssh'), { recursive: true });
  writeFileSync(join(base, 'benign', 'x.json'), 'BENIGN');
  writeFileSync(join(base, 'outside', '.ssh', 'x.json'), 'SECRET');
  return { base, H, derived: join(H, 'events', 'e', 'derived'), ssh: join(base, 'outside', '.ssh'), benign: join(base, 'benign') };
}
// Reads for ms, counting what each read returned or why it was refused.
function hammer(f, ms) {
  const out = { BENIGN: 0, SECRET: 0, refused: 0 };
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const t = readChecked(f);
      out[t] = (out[t] || 0) + 1;
    } catch {
      out.refused++;
    }
  }
  return out;
}
const run = (code, args) => {
  const p = spawn(process.execPath, ['-e', code, ...args], { stdio: 'ignore' });
  return p;
};
const stop = (p) => new Promise((res) => (p.exitCode !== null ? res() : (p.once('exit', res), p.kill('SIGKILL'))));
const settle = () => new Promise((r) => setTimeout(r, 200));

test('a folder on the way flipping between two links (one harmless, one to .ssh): a read never returns the key', async () => {
  const P = place();
  symlinkSync(P.benign, P.derived);
  const flip = `const fs=require('node:fs');const [d,a,b]=process.argv.slice(1);let i=0;
    for(;;){const t=d+'.t';try{fs.unlinkSync(t)}catch{};fs.symlinkSync((i++&1)?a:b,t);fs.renameSync(t,d);}`;
  const p = run(flip, [P.derived, P.benign, P.ssh]);
  await settle();
  let out;
  try {
    out = hammer(join(P.derived, 'x.json'), 2000);
  } finally {
    await stop(p);
  }
  assert.equal(out.SECRET, 0, JSON.stringify(out));
});

test('a folder on the way flipping between a plain folder and a link to .ssh: a read never returns the key', async () => {
  const P = place();
  mkdirSync(P.derived);
  writeFileSync(join(P.derived, 'x.json'), 'BENIGN');
  const flip = `const fs=require('node:fs');const [d,ssh]=process.argv.slice(1);const keep=d+'.real';
    for(;;){fs.renameSync(d,keep);fs.symlinkSync(ssh,d);for(let i=0;i<50;i++);fs.unlinkSync(d);fs.renameSync(keep,d);}`;
  const p = run(flip, [P.derived, P.ssh]);
  await settle();
  let out;
  try {
    out = hammer(join(P.derived, 'x.json'), 2000);
  } finally {
    await stop(p);
  }
  assert.equal(out.SECRET, 0, JSON.stringify(out));
});

test('a link inside the data folder is refused on a read, wherever it points', () => {
  const P = place();
  symlinkSync(P.benign, P.derived);
  assert.throws(() => readChecked(join(P.derived, 'x.json')), /link/);
  // A link to another place inside the data folder too.
  const inside = join(P.H, 'events', 'e', 'real');
  mkdirSync(inside);
  writeFileSync(join(inside, 'y.json'), '{}');
  symlinkSync(inside, join(P.H, 'events', 'e', 'alias'));
  assert.throws(() => readChecked(join(P.H, 'events', 'e', 'alias', 'y.json')), /link/);
  // The same file by its own name still reads.
  assert.equal(readChecked(join(inside, 'y.json')), '{}');
});

test('a data folder that is itself reached through a link (the temp folder on macOS) still reads', () => {
  const base = mkdtempSync(join(tmpdir(), 'fb-readlink-'));
  mkdirSync(join(base, 'real-home', 'work'), { recursive: true });
  writeFileSync(join(base, 'real-home', 'work', 'a.json'), '{"a":1}');
  symlinkSync(join(base, 'real-home'), join(base, 'home'));
  process.env.FLOORBOSS_HOME = join(base, 'home');
  assert.equal(readChecked(join(base, 'home', 'work', 'a.json')), '{"a":1}');
});
