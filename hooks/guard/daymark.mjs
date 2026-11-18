// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// One message a day to one person at an event, held by an exclusive file per person and day (the event's day) in the
// event's folder, taken in the same step as the release, before the call runs: two calls at the same moment can't
// both hold one. Across events the guard holds a person to one message a day under a lock per address, one for each
// address the person has at the sending event (sendLocks), checking every event's ledger again inside them
// (lib/sendcheck.mjs addressBusyToday): two events in zones on different dates have different days, so no file named
// by a day could hold them to one.
import { writeFileSync, readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lockKey, personAddressKeys } from '../../lib/sendcheck.mjs';

// The marker path for a message's person and day, in the event's folder.
export const dayMarker = (evDir, it, day) => join(evDir, 'released', `${it.id}-day-${day}`);
// The lock a send to this address is checked and released under (lib/lock.mjs, in floorboss's home folder): one per
// address, case and spaces aside, and one for a profile link however it is written (lib/sendcheck.mjs lockKey).
export const sendLock = (to) => `send-${createHash('sha256').update(lockKey(to)).digest('hex').slice(0, 24)}`;
// The locks a message to this person is checked and released under: one for the address it goes to and one for every
// other address the person has alone at this event (lib/sendcheck.mjs personAddressKeys: an address another person's
// line there has too is locked only when the message goes to it, and an inbox address like info@ is locked with the
// person's name, and on its own only when the message goes to it), in one sorted order (lib/lock.mjs
// withLocks). Two calls for one person under two addresses share a lock whenever their two events share an address
// for that person (the rule addressBusyToday counts by), so they are checked one after the other, and the second sees
// the first.
export const sendLocks = (evDir, id, to) => [...new Set([sendLock(to), ...personAddressKeys(evDir, id, to).map(sendLock)])].sort();

// The ledger entries that clear a step's day marker (a release cleared, or a bounce): the "<resets>" a marker's owner
// is written with, and what counts as cleared since. One rule for the attended send and the unattended draft, so
// neither reads the other's day marker as cleared when it wasn't. (Your word that an unattended draft isn't in your
// drafts folder, stage_cleared, makes a new once mark for that draft, hooks/guard/unattended.mjs RESETS, but frees no
// day: that draft can't go in on its own again on the day the first one was let through, only on a later day. The attended send's message marker, released/<id>-<touch>-<n>, is named by
// the same rule, as lib/sendcheck.mjs markerOnly reads it.)
export const DAY_RESETS = ['release_cleared', 'bounced'];
export const dayResetsOf = (entries, id, touch) => (entries || []).filter((e) => e?.id === id && e.touch === touch && DAY_RESETS.includes(e.type)).length;

// The owner written in a marker: "<event>:<id>:<touch>:<resets>" (resets: how many times that step's release was
// cleared when it was taken). Read strictly: anything else is no owner floorboss wrote.
export const ownerOf = (slug, it, resets) => `${slug}:${it.id}:${it.touch}:${resets}`;
function parseOwner(text) {
  const m = /^([a-z0-9][a-z0-9-]{0,63}):(c\d+):(\d+):(\d+)$/.exec(text);
  return m ? { slug: m[1], id: m[2], touch: Number(m[3]), resets: Number(m[4]) } : null;
}

// Takes a marker for `owner`: the path of the file this call made (to give back with dropMarkers), or null when the
// day is taken. A marker already there frees the day only for the same message, and only once that message's release
// was cleared since (cleared(o): how many clears that message has now). Nothing is ever renamed or removed to re-take:
// each re-take is a new file next in a chain (<path>~1, <path>~2, ...), made with wx, so of two callers who judge the
// same marker cleared only one can make the next link, and the other reads that link and is refused. A symlink, a
// directory, or text that isn't an owner floorboss wrote, anywhere in the chain, reads as taken.
export function takeMarker(path, owner, cleared) {
  const now = parseOwner(owner);
  if (!now) return null;
  if (create(path, owner)) return path;
  for (let n = 1; n < 1000; n++) {
    const cur = n === 1 ? path : `${path}~${n - 1}`;
    const next = `${path}~${n}`;
    const was = readOwner(cur);
    if (!was) return null;
    if (present(next)) continue;
    if (!frees(was, now, cleared)) return null;
    if (create(next, owner)) return next;
    // Another caller made that link first: judge theirs (the loop reads it next).
  }
  return null;
}
// Whether the marker `was` frees the day for `now`: the same message, and its release cleared since it was taken.
const frees = (was, now, cleared) => was.slug === now.slug && was.id === now.id && was.touch === now.touch && cleared(was) > was.resets;
// Whether takeMarker would take a marker for `owner` now, read only (nothing made): the launcher asks this before it
// spends a run on a draft the guard would refuse for its day (scripts/scheduled.mjs followupsDue).
export function markerFree(path, owner, cleared) {
  const now = parseOwner(owner);
  if (!now) return false;
  if (!present(path)) return true;
  for (let n = 1; n < 1000; n++) {
    const cur = n === 1 ? path : `${path}~${n - 1}`;
    const was = readOwner(cur);
    if (!was) return false;
    if (present(`${path}~${n}`)) continue;
    return frees(was, now, cleared);
  }
  return false;
}
function create(path, owner) {
  try {
    writeFileSync(path, owner, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
// A marker's owner, or null for anything that isn't a plain file holding one (a symlink is never followed).
function readOwner(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return parseOwner(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Gives back markers this call took (a refused call, or a release that couldn't be written).
export function dropMarkers(paths) {
  for (const p of paths)
    try {
      unlinkSync(p);
    } catch {
      /* gone */
    }
}
