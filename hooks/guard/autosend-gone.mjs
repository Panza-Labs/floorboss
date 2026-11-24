// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The auto-send script in Claude Code, for the main session only (audit run 11, owner's approval 2026-11-22):
//   - a subagent never runs the auto-send verbs that change state (as it never sends);
//   - draft-gone (a stopped daily-routine draft the user says is in neither Gmail Sent nor Drafts) asks the user,
//     showing their words and the person, modelled on draft-missing's ask (hooks/guard/unattended.mjs). Refused for a
//     draft not yet past its day: its delete step settles it.
import { join } from 'node:path';
import { home, allowedPath, readChecked } from '../../lib/paths.mjs';
import { SLUG_RE } from '../../lib/paths.mjs';
import { eventJson, readEvent, ROUTINE, oldRoutineDrafts } from '../../lib/autosend/common.mjs';
import { routineDeletes, dueAfterToday } from '../../lib/autosend/routine.mjs';
import { promptPerson, promptLine } from './prompts.mjs';
import { shellWords } from './shell.mjs';

export const SUBAGENT_REFUSED = Object.freeze(['on', 'approve', 'revoke', 'draft-gone', 'drafts', 'routine-checked']);
export const subagentWhy = (sub) => (SUBAGENT_REFUSED.includes(sub) ? `a subagent doesn't change auto-send (${sub}): only the main conversation runs it, with you there.` : null);

const flagOf = (words, k) => {
  const i = words.lastIndexOf(k);
  return i >= 0 ? words[i + 1] : undefined;
};
const PID = /^[\w-]{1,64}$/;

// { ask } or { refuse }.
export function draftGoneAsk(command, nowMs) {
  const words = shellWords(command);
  const slug = String(flagOf(words, '--event') ?? '');
  const id = String(flagOf(words, '--id') ?? '');
  const touch = Number(flagOf(words, '--touch'));
  if (!SLUG_RE.test(slug) || !PID.test(id) || !Number.isInteger(touch) || touch < 1)
    return { refuse: 'draft-gone needs --event <slug> --id <person id> --touch <n> --said-file <a file with the user\'s own words>.' };
  // As the script reads it (lib/args.mjs): --said first, else the file.
  let said = flagOf(words, '--said');
  if (said === undefined) {
    try {
      said = readChecked(allowedPath(String(flagOf(words, '--said-file') ?? '')), 4096);
    } catch {
      return { refuse: "draft-gone needs --said-file with the user's own words, in floorboss's data folder or the temp folder." };
    }
  }
  said = String(said ?? '').trim();
  if (said.length < 6) return { refuse: "draft-gone needs the user's own words: what they found in Gmail Sent and Drafts." };
  const evDir = join(home(), 'events', slug);
  const ev = eventJson(evDir);
  if (ev?.autosend_mode !== ROUTINE && !oldRoutineDrafts(ev, readEvent(evDir).entries).length) return { refuse: 'draft-gone is for an event sending through a daily Claude routine, or one switched away from it whose routine still has drafts.' };
  const x = routineDeletes(evDir, nowMs).find((d) => d.id === id && d.touch === touch);
  if (!x) return { refuse: `${id} message ${touch} isn't waiting on a stopped Gmail draft.` };
  if (dueAfterToday(evDir, x.due, nowMs)) return { refuse: `${id} message ${touch} isn't due yet, so the routine can't have sent it: run its delete step instead.` };
  const name = readEvent(evDir).folded.people?.[id]?.name || id;
  const reason = `floorboss: you say message ${touch} to ${promptPerson(name, id, x.to)} at ${promptLine(ev.name || slug)} is in neither your Gmail Sent nor your Gmail Drafts. If you allow this, floorboss stops holding it, and you can send it yourself. If that draft is still in Gmail, the daily routine could send it too.\n\nYour words: ${promptLine(said)}\n\nAllow only if you looked in Gmail Sent and Drafts and it is in neither.`;
  // said: the words shown, whose hash the one-use record holds (the command refuses other words).
  return { ask: reason, said };
}
