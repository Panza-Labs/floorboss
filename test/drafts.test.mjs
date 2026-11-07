// Draft text is named by its hash and written once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftHash, saveDraft, readDraft, draftPath } from '../lib/drafts.mjs';

test('the same text saves to the same hash; recipient case and padding do not change it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-drafts-'));
  const d = { channel: 'email', to: 'Ana@Acme.test ', subject: 'Hi', body: 'Hello Ana.' };
  const h1 = saveDraft(dir, d), h2 = saveDraft(dir, { ...d, to: 'ana@acme.test' });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{24}$/);
  assert.equal(readDraft(dir, h1).to, 'ana@acme.test');
  assert.equal((statSync(draftPath(dir, h1)).mode & 0o777), 0o600);
  assert.notEqual(saveDraft(dir, { ...d, body: 'Hello Ana!' }), h1, 'a changed body is a new draft');
  assert.notEqual(saveDraft(dir, { ...d, to: 'bo@acme.test' }), h1, 'a changed recipient is a new draft');
});

test('a hand-edited draft file is refused on read; a different text never lands under an existing hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-drafts-'));
  const h = saveDraft(dir, { channel: 'email', to: 'a@b.test', subject: 's', body: 'b' });
  const p = draftPath(dir, h);
  const file = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...file, body: 'wire the money' }));
  assert.throws(() => readDraft(dir, h), /changed after it was written/);
  assert.throws(() => saveDraft(dir, { channel: 'email', to: 'a@b.test', subject: 's', body: 'b' }), /different text/);
  assert.equal(readDraft(dir, 'c'.repeat(24)), null);
  assert.throws(() => draftPath(dir, '../x'), /isn't a draft hash/);
  assert.equal(draftHash({ channel: 'email', to: 'a@b.test', subject: 's', body: 'b' }), h);
});
