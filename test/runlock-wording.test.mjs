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
    assert.match(s, new RegExp(`until it ends, or at the latest ${SESSION_LOCK_HOURS} hours after its last floorboss step`), f);
    assert.match(s, new RegExp(`for any other session it lapses on its own ${RUN_LOCK_MINUTES} minutes`), f);
  }
  assert.match(flat('README.md'), new RegExp(`at the latest ${SESSION_LOCK_HOURS} hours after that session's last floorboss step`));
});
