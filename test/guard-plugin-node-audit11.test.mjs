// Second review of audit run 11's fixes: the rule that refuses a node command naming a file in the plugin folder
// without being read as floorboss's own script call (hooks/guard/shell.mjs pluginNodeRefusal) must refuse nothing the
// guard allowed before it (at 9d4fc19), and still refuse every other spelling of a script under skills/*/scripts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT } from './fixtures/autosend-world.mjs';

const R = ROOT;
const home = (held) => {
  const h = mkdtempSync(join(tmpdir(), 'fb-pn-'));
  mkdirSync(join(h, 'work'));
  writeFileSync(join(h, 'config.json'), '{"disclaimer_ack":true}');
  if (held) {
    const t = new Date().toISOString();
    writeFileSync(join(h, 'active.json'), JSON.stringify({ at: t, sessions: { 'sess-run': t } }));
  }
  return h;
};
// The main session, cwd the plugin folder, CLAUDE_PLUGIN_ROOT set, as Claude Code runs the hook.
const guard = (H, command, extra = {}) =>
  spawnSync('node', [join(R, 'hooks/guard.mjs')], {
    cwd: R,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-run', tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_name: 'Bash', tool_input: { command }, ...extra }),
    env: { ...process.env, FLOORBOSS_TEST: '1', FLOORBOSS_HOME: H, CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: R },
    encoding: 'utf8'
  });

// Expected exit codes [fresh session, held session], from the guard at 9d4fc19: a `git archive 9d4fc19` copy in a
// temp folder, each command run once through its hooks/guard.mjs with a new data folder (2026-11-22).
const H_ = '<HOME>';
const TABLE = [
  ['node "${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs" next', 0, 0],
  [`node "\${CLAUDE_PLUGIN_ROOT}/skills/flow/scripts/cli.mjs" answer --value-file ${H_}/work/v.txt`, 0, 0],
  [`node ${R}/skills/event-outreach/scripts/cli.mjs record --event harbor-expo --file ${H_}/work/r.json`, 0, 0],
  [`node ${R}/skills/connectors/scripts/cli.mjs tasks`, 0, 0],
  [`node ${R}/skills/autosend/scripts/cli.mjs routine-status`, 0, 0],
  [`node ${R}/examples/mock-event/load.mjs`, 0, 0],
  [`node "${R}/scripts/unattended.mjs" off`, 0, 0],
  [`node "${R}/scripts/unattended.mjs" status`, 0, 0],
  [`node "${R}/scripts/unattended.mjs" install-followups`, 2, 2],
  ['node scripts/self-check.mjs', 0, 2],
  [`node ${R}/scripts/self-check.mjs`, 2, 2],
  ['node --test --import ./test/fixtures/isolated-home.mjs "test/*.test.mjs"', 0, 2],
  ['node --test', 0, 2],
  ['bash scripts/privacy-check.sh', 0, 2],
  ['node --version', 0, 2],
  // Added at the third review (same source: the 9d4fc19 copy, 2026-11-22).
  ['grep -rn node lib/', 0, 2],
  ['node --check lib/ledger.mjs', 0, 2],
  ['node -e 1 lib/x', 0, 2]
];

test('every legitimate command gets the exit code it got at 9d4fc19, fresh and held', () => {
  for (const [cmd, fresh, held] of TABLE) {
    for (const [isHeld, want] of [[false, fresh], [true, held]]) {
      const H = home(isHeld);
      const r = guard(H, cmd.replaceAll(H_, H));
      assert.equal(r.status, want, `${isHeld ? 'held' : 'fresh'}: ${cmd}\n${r.stderr}`);
    }
  }
});

test('every other spelling of a script under skills/*/scripts/ is still refused for a subagent', () => {
  const H = home(false);
  const link = join(H, 'link.mjs');
  symlinkSync(join(R, 'skills/autosend/scripts/cli.mjs'), link);
  for (const cmd of [
    `node ${R}/skills/autosend//scripts/cli.mjs on --event x`,
    `node ${R}//skills/autosend/scripts/cli.mjs on --event x`,
    `node "$CLAUDE_PLUGIN_ROOT/skills/autosend//scripts/cli.mjs" on --event x`,
    `cd ${R}/skills/autosend/scripts && node cli.mjs on --event x`,
    `cd ${R}/skills/autosend/scripts; node ./cli.mjs on --event x`,
    `node ${link} on --event x`,
    `node ${R}/skills/autosend/scripts/cli.mjs/ on --event x`,
    `node ${R}/skills/AUTOSEND/scripts/cli.mjs on --event x`,
    `node ${R}/skills/autosend/scripts/CLI.mjs on --event x`,
    'node skills/autosend//scripts/cli.mjs on --event x'
  ])
    assert.equal(guard(H, cmd, { agent_id: 'agent-1' }).status, 2, cmd);
});
