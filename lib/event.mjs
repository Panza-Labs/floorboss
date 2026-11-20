// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Reading and writing one event's folder.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eventDir, contextDir, home } from './paths.mjs';
import { readJson, writeJson } from './jsonio.mjs';
import { loadConfig, effectiveSettings } from './config.mjs';
import { handSend } from './harness.mjs';
import { movedNow } from './clock.mjs';
import { ownerSettingRead, sentenceLike } from './names.mjs';

// The mock events' fixed names (examples/mock-event/load.mjs): the guard treats them as the mock whatever their file says.
export const MOCK_SLUGS = Object.freeze(['mock-harbour-haul', 'mock-harbour-haul-investors']);
export const isMockSlug = (slug) => MOCK_SLUGS.includes(String(slug));

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
  if (!existsSync(p.event))
    throw new Error(
      handSend()
        ? `No event "${slug}" yet. Start floorboss first (for the mock event, run examples/mock-event/load.mjs).`
        : `No event "${slug}" yet. Run /floorboss:start (or /floorboss:event-setup mock buyers for the mock event) first.`
    );
  const event = readJson(p.event);
  const config = loadConfig();
  const settings = effectiveSettings(config, event);
  // The CRM owner that is the user, read against the owners the CRM holds: a sentence saved before answers were
  // matched ("that's me, Bram Janssens") is read as the one owner it names, so that owner's people stay the user's.
  // Anything that isn't a sentence is the user's value as saved (nothing to read).
  if (sentenceLike(settings.crm_user_name)) {
    const read = ownerSettingRead(settings.crm_user_name, crmOwnerValues(p.dir));
    if (read.read_from) settings.crm_user_name = read.value;
  }
  return { event, config, settings, paths: p };
}

// The owner values every other real event of the user's CRM files hold ({ value, event }: its name): an owner the
// user is at one event is an answer at any other, though that event's export doesn't list them.
export function otherOwnerValues(slug) {
  const root = join(home(), 'events');
  const out = [];
  if (!existsSync(root)) return out;
  for (const s of readdirSync(root)) {
    if (s === slug) continue;
    try {
      const ev = readJson(join(root, s, 'event.json'), null);
      if (!ev || ev.mock) continue;
      for (const value of crmOwnerValues(join(root, s))) out.push({ value, event: ev.name || s });
    } catch {
      /* an event that can't be read lends no owners */
    }
  }
  return out;
}

// The owner values in the CRM files read for this event (their column mappings in sources/), as the CRM writes them.
export function crmOwnerValues(dir) {
  const src = join(dir, 'sources');
  if (!existsSync(src)) return [];
  const out = new Set();
  for (const f of readdirSync(src).filter((x) => x.endsWith('.json'))) {
    try {
      const m = JSON.parse(readFileSync(join(src, f), 'utf8'));
      if (m?.kind === 'crm') for (const o of m.owner_values || []) if (String(o).trim()) out.add(String(o).trim());
    } catch {
      /* a damaged mapping file is reported where it's read */
    }
  }
  return [...out];
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
