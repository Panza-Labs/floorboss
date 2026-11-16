// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// afterCall(): what is recorded once a call has run (PostToolUse).
import { readFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { sameServer } from '../../lib/security.mjs';
import { bareToolName } from '../../skills/connectors/scripts/tasks.mjs';
import { taskMark } from '../../lib/sendcheck.mjs';
import { withLock } from '../../lib/lock.mjs';
import { renameSync } from 'node:fs';
import { writeText } from '../../lib/jsonio.mjs';
import { nowMs as clockNow } from '../../lib/clock.mjs';
import { readJsonStrict, recent } from './shared.mjs';
import { isBrowser } from './connectors.mjs';
import { markOnce } from './test-calls.mjs';
import { enrichServerTool, enrichNotes, enrichPendingDir, callNote, windowUsed } from './lookups.mjs';
import { listed, stageBatch } from './sends.mjs';
import { openWindow, openLogWindow, windowKey, sameCall } from './browser.mjs';
import { check } from './check.mjs';

// PostToolUse: the call ran, so the user said yes to any prompt it had (a call declined at the prompt never
// runs and never gets here). Only now is the ask recorded: a lookup counted against its window, and a staged
// draft's batch confirmed so the rest of it goes without asking. The PreToolUse check never reads a file it
// wrote itself: it reads only what this writes. Returns what it recorded.
export function afterCall(input, nowMs = clockNow()) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m) return {};
  const config = readJsonStrict(join(home(), 'config.json'), {});
  const out = {};
  // A browser window's first call ran after the user allowed it: the window is allowed until it closes.
  const wp = join(home(), 'window-pending.json');
  const wpend = readJsonStrict(wp, null);
  if (wpend && isBrowser(m[1], m[2])) {
    const bs = openWindow(nowMs);
    const cl = bs ? null : openLogWindow(nowMs);
    const now = bs ? windowKey('send', bs) : cl ? windowKey('log', cl) : null;
    if (now && wpend.key === now && recent(wpend.at, nowMs, 10 * 60000) && sameCall(wpend, input)) {
      writeText(join(home(), 'window-asked.json'), JSON.stringify({ key: now, at: new Date(nowMs).toISOString() }));
      out.window_allowed = now;
    }
    try {
      unlinkSync(wp);
    } catch {
      /* gone */
    }
  }
  const r = config.connectors?.['enrich.person'];
  if (r && ((bareToolName(r.tool) === m[2] && (!r.server || sameServer(m[1], r.server))) || enrichServerTool(config, m[1], m[2]))) {
    const p = join(home(), 'enrich-window.json');
    const w = readJsonStrict(p, null);
    // One pre hook, at most one post: each post uses its own call's note (by tool_use_id; without one, the
    // oldest note with no id), and the note goes. A post run again, or one for a call an old window let through,
    // counts nothing. Under the lock, so posts at once each add their one.
    const count = () => {
      const now = readJsonStrict(p, null);
      if (!now || now.closed || now.until !== w.until) return;
      const id = String(input?.tool_use_id || '');
      const notes = enrichNotes(now.until, nowMs);
      const note = id ? notes.find((x) => x.file === join(enrichPendingDir(), callNote(id))) : notes.find((x) => !x.call);
      if (!note) return;
      // Claimed by renaming it (only one post can), counted, then removed; if the count can't be written, the note
      // goes back for the retry.
      const claimed = `${note.file}.counting`;
      try {
        renameSync(note.file, claimed);
      } catch {
        return;
      }
      try {
        writeText(p, JSON.stringify({ ...now, used: windowUsed(now) + 1 }));
      } catch (e) {
        renameSync(claimed, note.file);
        throw e;
      }
      unlinkSync(claimed);
      out.counted = true;
    };
    // A lookup that ran is counted even when the lock can't be had twice over (a stuck hook holding it): counted
    // without the lock, two posts at once could still make one count, but none is dropped outright.
    if (w && !w.closed)
      try {
        withLock('enrich', count);
      } catch {
        try {
          withLock('enrich', count);
        } catch {
          count();
        }
      }
  }
  // A CRM task the guard let through and that ran: marked, so a receipt for it (tasks-created) is one floorboss can
  // trust. A receipt for a task with no mark (declined, never made) is refused.
  // The task is the one the pre hook matched for this call (its note, by tool_use_id, up to a day old); without an
  // id, the listed task the call matches now.
  if (config.connectors?.['crm.create_task']) {
    let made = null;
    const id = String(input?.tool_use_id || '');
    // Notes over a day old (a task declined at its prompt) go.
    try {
      for (const f of readdirSync(join(home(), 'task-pending')).filter((f) => /^[0-9a-f]{32}$/.test(f)))
        try {
          if (!recent(JSON.parse(readFileSync(join(home(), 'task-pending', f), 'utf8')).at, nowMs, 864e5)) unlinkSync(join(home(), 'task-pending', f));
        } catch {
          try {
            unlinkSync(join(home(), 'task-pending', f));
          } catch {
            /* gone */
          }
        }
    } catch {
      /* none */
    }
    if (id) {
      const np = join(home(), 'task-pending', callNote(id));
      const note = readJsonStrict(np, null);
      if (note?.key && /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(note.event || '')) && recent(note.at, nowMs, 864e5))
        made = { key: note.key, _event: note.event };
      try {
        unlinkSync(np);
      } catch {
        /* none */
      }
    } else {
      const madeTasks = [];
      if (!check(input, { config, taskItems: listed('task-list.json'), tasks: madeTasks }) && madeTasks[0]?.key && madeTasks[0]._event) made = madeTasks[0];
    }
    if (made) {
      const rdir = join(home(), 'events', made._event, 'released');
      mkdirSync(rdir, { recursive: true, mode: 0o700 });
      try {
        markOnce(join(rdir, `task-${taskMark(made.key)}`), nowMs);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      out.task_made = made.key;
    }
  }
  const staged = [];
  if (config.connectors?.stage_draft && !check(input, { config, stageItems: listed('stage-list.json', nowMs), staged }) && staged[0]) {
    const evDir = join(home(), 'events', staged[0]._event);
    const batch = stageBatch(evDir);
    const sp = join(evDir, 'stage-pending.json');
    const pending = readJsonStrict(sp, null);
    // The batch the prompt was about, still the list floorboss wrote: a list replaced since is a new batch.
    // As with a lookup, the note is used once and only while it is under 10 minutes old.
    if (pending?.batch === batch && recent(pending.at, nowMs, 10 * 60000) && sameCall(pending, input)) {
      writeText(join(evDir, 'stage-asked.json'), JSON.stringify({ batch, first: pending.first, at: new Date(nowMs).toISOString() }));
      out.stage_confirmed = batch;
    }
    // A draft of a confirmed batch went in: it counts as that message's one for the batch. Marked before the call
    // marker's .done below, so no moment exists where a repeat call finds the call done but the draft not marked.
    const asked = readJsonStrict(join(evDir, 'stage-asked.json'), null);
    if (asked?.batch === batch) {
      const it = staged[0];
      const rdir = join(evDir, 'released');
      mkdirSync(rdir, { recursive: true, mode: 0o700 });
      try {
        markOnce(join(rdir, `stage-${it.id}-${it.touch ?? 1}-${batch}`), nowMs);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    // The call ran: the guard's latest call marker for this draft is no longer one going in now (hooks/guard.mjs).
    {
      const it = staged[0];
      const callMark = (n) => join(evDir, 'released', `stage-call-${it.id}-${it.touch ?? 1}-${batch}-${n}`);
      let n = 0;
      while (existsSync(callMark(n + 1))) n++;
      if (n > 0)
        try {
          writeFileSync(`${callMark(n)}.done`, new Date(nowMs).toISOString(), { flag: 'wx', mode: 0o600 });
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
    }
    if (pending)
      try {
        unlinkSync(sp);
      } catch {
        /* gone */
      }
  }
  return out;
}
