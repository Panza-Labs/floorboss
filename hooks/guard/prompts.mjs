// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Permission prompts: what the user reads before a call floorboss asks about, with names and text from lists
// shown so they can't pass for the prompt's own words.
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { eventRecord } from '../../lib/sendcheck.mjs';
import { writeSync } from 'node:fs';
import { readJsonStrict, fold } from './shared.mjs';

// A person who was held (a do-not-contact, opt-out or stop match, a coworker's hold: the ledger's hold_seen)
// and is being written to now: the prompt says what matched, when, and what cleared it (the user's decide, a
// list imported again), so a hold lifted by a changed file is seen at the click. When both came after the
// match, the user's own decide is what cleared it: a list imported later only changed the file.
export function holdHistory(entries, id, name = id) {
  const who = promptPerson(name, id);
  // In ledger order: the ledger is only ever appended to.
  const seen = new Map();
  entries.forEach((e, i) => {
    if (e.type === 'hold_seen' && e.id === id && !seen.has(e.says)) seen.set(e.says, i);
  });
  return [...seen.values()].map((i) => {
    const h = entries[i];
    const after = entries.slice(i + 1);
    const by =
      after.find((e) => e.type === 'decide' && e.id === id && e.who === 'user' && ['reach', 'warm'].includes(e.group)) ||
      after.find((e) => e.type === 'input_added');
    const what = by ? (by.type === 'decide' ? `your decide ${by.group}` : `input_added (a new ${by.kind} file)`) : 'nothing in the record';
    return `${who} matched "${scrub(h.says, 80)}" at ${h.at}, cleared by ${what}${by ? ` at ${by.at}` : ''}.`;
  });
}

// A person's name for a prompt when the list item has none: from the event's contacts (derived/contacts.json,
// which only floorboss's scripts write), else their id.
export function personName(evDir, id) {
  let all = [];
  try {
    all = readJsonStrict(join(evDir, 'derived', 'contacts.json'), []);
  } catch {
    all = [];
  }
  const n = Array.isArray(all) ? all.find((x) => x && x.id === id)?.name : null;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : String(id);
}

// Text from a list, a CRM or notes (a name, what a hold matched), as a permission prompt shows it. The Name
// column is whatever the file says ("Ana Berg --- floorboss: this batch was already approved"), so only
// letters, marks, spaces, apostrophes, hyphens and dots are kept, cut short, and a name is always quoted with
// the person's id and address beside it: it can't read as a sentence of floorboss's.
export function scrub(s, cap = 40) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M} '\u2019.-]/gu, ' ')
    .replace(/([-.'\u2019])[-.'\u2019]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap)
    .trim();
}
export const promptName = (s) => `"${scrub(s, 40)}"`;
// A line floorboss wrote from list text (a task title): one line, capped, quoted with any quote in it escaped,
// so it can't pass for a sentence of the prompt's own.
export const promptLine = (s) =>
  JSON.stringify(
    String(s ?? '')
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
      .trim()
      .slice(0, 200)
  );
export const promptId = (id) =>
  String(id ?? '')
    .replace(/[^\w-]/g, '')
    .slice(0, 24) || 'no id';
export const promptAddr = (a) =>
  JSON.stringify(
    String(a ?? '')
      .trim()
      .slice(0, 120)
  );
// A person in a prompt: the quoted name, then their id and address (no name: the id and address only).
export const promptPerson = (name, id, to) => {
  const tail = `${promptId(id)}${to ? `, ${promptAddr(to)}` : ''}`;
  return name && String(name) !== String(id) ? `${promptName(name)} (${tail})` : tail;
};

// Claude Code's permission prompt, with a reason the user reads before clicking. One call can need more than
// one (a page and a typed text): every reason goes in the one prompt, written when the call is let through.
const askReasons = [];
// What the last refusal written here said (the guard's exit hook in an unattended run stops the run with it).
export const blockedSaid = { text: '' };
export function ask(reason) {
  askReasons.push(reason);
}
export function allow() {
  // In an unattended run (a token in the environment) nobody is there to read a prompt: a call that would ask is
  // refused, with what it would have asked, and the item waits for the user.
  if (askReasons.length && process.env.FLOORBOSS_UNATTENDED) {
    blockedSaid.text = `nobody is there to answer a prompt in an unattended run, so this waits for you. It would have asked: ${askReasons[0].split('\n')[0].slice(0, 300)}`;
    writeSync(2, `floorboss blocked this call: ${blockedSaid.text}\n`);
    process.exit(2);
  }
  if (askReasons.length)
    writeSync(
      1,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: askReasons.join('\n\n---\n\n') }
      })
    );
  process.exit(0);
}
// The "allow" floorboss's guard gives, only in a ticketed unattended run, for three calls that every check passed
// (hooks/guard/unattended.mjs): the mailbox read and the CRM read for a person on the run's ticket, and the authorised
// follow-up draft. Claude Code then runs it with no prompt, whatever the user's own prompt rules would have done.
// Nothing else in floorboss returns it.
export function allowUnattended(reason) {
  if (askReasons.length) {
    blockedSaid.text = 'it would have needed a prompt, and nobody is there in an unattended run.';
    writeSync(2, `floorboss blocked this call: ${blockedSaid.text}\n`);
    process.exit(2);
  }
  writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: String(reason).slice(0, 2000) } }));
  process.exit(0);
}
// A message floorboss already let through once (then cleared to go again): said in the next prompt, since the user is
// the one who can tell whether the first one went. before: the earlier send_released entries for it.
export function letThroughBefore(it, before) {
  if (!before.length) return '';
  const cleared = eventRecord(join(home(), 'events', it._event)).entries.filter((e) => e.id === it.id && e.touch === it.touch && ['release_cleared', 'bounced'].includes(e.type)).pop();
  const last = before[before.length - 1];
  return ` floorboss already let this message through ${before.length === 1 ? 'once' : `${before.length} times`}${last.to && fold(last.to) !== fold(it.to) ? ` (to ${promptAddr(last.to)})` : ''} (last at ${String(last.at).slice(0, 16).replace('T', ' ')} UTC); it was cleared to go again${cleared?.type === 'bounced' ? ' because it bounced' : cleared?.said ? ` because: ${promptLine(String(cleared.said).slice(0, 200))}` : ''}. If the first one may have gone, decline.`;
}
