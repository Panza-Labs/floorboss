// Fixes for what GitHub's code scanning flagged on the first push: a file-name pattern that slowed down sharply on a
// crafted name, and "is this LinkedIn?" checks that looked for the site's name anywhere in an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkedInUrl } from '../lib/route.mjs';
import { secretPlace as secretFile } from '../lib/paths.mjs';

test('a LinkedIn address is told by its site, not by the name appearing somewhere in it', () => {
  for (const u of ['https://www.linkedin.com/in/ana', 'linkedin.com/in/ana', 'uk.linkedin.com/in/ana', 'HTTPS://LinkedIn.com/in/ana', ' https://linkedin.com/pub/x '])
    assert.equal(isLinkedInUrl(u), true, u);
  for (const u of ['https://evil.example/linkedin.com/in/ana', 'https://linkedin.com.evil.example/in/ana', 'https://notlinkedin.com/in/ana', 'https://evil.example/?u=linkedin.com/', '', null, undefined])
    assert.equal(isLinkedInUrl(u), false, String(u));
});

test('an env-file name with many dashes is judged at once, and the same names count as before', () => {
  const t = Date.now();
  for (const n of [40, 400, 4000]) secretFile(`/x/.env${'-'.repeat(n)} x`);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
  for (const p of ['/x/.env', '/x/.env.local', '/x/.envrc', '/x/prod.env', '/x/.env-prod.bak', '/x/.env.example.local', '/x/.env_a-b.c'])
    assert.equal(secretFile(p), true, p);
  for (const p of ['/x/.env.example', '/x/.env.sample', '/x/my.env.js', '/x/.env.d.ts', '/x/readme.md'])
    assert.equal(secretFile(p), false, p);
});
