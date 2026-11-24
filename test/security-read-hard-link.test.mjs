// A file with a second name (a hard link) in the data folder or the temp folder is never read: every path check goes
// by name, and its other name may be a key. readChecked judges the file it opened (fstat's link count), so a file
// swapped for a hard link after allowedPath passed is refused too. And a file that isn't valid JSON is never quoted
// in the error that says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChecked, allowedPath } from '../lib/paths.mjs';
import { readJson } from '../lib/jsonio.mjs';

const KEY = '-----BEGIN OPENSSH ' + 'PRIVATE KEY----- abcdefghijklmnopqrstuvwxyz0123456789';
function place() {
  const base = mkdtempSync(join(tmpdir(), 'fb-hardlink-'));
  const H = join(base, 'home');
  process.env.FLOORBOSS_HOME = H;
  mkdirSync(join(H, 'work'), { recursive: true });
  mkdirSync(join(H, 'events', 'e', 'derived'), { recursive: true });
  mkdirSync(join(base, 'outside', '.ssh'), { recursive: true });
  const key = join(base, 'outside', '.ssh', 'id_test');
  writeFileSync(key, KEY);
  return { base, H, key };
}

test('a file swapped for a hard link to a key after allowedPath passed: readChecked refuses it', () => {
  const P = place();
  const p = join(P.H, 'work', 'in.json');
  writeFileSync(p, '{}');
  const ok = allowedPath(p);
  unlinkSync(p);
  linkSync(P.key, p);
  assert.throws(() => readChecked(ok), /another name on the disk \(a hard link\)/);
});

test('a derived file that is a hard link to a key: readJson refuses it, and its error quotes nothing of the key', () => {
  const P = place();
  const d = join(P.H, 'events', 'e', 'derived', 'resolved.json');
  linkSync(P.key, d);
  let err;
  try {
    readJson(d, null);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'refused');
  assert.match(err.message, /hard link/);
  assert.doesNotMatch(err.message, /BEGIN|OPENSSH|abcdef/);
});

test('a hard link to a harmless file, in the data folder or the temp folder, is refused too', () => {
  const P = place();
  const plain = join(P.base, 'plain.json');
  writeFileSync(plain, '{}');
  linkSync(plain, join(P.H, 'work', 'twin.json'));
  assert.throws(() => readChecked(join(P.H, 'work', 'twin.json')), /hard link/);
  assert.throws(() => readChecked(plain), /hard link/, 'in the temp folder');
});

test('a file that is not valid JSON: the error names the file and where, and quotes none of it', () => {
  const P = place();
  for (const text of ['TOPSECRETCONTENT here', '{"a": TOPSECRET}', '{"TOPSECRET":1,']) {
    const f = join(P.H, 'work', `bad-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, text);
    let err;
    try {
      readJson(f, null);
    } catch (e) {
      err = e;
    }
    assert.ok(err, text);
    assert.match(err.message, /is not valid JSON/);
    assert.ok(err.message.includes(f), err.message);
    assert.doesNotMatch(err.message.replace(f, ''), /TOPSECRET|"a"/, err.message);
  }
});

test('a plain file with one name still reads', () => {
  const P = place();
  const f = join(P.H, 'work', 'ok.json');
  writeFileSync(f, '{"ok":true}');
  assert.deepEqual(readJson(f, null), { ok: true });
});
