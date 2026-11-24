// Review of audit run 11's fixes, finding 1a: a floorboss script path spelled another way (a double slash, a leading
// cd, a link, a trailing slash, other letter case) must never skip the auto-send guard. A node command that names a
// file in the plugin folder and isn't read as floorboss's own script call is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { symlinkSync } from 'node:fs';
import { world, envFor, EVENT, SLUG, ROOT } from './fixtures/autosend-world.mjs';
import { ROUTINE_MODE } from '../lib/autosend/routine.mjs';

const guard = (HOME, command, extra = {}) =>
  spawnSync('node', [join(ROOT, 'hooks/guard.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_name: 'Bash', tool_input: { command }, ...extra }), env: envFor(HOME, { claude: true }), encoding: 'utf8' });
const decision = (r) => {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision || null;
  } catch {
    return null;
  }
};
const SUB = { agent_id: 'agent-researcher-1' };

test('every other spelling of the auto-send script is refused for a subagent, and never let through unasked', () => {
  const { HOME } = world({ touches: 1, event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  const link = join(HOME, 'link.mjs');
  symlinkSync(join(ROOT, 'skills/autosend/scripts/cli.mjs'), link);
  const spellings = [
    `node ${ROOT}/skills/autosend//scripts/cli.mjs on --event ${SLUG}`,
    `node ${ROOT}//skills/autosend/scripts/cli.mjs on --event ${SLUG}`,
    `node "${ROOT}/skills/autosend//scripts/cli.mjs" on --event ${SLUG}`,
    `node '${ROOT}/skills//autosend/scripts/cli.mjs' on --event ${SLUG}`,
    `node "$CLAUDE_PLUGIN_ROOT/skills/autosend//scripts/cli.mjs" on --event ${SLUG}`,
    `cd ${ROOT}/skills/autosend/scripts && node cli.mjs on --event ${SLUG}`,
    `cd ${ROOT}/skills/autosend/scripts; node ./cli.mjs on --event ${SLUG}`,
    `node ${link} on --event ${SLUG}`,
    `node ${ROOT}/skills/autosend/scripts/cli.mjs/ on --event ${SLUG}`,
    `node ${ROOT}/skills/AUTOSEND/scripts/cli.mjs on --event ${SLUG}`,
    `node ${ROOT}/skills/autosend/scripts/CLI.mjs on --event ${SLUG}`
  ];
  for (const cmd of spellings) {
    const s = guard(HOME, cmd, SUB);
    assert.equal(s.status, 2, `subagent: ${cmd}`);
    const m = guard(HOME, cmd.replace(' on --event', ' draft-gone --id c001 --touch 2 --said hellothere --event'));
    assert.ok(m.status === 2 || decision(m) === 'ask', `main, never unasked: ${cmd}`);
  }
});

test('a double slash is read as the script itself: the auto-send rules apply to it', () => {
  const { HOME } = world({ touches: 1, event: { ...EVENT, autosend_mode: ROUTINE_MODE } });
  // Read-only, main session: allowed, as with the plain path.
  assert.equal(guard(HOME, `node ${ROOT}/skills/autosend//scripts/cli.mjs readback --event ${SLUG}`).status, 0);
  // Codex-only verbs: refused by the Claude Code allowlist.
  const r = guard(HOME, `node ${ROOT}/skills/autosend//scripts/cli.mjs settle --event ${SLUG}`);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /auto-send script runs only/);
  // The plain spelling is unchanged.
  assert.equal(guard(HOME, `node ${ROOT}/skills/autosend/scripts/cli.mjs readback --event ${SLUG}`, SUB).status, 0);
});
