// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Reading and writing one event's folder.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventDir, contextDir, home } from './paths.mjs';
import { readJson, writeJson } from './jsonio.mjs';
import { loadConfig, effectiveSettings } from './config.mjs';
import { movedNow } from './clock.mjs';

export function files(slug) {
  const dir = eventDir(slug);
  const f = (n) => join(dir, n);
  return {
    dir,
    event: f('event.json'),
    slots: f('slots.json'),
    attendees: f('attendees.csv'),
    // Older shapes some steps still read (research, the event check, the slot finder): rebuilt with the view on
    // every read, never a record. The full list as a CSV, for the user to open.
    contacts: f('derived/compat/contacts.json'),
    triage: f('derived/compat/triage.json'),
    shortlist: f('derived/compat/shortlist.json'),
    triageCsv: f('derived/triage.csv'),
    drafts: f('drafts'),
    outbox: f('outbox.html'),
    collectPrompt: f('collect-prompt.md'),
    // The one record, the inputs the user gave, the confirmed column mappings, and what is recomputed on read.
    ledger: f('ledger.jsonl'),
    inputs: f('inputs'),
    sources: f('sources'),
    derived: f('derived'),
    work: f('work')
  };
}

export function loadEvent(slug) {
  const p = files(slug);
  if (!existsSync(p.event)) throw new Error(`No event "${slug}" yet. Run /floorboss:start (or /floorboss:event-setup mock buyers for the mock event) first.`);
  const event = readJson(p.event);
  const config = loadConfig();
  return { event, config, settings: effectiveSettings(config, event), paths: p };
}

export function saveEvent(slug, event) {
  writeJson(files(slug).event, event);
}

export function contextFor(settings, event) {
  // A mock profile (the mock event's own) never stands in for the user's: a real event reads only theirs.
  const profile = event.mock
    ? event.context_profile || settings.context_profile
    : [event.context_profile, settings.context_profile].find((p) => p && !/^mock-/.test(p)) || null;
  if (!profile) return { profile: null, whoToMeet: null, whatYouBring: null, voice: null };
  const dir = event.context_dir || contextDir(profile);
  const read = (name) => {
    const p = join(dir, name, 'SKILL.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  return { profile, dir, whoToMeet: read('who-to-meet'), whatYouBring: read('what-you-bring'), voice: read('voice') };
}

export function nowFrom(opts) {
  // --now only under floorboss's own tests (lib/args.mjs refuses it otherwise).
  const n = (process.env.FLOORBOSS_TEST === '1' && typeof opts?.now === 'string' ? opts.now : null) || movedNow();
  return n ? new Date(n) : new Date();
}

export { home };
