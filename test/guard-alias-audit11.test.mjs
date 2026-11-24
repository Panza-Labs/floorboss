// Third review of audit run 11's fixes: the guard knows floorboss's scripts by what they are on disk (device and
// inode), not by how a path is spelled. A cd into another name for the plugin folder (the macOS /System/Volumes/Data
// firmlink, a symlinked parent folder), or a hard link to the script, never skips the auto-send rules.
//   - a cd form (cd <alias>/… && node cli.mjs …) is refused;
//   - "node <alias>/skills/autosend/scripts/cli.mjs …" is recognised as the auto-send script, with all its rules;
//   - a hard link to the script in another folder is refused (it would load that folder's lib, not floorboss's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT } from './fixtures/autosend-world.mjs';

const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'fb-al-'));
  mkdirSync(join(h, 'work'));
  writeFileSync(join(h, 'config.json'), '{"disclaimer_ack":true}');
  return h;
};
const guard = (H, command, extra = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], {
    cwd: ROOT,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_name: 'Bash', tool_input: { command }, ...extra }),
    env: { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: H, CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: ROOT },
    encoding: 'utf8'
  });
const decision = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision || null;
  } catch {
    return null;
  }
};
const SUB = { agent_id: 'agent-1' };
const H0 = home();
const aliases = [join(H0, 'plug')];
symlinkSync(ROOT, aliases[0]);
const firm = `/System/Volumes/Data${ROOT}`;
if (existsSync(join(firm, 'hooks', 'guard.mjs'))) aliases.push(firm);

for (const A of aliases) {
  test(`a cd into ${A === firm ? 'the firmlink' : 'a symlinked parent'} of the plugin folder is refused`, () => {
    const H = home();
    const cmds = [
      `cd ${A}/skills/autosend/scripts && node cli.mjs on --event a`,
      `cd ${A}/skills/autosend/scripts && node cli.mjs draft-gone --event a --id p --touch 2 --said hellothere`,
      `cd ${A} && node skills/autosend/scripts/./cli.mjs on --event a`,
      `cd ${A} && node skills/autosend//scripts/cli.mjs on --event a`
    ];
    for (const c of cmds) {
      assert.equal(guard(H, c, SUB).status, 2, `subagent: ${c}`);
      const m = guard(H, c);
      assert.ok(m.status === 2 || decision(m) === 'ask', `main: ${c}`);
    }
  });
  test(`node on the script through ${A === firm ? 'the firmlink' : 'a symlinked parent'} is recognised as the auto-send script`, () => {
    const H = home();
    const s = guard(H, `node ${A}/skills/autosend/scripts/cli.mjs on --event a`, SUB);
    assert.equal(s.status, 2);
    assert.match(s.stderr, /subagent doesn't change auto-send/, 'the subagent rule, so recognised');
    const m = guard(H, `node ${A}/skills/autosend/scripts/cli.mjs settle --event a`);
    assert.equal(m.status, 2);
    assert.match(m.stderr, /auto-send script runs only/, 'the Claude Code allowlist, so recognised');
    const g = guard(H, `node ${A}/skills/autosend/scripts/cli.mjs draft-gone --event a --id p --touch 2 --said hellothere`);
    assert.equal(g.status, 2, 'draft-gone through the alias meets its own checks (no such event here)');
    assert.match(g.stderr, /draft-gone/);
  });
}

test('a hard link to cli.mjs in a copied folder is refused: it would run the copy\'s own lib, so it is not floorboss\'s script', (t) => {
  const H = home();
  const dir = join(H, 'copy', 'skills', 'autosend', 'scripts');
  mkdirSync(dir, { recursive: true });
  try {
    linkSync(join(ROOT, 'skills/autosend/scripts/cli.mjs'), join(dir, 'cli.mjs'));
  } catch (e) {
    t.skip(`no hard link here (${e.code})`);
    return;
  }
  for (const c of [`node ${dir}/cli.mjs on --event a`, `node ${dir}/cli.mjs readback --event a`, `cd ${dir} && node cli.mjs on --event a`]) {
    assert.equal(guard(H, c, SUB).status, 2, `subagent: ${c}`);
    const m = guard(H, c);
    assert.equal(m.status, 2, `main: ${c}`);
    assert.match(m.stderr, /floorboss blocked this call/, c);
  }
});
