import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const md = [
  ...readdirSync(join(ROOT, 'commands')).map((f) => join('commands', f)),
  ...readdirSync(join(ROOT, 'agents')).map((f) => join('agents', f)),
  ...readdirSync(join(ROOT, 'skills')).map((d) => join('skills', d, 'SKILL.md')),
];

test('every command, agent and skill has frontmatter with a description', () => {
  for (const f of md) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(text.startsWith('---\n'), f);
    assert.match(text.split('---')[1], /\ndescription: \S/, f);
  }
});

test('skill names match their folders', () => {
  for (const d of readdirSync(join(ROOT, 'skills'))) {
    const fm = readFileSync(join(ROOT, 'skills', d, 'SKILL.md'), 'utf8').split('---')[1];
    assert.match(fm, new RegExp(`\\nname: ${d}\\n`), d);
  }
});

test('every script path referenced by a command or skill exists', () => {
  for (const f of md) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.(?:mjs|md))/g)) {
      assert.ok(existsSync(join(ROOT, m[1])), `${f} → ${m[1]}`);
    }
    if (f.startsWith('skills/')) {
      for (const m of text.matchAll(/`(scripts\/[\w.-]+\.mjs)/g)) assert.ok(existsSync(join(ROOT, f.replace('SKILL.md', ''), m[1])), `${f} → ${m[1]}`);
    }
  }
});

test('every skill says its license, the repo\'s own (Apache-2.0)', () => {
  for (const d of readdirSync(join(ROOT, 'skills'))) {
    const fm = readFileSync(join(ROOT, 'skills', d, 'SKILL.md'), 'utf8').split('---')[1];
    assert.match(fm, /\nlicense: Apache-2\.0\n/, d);
  }
});
