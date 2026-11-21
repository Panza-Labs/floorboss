// The owner's biggest complaint about the Codex drafts: no researched, reader-specific opening. Where a research
// profile exists, a first message must use it; the plain form is for people with no profile, and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchProblems } from '../skills/event-outreach/scripts/structures.mjs';

const withProfile = { touch: 1, fact_sources: ['industry', 'research', 'list'] };
const noProfile = { touch: 1, fact_sources: ['list'] };

test('a first message with a research profile must use the researched fact', () => {
  for (const fs of ['industry', 'list', 'crm', 'none', null]) {
    const p = researchProblems({ fact_source: fs, structure: 'insight-first', brief: 'x' }, withProfile);
    assert.match(p.join(' '), /use the researched fact/, String(fs));
  }
  assert.deepEqual(researchProblems({ fact_source: 'research', structure: 'question-first', brief: 'x' }, withProfile), []);
});

test('a follow-up, or a person with no profile, is not held to it', () => {
  assert.deepEqual(researchProblems({ fact_source: 'list', structure: 'peer-note', brief: 'x' }, { ...withProfile, touch: 2, followup: true }), []);
  assert.deepEqual(researchProblems({ fact_source: 'list', structure: 'peer-note', brief: 'x' }, noProfile), []);
});

test('the plain form with no profile says so in the brief', () => {
  const d = (brief) => ({ fact_source: 'none', structure: 'plain-request', brief });
  assert.match(researchProblems(d('a plain ask'), noProfile).join(' '), /no research profile/);
  assert.deepEqual(researchProblems(d('plain ask: no research profile for this person'), noProfile), []);
  assert.deepEqual(researchProblems(d('no researched profile, so plain'), noProfile), []);
});
