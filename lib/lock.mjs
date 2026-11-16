// One process at a time for a check and the write that depends on it (the lookup count, the lookup window, a send to
// one address, an event's outbox page): a lock folder in floorboss's data folder, taken by mkdir, waited for up to 8
// seconds, and by default broken when over 5 seconds old (staleMs), whether its holder died or is still running (a
// caller can wait longer for a live holder: liveMs). The holder writes its process id inside it: a waiter breaks a
// lock whose holder is gone (killed, crashed) at once, without waiting for it to grow old. It is broken by renaming it
// away and removing the renamed folder only when it is the one seen. A folder renamed away that turns out to be
// another process's new lock is never put back (putting it back could land on a third process's lock): the process
// that took it finds it gone. So fn is given owned(), true only while the lock folder is still the one this call
// made, and a caller whose write must be the only one checks it just before writing. A lock that isn't this call's
// is never removed when fn ends. Such a folder renamed away (<name>.lock.stale-<hex>) is kept for a day, so its
// inode can't be taken by a new lock while the process that made it may still look; once it is a day old it is
// removed the next time any lock is taken.
import { mkdirSync, rmdirSync, renameSync, statSync, lstatSync, readdirSync, writeFileSync, readFileSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { home } from './paths.mjs';

// How long a lock folder renamed away is kept: no lock is held anywhere near this long.
export const STALE_KEEP_MS = 24 * 60 * 60 * 1000;
const STALE_NAME = /\.lock\.stale-[0-9a-f]{12}$/;

// The holder's process id, kept in the lock folder.
const PID = 'pid';
// Whether the process that wrote this lock is gone: true, false, or null when the lock holds no id: one taken a moment
// ago, before its holder wrote it; one whose holder was killed between making the id file and writing it (an empty
// file); or one made by an older version.
function holderGone(lock) {
  let text;
  try {
    text = readFileSync(join(lock, PID), 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^\d{1,10}$/.test(text) || Number(text) <= 1) return null;
  const pid = Number(text);
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}
// A lock folder taken away: its id file first, so the folder is empty.
export function removeLock(dir) {
  try {
    unlinkSync(join(dir, PID));
  } catch {
    /* none */
  }
  rmdirSync(dir);
}

// orphanMs: a lock with no id in it is broken once this old (its holder writes the id right after taking it, so one
// still without it is left over). By default it waits for staleMs like any other. liveMs: a lock whose holder is still
// running is broken only once this old (by default staleMs, as for any other); a holder doing long work keeps its lock
// young with the beat it is given (fn({ owned, beat })).
export function withLock(name, fn, { waitMs = 8000, staleMs = 5000, orphanMs = staleMs, liveMs = staleMs } = {}) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const lock = join(home(), `${name}.lock`);
  const t0 = Date.now();
  let mine;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      const st = lstatSync(lock);
      mine = `${st.dev}:${st.ino}`;
      try {
        writeFileSync(join(lock, PID), String(process.pid), { mode: 0o600, flag: 'wx' });
      } catch {
        /* the age rule still holds for it */
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = statSync(lock);
        const age = Date.now() - st.mtimeMs;
        const gone = holderGone(lock);
        if (gone === true || (gone === null && (age > orphanMs || age > staleMs)) || (gone === false && age > liveMs)) {
          const away = `${lock}.stale-${randomBytes(6).toString('hex')}`;
          renameSync(lock, away);
          // The one seen is removed. Anything else renamed away (another process broke the old one and took a new
          // lock in between) stays where it is, under its own name: that process sees its lock is gone.
          const now = lstatSync(away);
          if (now.ino === st.ino && now.mtimeMs === st.mtimeMs) removeLock(away);
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
  // The holder's beat: the lock's time moved to now, so a waiter sees it as young. Only while it is still this call's.
  const beat = () => {
    try {
      if (!owned()) return;
      const t = new Date();
      utimesSync(lock, t, t);
    } catch {
      /* gone: nothing to keep young */
    }
  };
  try {
    return fn({ owned, beat });
  } finally {
    try {
      if (owned()) removeLock(lock);
    } catch {
      /* gone */
    }
  }
}

// Several locks for one check (a send to a person known by more than one address takes one per address): taken one
// after the other in one fixed order (sorted by name, so two callers can never each hold a lock the other waits for),
// within one wait between them all. owned() is true only while every one is still this call's; beat() keeps them all
// young.
export function withLocks(names, fn, { waitMs = 8000, ...rest } = {}) {
  const order = [...new Set(names)].sort();
  const t0 = Date.now();
  const held = [];
  const take = (i) =>
    i === order.length
      ? fn({ owned: () => held.every((h) => h.owned()), beat: () => held.forEach((h) => h.beat()) })
      : withLock(
          order[i],
          ({ owned, beat }) => {
            held.push({ owned, beat });
            return take(i + 1);
          },
          { ...rest, waitMs: Math.max(0, waitMs - (Date.now() - t0)) }
        );
  return take(0);
}

// Lock folders renamed away (<name>.lock.stale-<hex>) whose folder was made over STALE_KEEP_MS ago (by its time, which
// a rename doesn't change) are removed, with the holder's id file in them; a live lock (<name>.lock), anything younger
// and a folder holding anything else are left. Never fails a lock.
function sweepStale(nowMs = Date.now()) {
  try {
    for (const f of readdirSync(home())) {
      if (!STALE_NAME.test(f)) continue;
      try {
        const dir = join(home(), f);
        const st = lstatSync(dir);
        if (!st.isDirectory() || nowMs - st.mtimeMs <= STALE_KEEP_MS) continue;
        const inside = readdirSync(dir);
        if (inside.every((n) => n === PID)) removeLock(dir);
      } catch {
        /* gone, or can't be removed: left */
      }
    }
  } catch {
    /* the folder can't be listed: nothing removed */
  }
}
