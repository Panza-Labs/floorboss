// The Codex pack (.codex-plugin/plugin.json, .agents/skills/floorboss, codex/, AGENTS.md): what Codex loads, and that
// none of it depends on Claude Code's own tools or loads Claude Code's guard hooks, which fail open in Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const walk = (d) => readdirSync(join(ROOT, d)).flatMap((f) => (statSync(join(ROOT, d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const PACK = ['AGENTS.md', '.codex-plugin/plugin.json', ...walk('.agents'), ...walk('codex')];

test('the Codex manifest names its own skills, commands and an empty hooks file', () => {
  const m = JSON.parse(readFileSync(join(ROOT, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(m.name, 'floorboss');
  // Without these fields Codex would load skills/, migrate commands/ and run hooks/hooks.json (openai/codex 0.170.0,
  // core-plugins/src/loader.rs and command_migration/plugin.rs): Claude Code's files, Claude Code's guard.
  assert.equal(m.skills, './.agents/skills');
  assert.equal(m.commands, './codex/commands');
  assert.equal(m.hooks, './codex/hooks.json');
  assert.ok(!('mcpServers' in m) && !('apps' in m));
  const hooks = JSON.parse(readFileSync(join(ROOT, 'codex/hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks, {});
  // The version moves with Claude Code's plugin.
  assert.equal(m.version, JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version);
  // A root plugin.json would be read before .codex-plugin and has defaults of its own: there is none.
  assert.ok(!existsSync(join(ROOT, 'plugin.json')));
  // No .mcp.json or .app.json at the root for Codex to pick up by default.
  assert.ok(!existsSync(join(ROOT, '.mcp.json')) && !existsSync(join(ROOT, '.app.json')));
});

test('the pack names no Claude-only tool, variable or command', () => {
  const banned = [/AskUserQuestion/, /\bAgent tool\b/, /\bSkill tool\b/, /\/clear\b/, /\bmcp__/, /allowed-tools/, /\bWebFetch\b/];
  for (const f of PACK) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const b of banned) assert.ok(!b.test(text), `${f}: ${b}`);
  }
  // CLAUDE_PLUGIN_ROOT appears once, in the sentence that says what to read in its place.
  for (const f of PACK) {
    const n = (readFileSync(join(ROOT, f), 'utf8').match(/CLAUDE_PLUGIN_ROOT/g) || []).length;
    assert.equal(n, f.endsWith('floorboss/SKILL.md') ? 1 : 0, f);
  }
  assert.match(readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8'), /where they say\s+`\$\{CLAUDE_PLUGIN_ROOT\}`, read `FLOORBOSS`/);
  // The skill says, in so many words, that it sends nothing and calls no connected tool.
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.match(skill, /Never call a connected tool for floorboss/);
  assert.match(skill, /Never send\./);
  assert.match(skill, /critic is me, in this same conversation/);
  // What a first-time Windows user needs (the first-time-user review): every word quoted, agents one after another
  // by their file names, lists copied into the data folder, a booked time as a dated time in the event's zone, and
  // the brief on request.
  assert.match(skill, /every word\*\* of a command in double quotes/);
  assert.match(skill, /`floorboss:` taken off the front of the name/);
  assert.match(skill, /copy the file into `~\/\.floorboss\/work\/`/);
  assert.match(skill, /`YYYY-MM-DD HH:MM` in the event's time zone/);
  assert.match(skill, /next --agenda --event <slug>/);
  assert.match(skill, /^name: floorboss$/m);
  assert.match(skill, /^description: .+/m);
});

test('the Codex commands are small, have a description, and no name clash with the skill', () => {
  const files = readdirSync(join(ROOT, 'codex/commands')).sort();
  assert.deepEqual(files, ['floorboss-report.md', 'floorboss-start.md']);
  for (const f of files) {
    const text = readFileSync(join(ROOT, 'codex/commands', f), 'utf8');
    // Codex migrates a command into a skill only with a description, and only under 4,000 bytes.
    assert.match(text, /^---\ndescription: .+\n---\n/, f);
    assert.ok(Buffer.byteLength(text) < 4000, f);
  }
  // The report command points at the skill section that says how; the skill reads outcomes back before recording.
  assert.match(readFileSync(join(ROOT, 'codex/commands/floorboss-report.md'), 'utf8'), /How a meeting went,\s+and the report/);
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  assert.match(skill, /^## How a meeting went, and the report$/m);
  assert.match(skill, /run `record` with `--check` first/);
  assert.match(skill, /cli\.mjs" report --event <slug>/);
  // AGENTS.md is well under Codex's 32 KiB read limit.
  assert.ok(statSync(join(ROOT, 'AGENTS.md')).size < 4096);
});

test('every script the Codex skill names exists', () => {
  const skill = readFileSync(join(ROOT, '.agents/skills/floorboss/SKILL.md'), 'utf8');
  const paths = [...skill.matchAll(/FLOORBOSS\/([\w./-]+\.(?:mjs|md))/g)].map((m) => m[1]);
  assert.ok(paths.length >= 4);
  for (const p of new Set(paths)) assert.ok(existsSync(join(ROOT, p)), p);
});
