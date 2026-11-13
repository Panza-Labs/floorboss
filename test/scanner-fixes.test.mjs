// Fixes for what GitHub's code scanning flagged on the first push: a file-name pattern that slowed down sharply on a
// crafted name, and "is this LinkedIn?" checks that looked for the site's name anywhere in an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkedInUrl } from '../lib/route.mjs';
import { secretPlace as secretFile } from '../lib/paths.mjs';

test('a LinkedIn address is told by its site, not by the name appearing somewhere in it', () => {
  for (const u of ['https://www.linkedin.com/in/ana', 'linkedin.com/in/ana', 'uk.linkedin.com/in/ana', 'm.linkedin.com/in/a?trk=x', 'HTTPS://LinkedIn.com/in/ana', ' https://linkedin.com/pub/x '])
    assert.equal(isLinkedInUrl(u), true, u);
  // A list cell as people really fill it in.
  for (const u of ['//www.linkedin.com/in/ana', '<https://www.linkedin.com/in/ana>', '"https://www.linkedin.com/in/ana"', 'LinkedIn: https://www.linkedin.com/in/ana', '[Ana](https://www.linkedin.com/in/ana)', 'https://x.com/a https://www.linkedin.com/in/ana', 'https:// www.linkedin.com/in/ana', 'https:/www.linkedin.com/in/ana'])
    assert.equal(isLinkedInUrl(u), true, u);
  for (const u of [
    'https://evil.example/linkedin.com/in/ana',
    'https://linkedin.com.evil.example/in/ana',
    'https://notlinkedin.com/in/ana',
    'https://evil.example/?u=linkedin.com/',
    'https://evil.example/?u=https://linkedin.com/in/a',
    'https://evil.example/#linkedin.com/in/a',
    'https://linkedin.com@evil.example/in/a',
    'evil.example/x.linkedin.com/in/a',
    'https://www.google.com/url?q=https://www.linkedin.com/in/ana',
    ['user', 'linkedin.com'].join('@'),
    '',
    null,
    undefined
  ])
    assert.equal(isLinkedInUrl(u), false, String(u));
  const t = Date.now();
  for (const u of ['a.'.repeat(50000), `https://${'-'.repeat(100000)}`, 'a'.repeat(100000)]) isLinkedInUrl(u);
  assert.ok(Date.now() - t < 500);
});

test('an env-file name with many dashes is judged at once, and the same names count as before', () => {
  const t = Date.now();
  for (const n of [40, 400, 4000]) secretFile(`/x/.env${'-'.repeat(n)} x`);
  for (const name of ['.env'.repeat(16000) + '!', `.env${' '.repeat(16000)}x`, `.env${'~'.repeat(16000)}x`]) secretFile(`/x/${name}`);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
  for (const p of ['/x/.env', '/x/.env.local', '/x/.envrc', '/x/prod.env', '/x/.env-prod.bak', '/x/.env.example.local', '/x/.env_a-b.c'])
    assert.equal(secretFile(p), true, p);
  for (const p of ['/x/.env.example', '/x/.env.sample', '/x/my.env.js', '/x/.env.d.ts', '/x/readme.md'])
    assert.equal(secretFile(p), false, p);
});
