// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The daily task's zone is the show's, never the user's own (sim run 1, 2026-11-21): the Codex skill says so, and
// the command, given no --zone, uses the show's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './sims/lib/driver.mjs';

test('the Codex skill: daily-task --zone is the show\'s time zone, and may be left out', () => {
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /--zone <their IANA time zone>/);
  assert.match(skill, /daily-task \[--time 9:00\]/);
  assert.match(skill, /show's time zone/);
});
