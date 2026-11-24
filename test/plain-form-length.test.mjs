// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The plain form's word limit is the rules line's (60-100 words for a first message), not a tighter 75 (sim run 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structureProblems } from '../skills/event-outreach/scripts/structures.mjs';

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

test('a 90-word plain-form message passes; 101 words is over the limit the rules name', () => {
  assert.deepEqual(structureProblems({ body: words(90) }, { structure: 'plain-request', factSource: 'list' }), []);
  assert.deepEqual(structureProblems({ body: words(100) }, { structure: 'plain-request', factSource: 'list' }), []);
  const over = structureProblems({ body: words(101) }, { structure: 'plain-request', factSource: 'list' });
  assert.match(over.join(' '), /100 words/);
});
