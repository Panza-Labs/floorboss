// The run lock's window is said the same way everywhere: the session that ran floorboss stays held until it
// ends, or at the latest SESSION_LOCK_HOURS after its last floorboss step, as lib/runlock.mjs holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/harness.mjs';
import { SESSION_LOCK_HOURS, RUN_LOCK_MINUTES } from '../lib/runlock.mjs';

test('every command and the README name the session window the code uses', () => {
  const flat = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\s+/g, ' ');
  for (const f of readdirSync(join(ROOT, 'commands'))) {
    const s = flat(join('commands', f));
    // unattended.md turns unattended drafts on and authorises follow-ups through floorboss's scripts, so it holds a run
    // like any command; and none of its calls installs, removes or switches back on what runs on its own.
    if (f === 'unattended.md')
      for (const t of JSON.parse(/allowed-tools: (\[.*\])/.exec(readFileSync(join(ROOT, 'commands', f), 'utf8'))[1]))
        assert.doesNotMatch(t, /install|uninstall|unattended\.mjs" on/, t);
    assert.match(s, new RegExp(`until it ends, or at the latest ${SESSION_LOCK_HOURS} hours after its last floorboss step`), f);
    assert.match(s, new RegExp(`for any other session it lapses on its own ${RUN_LOCK_MINUTES} minutes`), f);
  }
  assert.match(flat('README.md'), new RegExp(`at the latest ${SESSION_LOCK_HOURS} hours after that session's last floorboss step`));
});
