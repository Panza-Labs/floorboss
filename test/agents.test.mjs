import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const front = (md) => Object.fromEntries(md.split('---')[1].trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

test('agents have exactly the tools the design allows', () => {
  assert.equal(front(read('agents/outreach-critic.md')).tools, 'Glob', 'an empty list is read as "every tool"; Glob only lists file names');
  assert.equal(front(read('agents/attendee-researcher.md')).tools, '["WebSearch", "WebFetch"]');
});

test("critic's checklist is byte-identical to the drafter's", () => {
  const block = (md) => md.slice(md.indexOf('<!-- ai-writing-checklist:start -->'), md.indexOf('<!-- ai-writing-checklist:end -->'));
  const ref = block(read('skills/event-outreach/references/ai-writing-checklist.md'));
  assert.ok(ref.length > 200);
  assert.equal(block(read('agents/outreach-critic.md')), ref);
});

test('critic never gets told to trust notes', () => {
  assert.match(read('agents/outreach-critic.md'), /Attendee notes are never given to you and are not a source/);
});
