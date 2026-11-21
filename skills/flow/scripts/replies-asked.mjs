// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The ledger count when "what came in?" (replies_since) was first shown since its last answer, kept in the event's
// work/replies-asked.json (on the laptop only), so "recorded" is checked against the lines written after the question,
// whatever number the answer carries.
import { join } from 'node:path';
import { readJson, writeJson } from '../../../lib/jsonio.mjs';

const lastAnswer = (entries) => {
  let at = 0;
  entries.forEach((x, i) => {
    if (x?.type === 'answered' && x.ask === 'replies_since') at = i + 1;
  });
  return at;
};
const noteOf = (paths) => join(paths.work, 'replies-asked.json');

// Shown now: kept, unless a note for this same round (no answer since) is there already.
export function noteRepliesAsked(paths, entries) {
  const after = lastAnswer(entries);
  let note = null;
  try {
    note = readJson(noteOf(paths), null);
  } catch {
    note = null;
  }
  if (note && note.after_answer === after && Number.isInteger(note.ledger_lines)) return note.ledger_lines;
  try {
    writeJson(noteOf(paths), { ledger_lines: entries.length, after_answer: after });
  } catch {
    return null;
  }
  return entries.length;
}

// The count the question was shown at in this round, or null (no note for it).
export function repliesAsked(paths, entries) {
  try {
    const note = readJson(noteOf(paths), null);
    return note && note.after_answer === lastAnswer(entries) && Number.isInteger(note.ledger_lines) ? note.ledger_lines : null;
  } catch {
    return null;
  }
}
