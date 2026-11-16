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
import { listed, releasedSends, stageBatch } from './sends.mjs';
import { rawValue } from './witness.mjs';
import { append as appendLedger } from '../../lib/ledger.mjs';
import { openWindow, openLogWindow, windowKey, sameCall } from './browser.mjs';
import { check } from './check.mjs';

// What a send or draft tool answered for one listed step, as the guard reads the raw answer (never Claude's report of
// it): the message id and the thread (a draft's id too), appended to that event's ledger as call_result. A send
// answers the message itself (id, threadId); a draft answers the draft (id) with its message (message.id,
// message.threadId) or its thread (threadId). Nothing is written when the answer names none of them. True if written.
function recordResult(item, kind, input, tool, nowMs) {
  const r = rawValue(input?.tool_response);
  if (!r.ok || !r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return false;
  const v = r.value;
  const one = (...xs) => {
    const x = xs.find((y) => (typeof y === 'string' && y.trim()) || (typeof y === 'number' && Number.isFinite(y)));
    return x == null ? null : String(x).slice(0, 200);
  };
  const message_id = kind === 'send' ? one(v.id, v.message?.id, v.message_id, v.messageId) : one(v.message?.id, v.message_id, v.messageId);
  const thread_id = one(v.threadId, v.message?.threadId, v.thread_id, v.conversationId);
  const draft_id = kind === 'draft' ? one(v.id, v.draft_id, v.draftId) : null;
  if (!message_id && !thread_id) return false;
  appendLedger(
    join(home(), 'events', item._event, 'ledger.jsonl'),
    { type: 'call_result', who: 'guard', id: item.id, touch: item.touch ?? 1, kind, message_id, thread_id, ...(draft_id ? { draft_id } : {}), tool: String(tool).slice(0, 120) },
    new Date(nowMs)
  );
  return true;
}

// A staged draft's call as the pre hook let it through (hooks/guard.mjs): its event, its step and the call mark it took,
// noted by tool_use_id. Its prompt can be answered long after its stage list (past the list's 30 minutes) or after the
// list was written again, and the list then no longer matches the call; the note still says which mark is this call's.
const stageCallDir = () => join(home(), 'stage-calls');
// The note needs Claude Code's id for the call (tool_use_id), so a staged draft's call that comes with none is refused,
// with the user there or not (hooks/guard.mjs, hooks/guard/unattended.mjs).
export const NO_CALL_ID = "Claude Code didn't give this draft call an id (tool_use_id), and floorboss keeps track of each draft call by it: update Claude Code, then try again";
export const hasCallId = (input) => typeof input?.tool_use_id === 'string' && input.tool_use_id.trim() !== '';
export function noteStageCall(callId, note, nowMs) {
  writeText(join(stageCallDir(), callNote(callId)), JSON.stringify({ ...note, at: new Date(nowMs).toISOString() }));
}
// This call's note, used once (it goes), or null. Notes over a day old (a prompt declined, a call that failed) go too.
function takeStageNote(input, nowMs) {
  const dir = stageCallDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => /^[0-9a-f]{32}$/.test(f));
  } catch {
    return null;
  }
  const id = String(input?.tool_use_id || '');
  const mine = id ? callNote(id) : null;
  let note = null;
  for (const f of names) {
    let v = null;
    try {
      v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      v = null;
    }
    if (f === mine) note = v;
    if (f === mine || !v || !recent(v.at, nowMs, 864e5))
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* gone */
      }
  }
  if (!note || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(note.event || '')) || !/^c\d+$/.test(String(note.id || '')) || !Number.isInteger(note.touch)) return null;
  if (!new RegExp(`^stage-call-${note.id}-${note.touch}-[0-9a-f]{24}-[1-9]\\d*$`).test(String(note.mark || ''))) return null;
  return note;
}

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
  // A send floorboss let through, and that ran: the tool's own answer names the message and its thread (Gmail's
  // send_message answers id and threadId). Recorded for that step (call_result), so a follow-up can go in reply to it.
  if (config.connectors?.['email.send']) {
    const sentNow = [];
    if (!check(input, { config, sendItems: releasedSends(), sent: sentNow }) && sentNow[0]?.via === 'email.send' && sentNow[0]._event) {
      if (recordResult(sentNow[0], 'send', input, m[2], nowMs)) out.send_result = `${sentNow[0].id}:${sentNow[0].touch}`;
    }
  }
  const staged = [];
  const onList = !!config.connectors?.stage_draft && !check(input, { config, stageItems: listed('stage-list.json', nowMs), staged }) && !!staged[0];
  if (onList) {
    if (staged[0]._event && recordResult(staged[0], 'draft', input, m[2], nowMs)) out.draft_result = `${staged[0].id}:${staged[0].touch ?? 1}`;
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
  // The draft call this one is, as its pre hook noted it: it ran, so its mark is done (a draft of that step went in:
  // lib/unattended-drafts.mjs attendedDraftIn keeps an unattended one of the step out, whatever text it is for, until its
  // receipt is saved or you say it isn't there), and its answer is recorded when the list no longer matched it.
  const noted = config.connectors?.stage_draft ? takeStageNote(input, nowMs) : null;
  if (noted) {
    const mark = join(home(), 'events', noted.event, 'released', noted.mark);
    if (existsSync(mark))
      try {
        writeFileSync(`${mark}.done`, new Date(nowMs).toISOString(), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    if (!onList && recordResult({ _event: noted.event, id: noted.id, touch: noted.touch }, 'draft', input, m[2], nowMs)) out.draft_result = `${noted.id}:${noted.touch}`;
  }
  return out;
}

// PostToolUseFailure, with the user there: a staged draft's call that was let through (its prompt, if any, allowed)
// and then failed may still have put the draft in (a mail tool can make it and time out after). Its call mark, as its
// pre hook noted it, gets <mark>.failed: lib/unattended-drafts.mjs attendedDraftIn then holds an unattended draft of
// that step (whatever text it is for) as "may or may not be in your drafts" until its receipt is saved or you say it
// isn't there (outreach draft-missing). Nothing else is recorded: a failed call confirmed nothing.
export function afterCallFailure(input, nowMs = clockNow()) {
  if (!/^mcp__/.test(String(input?.tool_name || ''))) return {};
  const config = readJsonStrict(join(home(), 'config.json'), {});
  const noted = config.connectors?.stage_draft ? takeStageNote(input, nowMs) : null;
  if (!noted) return {};
  const mark = join(home(), 'events', noted.event, 'released', noted.mark);
  if (!existsSync(mark)) return {};
  try {
    writeFileSync(`${mark}.failed`, new Date(nowMs).toISOString(), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { failed: `${noted.id}:${noted.touch}` };
}
