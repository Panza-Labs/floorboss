// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// reach-changed --event <slug> --before <json list or null>: the user changed where floorboss reaches people
// (reach_channels). Every approved step that hasn't gone and whose place in the person's sequence is now on another
// channel, or gone, stops being approved: it leaves the outbox and every list, and is written again for its new place
// (or not at all). A step that went, or was let through, is never touched. Returns one line for the user.
import { need } from '../../../../lib/args.mjs';
import { personRoute, plannedStep, stepLabel } from '../../../../lib/route.mjs';
import { ctxOf, led } from './context.mjs';
import { rebuildOutbox } from './cards.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { eventDir } from '../../../../lib/paths.mjs';

// The choice the event's approvals were last checked against (derived/reach-seen.json).
const seenFile = (slug) => join(eventDir(slug), 'derived', 'reach-seen.json');
const same = (a, b) => (a == null && b == null) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x)));

// Run where the route is read (todo, send-list, stage-list): a choice changed since the last check, by the answer or
// by a hand edit of the settings, takes back what it moved, as reach-changed does. Returns its line, or null.
export function syncReach(slug, opts = {}) {
  const f = seenFile(slug);
  let now;
  try {
    now = ctxOf(slug, opts).settings.reach ?? null;
  } catch {
    return null;
  }
  if (!existsSync(f)) {
    try {
      writeJson(f, { reach: now });
    } catch {}
    return null;
  }
  const seen = readJson(f, {})?.reach ?? null;
  if (same(seen, now)) return null;
  return reachChanged({ ...opts, event: slug, before: JSON.stringify(seen) }).line;
}

export function reachChanged(opts) {
  need(opts, 'event');
  let before = null;
  try {
    before = JSON.parse(String(opts.before ?? 'null'));
  } catch {}
  const c = ctxOf(opts.event, opts);
  const old = { ...c.settings, reach: Array.isArray(before) ? before : null };
  const off = {},
    moved = { n: 0 };
  for (const [id, p] of Object.entries(c.folded.people || {})) {
    const ct = c.byId[id];
    if (!ct) continue;
    const pick = c.triage.channels?.[id] || null;
    const was = personRoute(ct, c.event, old, pick);
    const now = personRoute(ct, c.event, c.settings, pick);
    for (const [k, x] of Object.entries(p.touches || {})) {
      const t = Number(k);
      if (t < 1 || !x?.approved || x.sent || x.released || x.staged || x.stage_released) continue;
      const step = plannedStep(x, was?.[t - 1]) || 'email';
      const chosen = (st) => st === 'email' || !Array.isArray(c.settings.reach) || c.settings.reach.includes(st);
      if ((was?.[t - 1] || null) === (now?.[t - 1] || null) && chosen(step)) continue;
      led(c, { type: 'approval_withdrawn', who: 'floorboss', id, touch: t, reason: 'the channels to reach people on changed' });
      if (step !== 'email' && !(c.settings.reach || []).includes(step)) off[step] = (off[step] || 0) + 1;
      else moved.n++;
    }
  }
  const parts = Object.entries(off).map(([s, n]) => `${plural(n, s === 'linkedin' ? 'LinkedIn message' : `${stepLabel(s, c.event)} note`, s === 'linkedin' ? 'LinkedIn messages' : `${stepLabel(s, c.event)} notes`)}`);
  const any = parts.length || moved.n;
  if (any) rebuildOutbox(opts.event, opts);
  const line = !any
    ? null
    : `${parts.length ? `${parts.join(' and ')} ${Object.values(off).reduce((a, b) => a + b, 0) === 1 ? 'is' : 'are'} taken off` : ''}${parts.length && moved.n ? '; ' : ''}${moved.n ? `${plural(moved.n, 'approved follow-up')} ${moved.n === 1 ? 'moves' : 'move'} to another place in the sequence and ${moved.n === 1 ? 'is' : 'are'} written again for it` : ''}; nothing else changes.`;
  try {
    writeJson(seenFile(opts.event), { reach: c.settings.reach ?? null });
  } catch {}
  return { withdrawn: Object.values(off).reduce((a, b) => a + b, 0) + moved.n, line: line ? line[0].toUpperCase() + line.slice(1) : null };
}
