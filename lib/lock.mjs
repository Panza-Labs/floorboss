// One process at a time for a check and the write that depends on it (the lookup count, the lookup window, a send to
// one address): a lock folder in floorboss's data folder, taken by mkdir, waited for up to 8 seconds, and broken when
// over staleMs old (5 seconds unless the caller says; a hook that died holding it). It is broken by renaming it away
// and removing the renamed folder only when it is the one seen old. A folder renamed away that turns out to be
// another process's new lock is never put back (putting it back could land on a third process's lock): the process
// that took it finds it gone. So fn is given owned(), true only while the lock folder is still the one this call
// made, and a caller whose write must be the only one checks it just before writing. A lock that isn't this call's
// is never removed when fn ends. Such a folder renamed away (<name>.lock.stale-<hex>) is kept for a day, so its
// inode can't be taken by a new lock while the process that made it may still look; once it is a day old it is
// removed the next time any lock is taken.
import { mkdirSync, rmdirSync, renameSync, statSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { home } from './paths.mjs';

// How long a lock folder renamed away is kept: no lock is held anywhere near this long.
export const STALE_KEEP_MS = 24 * 60 * 60 * 1000;
const STALE_NAME = /\.lock\.stale-[0-9a-f]{12}$/;

export function withLock(name, fn, { waitMs = 8000, staleMs = 5000 } = {}) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const lock = join(home(), `${name}.lock`);
  const t0 = Date.now();
  let mine;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const st = lstatSync(lock);
      mine = `${st.dev}:${st.ino}`;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          const gone = `${lock}.stale-${randomBytes(6).toString('hex')}`;
          renameSync(lock, gone);
          // The one seen old is removed. Anything else renamed away (another process broke the old one and took a new
          // lock in between) stays where it is, under its own name: that process sees its lock is gone.
          const now = lstatSync(gone);
          if (now.ino === st.ino && now.mtimeMs === st.mtimeMs) rmdirSync(gone);
        }
      } catch {
        /* another process broke or released it */
      }
      if (Date.now() - t0 > waitMs) throw new Error(`another floorboss process is busy with ${name}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  sweepStale();
  const owned = () => {
    try {
      const st = lstatSync(lock);
      return `${st.dev}:${st.ino}` === mine;
    } catch {
      return false;
    }
  };
  try {
    return fn({ owned });
  } finally {
    try {
      if (owned()) rmdirSync(lock);
    } catch {
      /* gone */
    }
  }
}

// Several locks for one check (a send to a person known by more than one address takes one per address): taken one
// after the other in one fixed order (sorted by name, so two callers can never each hold a lock the other waits for),
// within one wait between them all. owned() is true only while every one is still this call's.
export function withLocks(names, fn, { waitMs = 8000, staleMs = 5000 } = {}) {
  const order = [...new Set(names)].sort();
  const t0 = Date.now();
  const held = [];
  const take = (i) =>
    i === order.length
      ? fn({ owned: () => held.every((o) => o()) })
      : withLock(
          order[i],
          ({ owned }) => {
            held.push(owned);
            return take(i + 1);
          },
          { waitMs: Math.max(0, waitMs - (Date.now() - t0)), staleMs }
        );
  return take(0);
}

// Lock folders renamed away (<name>.lock.stale-<hex>) whose folder was made over STALE_KEEP_MS ago (by its time, which
// a rename doesn't change) are removed; a live lock (<name>.lock) and anything younger are left. Never fails a lock.
function sweepStale(nowMs = Date.now()) {
  try {
    for (const f of readdirSync(home())) {
      if (!STALE_NAME.test(f)) continue;
      try {
        const st = lstatSync(join(home(), f));
        if (st.isDirectory() && nowMs - st.mtimeMs > STALE_KEEP_MS) rmdirSync(join(home(), f));
      } catch {
        /* gone, or not empty: left */
      }
    }
  } catch {
    /* the folder can't be listed: nothing removed */
  }
}
