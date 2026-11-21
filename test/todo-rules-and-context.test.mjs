// The drafting step reads the todo file and a Codex model may never open the help file or the context files: the
// must-follow rules and the user's own material are inside the todo file itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, triage, todoJobs } from './fixtures/harness.mjs';

const build = (voiceText) => {
  const H = setup({ attendees: 'Name,Title,Company,Email\nAna Berg,COO,Acme,ana@acme.test\n' });
  const voice = join(H.HOME, 'context', 'buyers', 'voice', 'SKILL.md');
  if (voiceText != null) writeFileSync(voice, voiceText);
  triage(H);
  const { t } = todoJobs(H);
  return { f: JSON.parse(readFileSync(t.todo_file, 'utf8')), voice, t };
};

test('the todo file opens with the drafting rules', () => {
  const { f, t } = build('# Voice\nShort. Plain. Sign-off: Best, Sam\n');
  assert.equal(Object.keys(f)[0], 'rules');
  assert.ok(f.rules.length >= 10 && f.rules.length <= 14, String(f.rules.length));
  const all = f.rules.join('\n');
  for (const re of [/researched fact/, /No meeting place/, /a person types/, /I'd like|\\"I'd like\\"/, /No demo/, /60 to 100 words/, /40 characters/, /follow-up stands alone/, /opt-out line exactly/, /Invent nothing/, /voice text wins on tone; take proof points and insights only from what_you_bring/])
    assert.match(all, re);
  assert.ok(t.context.voice.endsWith('SKILL.md'));
  assert.deepEqual(f.event, t.event, 'the drafting file has the event days for a closing note');
});

test('the todo file carries the user\'s own text, and the paths too', () => {
  const { f } = build('# Voice\nShort. Plain. Sign-off: Best, Sam\n');
  assert.match(f.context_text.voice, /Sign-off: Best, Sam/);
  assert.ok(f.context_text.what_you_bring.length > 0);
  assert.ok(f.context_text.who_to_meet.length > 0);
  assert.equal(f.context_text.truncated, undefined);
  assert.ok(f.context.voice.endsWith('SKILL.md'));
});

test('a long file is cut, and the cut says so and keeps the path', () => {
  const { f, voice } = build(`# Voice\n${'word '.repeat(5000)}`);
  assert.ok(f.context_text.voice.length <= 6000);
  assert.match(f.context_text.truncated.join(' '), new RegExp(`voice: cut at 6000 of \\d+ characters; the rest is in ${voice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
