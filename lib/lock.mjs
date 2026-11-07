// One process at a time for a check and the write that depends on it (the lookup count, the lookup window): a lock
// folder in floorboss's data folder, taken by mkdir, waited for up to 8 seconds, and broken when over 5 seconds old
// (a hook that died holding it). It is broken by renaming it away and checking the renamed folder is the one seen
// old, so a waiter never breaks a lock another waiter has just taken.
import { mkdirSync, rmdirSync, renameSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { home } from './paths.mjs';

export function withLock(name, fn, { waitMs = 8000, staleMs = 5000 } = {}) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const lock = join(home(), `${name}.lock`);
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          const gone = `${lock}.stale-${randomBytes(6).toString('hex')}`;
          renameSync(lock, gone);
          // Another waiter broke the old one and took a new lock in between: that one is put back.
          const now = lstatSync(gone);
          if (now.ino !== st.ino || now.mtimeMs !== st.mtimeMs) {
            if (!existsSync(lock)) renameSync(gone, lock);
          } else rmdirSync(gone);
        }
      } catch {
        /* another process broke or released it */
      }
      if (Date.now() - t0 > waitMs) throw new Error(`another floorboss process is busy with ${name}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* gone */
    }
  }
}
