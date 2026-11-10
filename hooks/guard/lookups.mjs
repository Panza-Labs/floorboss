// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Contact-detail lookups (the people-data server): the window the user agreed to, how many lookups it has
// left, and what one lookup may carry.
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { sameServer } from '../../lib/security.mjs';
import { bareToolName } from '../../skills/connectors/scripts/tasks.mjs';
import { createHash } from 'node:crypto';
import { nowMs as clockNow } from '../../lib/clock.mjs';
import { recent } from './shared.mjs';
import { plainServerRead } from './connectors.mjs';

export function enrichServerTool(config, server, tool) {
  const r = config?.connectors?.['enrich.person'];
  if (!r || !r.server || !sameServer(server, r.server)) return null;
  const ro = (Array.isArray(r.read_only_tools) ? r.read_only_tools : []).map(String).filter(plainServerRead);
  if (bareToolName(r.tool) === tool || ro.includes(tool)) return null;
  return r;
}
// The lookup window, for the recipe's tool and every other tool on its server: open, not used up, and the
// first lookup of the window asks the user. `used` counts lookups that ran (the PostToolUse hook adds one
// after each), never ones only asked about: a "no" at the first prompt leaves it at 0, so the next asks again.
// The window's numbers as the file has them, read strictly: an end that isn't a date is a closed window,
// a count or used that isn't a whole number is its floor (anything else 0), and ids differing only by case
// or spaces are one person.
const wholeOf = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
export const windowUsed = (w) => wholeOf(w?.used);
export const windowOpen = (w, nowMs) => !!w && !w.closed && Number.isFinite(Date.parse(w.until)) && Date.parse(w.until) >= nowMs;
export const windowAllowed = (w) =>
  Math.min(wholeOf(w?.count), Array.isArray(w?.ids) ? new Set(w.ids.map((x) => String(x).trim().toLowerCase()).filter(Boolean)).size : 0);
// What a lookup carries: one person from the lookup window (the shortlisted people with no email, written by
// floorboss's script when the user agreed), by their own name, company, title or profile link, or their
// company's domain. Anything else (a CRM note, a link, another person) is no lookup.
export function enrichArgRefusal(values, enrichWindow) {
  const people = Array.isArray(enrichWindow?.people) ? enrichWindow.people : [];
  const vals = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!vals.length) return null;
  if (!people.length) return 'the lookup window names no people to look up; floorboss asks again before any lookup.';
  const low = (x) =>
    String(x ?? '')
      .trim()
      .toLowerCase();
  const fits = (p, v) => {
    const parts = low(p.name).split(/\s+/).filter(Boolean);
    const known = [p.name, p.company, p.title, p.profile_url, parts[0], parts.slice(1).join(' '), parts[parts.length - 1]].map(low).filter(Boolean);
    if (known.includes(low(v))) return true;
    const slug = low(p.company).replace(/[^a-z0-9]/g, '');
    return (
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) &&
      v.length <= 80 &&
      slug.length >= 3 &&
      low(v)
        .replace(/[^a-z0-9]/g, '')
        .includes(slug.slice(0, 12))
    );
  };
  if (people.some((p) => vals.every((v) => fits(p, v)))) return null;
  return 'a lookup carries one listed person (their name, company, title, profile link or company domain) and nothing else.';
}
export function enrichRefusal(r, server, tool, enrichWindow, asks, enrichUsed, own, values = []) {
  const nowMs = clockNow();
  const where = `${r.server || server}/${tool}`;
  if (!windowOpen(enrichWindow, nowMs)) {
    return own
      ? `a lookup in ${r.server || 'the people-data tool'} spends your credits, and you haven't agreed to any right now: floorboss asks first, with how many.`
      : `${tool} on ${server} isn't the lookup tool floorboss set up (${r.tool}), and a call there can spend your credits: floorboss lets it run only inside a lookup window you agreed to.`;
  }
  // Never more lookups than the people the window names (the shortlisted people with no email when the
  // user answered, each once), whatever count the file says.
  const allowed = windowAllowed(enrichWindow);
  const used = windowUsed(enrichWindow);
  // Lookups let through in this window that haven't finished count too, so several started at once can't pass the
  // count, before the first one ran (each of those asks) as after.
  const outstanding = enrichNotes(enrichWindow.until, nowMs).length;
  if (used + outstanding >= allowed) return lookupsGone(allowed, used, outstanding);
  {
    const why = enrichArgRefusal(values, enrichWindow);
    if (why) return why;
  }
  // The yes that opened the window came through an answer file Claude writes: until one lookup has run, each
  // asks the user, with the tool and the count; after that the rest of the count goes without asking.
  if (!(used > 0))
    asks.push(
      `floorboss: look people up in ${where}.${own ? '' : ` This isn't the lookup tool floorboss set up (${r.tool}), but it is on the same server and can spend credits too.`} Each lookup can spend a credit. This window allows ${allowed} lookup${allowed === 1 ? '' : 's'} (the people on your shortlist with no email), in the next ${Math.max(1, Math.round((Date.parse(enrichWindow.until) - nowMs) / 60000))} minutes; this is the first${outstanding ? ` (${outstanding} other${outstanding === 1 ? '' : 's'} already asked and not run count${outstanding === 1 ? 's' : ''} too)` : ''}. ${allowed - 1 - outstanding > 0 ? `Allowing it lets the other ${allowed - 1 - outstanding} go without asking again; ` : ''}if you decline, nothing is looked up, but this lookup still counts as one of the ${allowed} until the window ends (floorboss can't see a decline).`
    );
  enrichUsed.push(1);
  return null;
}

// Why no more lookups go in this window: the agreed number ran, or some of it is held by lookups let through that
// haven't run (waiting at a prompt, or declined, failed or stopped: floorboss can't tell which).
export function lookupsGone(allowed, used, waiting) {
  const n = (k) => `${k} lookup${k === 1 ? '' : 's'}`;
  return waiting
    ? `you agreed to ${n(allowed)} in this window: ${used} ran and ${waiting} ${waiting === 1 ? 'was' : 'were'} let through without running yet (waiting at a prompt, or declined, failed or stopped), and those count until the window ends. floorboss asks again before any more.`
    : `you agreed to ${n(allowed)} and they're used up; floorboss asks again before any more.`;
}
// Lookups let through and not run yet: one note per call (by its tool_use_id), in a folder. A note counts against
// its window until the window is replaced (floorboss can't tell a call declined at its prompt from one still
// waiting there, so it holds a slot rather than risk one too many), and goes after a day.
export const enrichPendingDir = () => join(home(), 'enrich-pending');
export const callNote = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
export function enrichNotes(until, nowMs) {
  const dir = enrichPendingDir();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!/^[0-9a-f]{32}$/.test(f)) continue;
    let v = null;
    try {
      v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue; // gone (another hook took it) or half there
    }
    if (v && v.until === until && recent(v.at, nowMs, 864e5)) out.push({ ...v, file: join(dir, f) });
    else
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* gone */
      }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
