#!/usr/bin/env node
// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Load the mock event into floorboss's data folder, with dates relative to today.
// Usage: node load.mjs --goal buyers|investors [--start-in 22] [--now <ISO>]
import { cpSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../lib/args.mjs';
import { isMain } from '../../lib/main.mjs';
import { ensureDir, eventDir } from '../../lib/paths.mjs';
import { writeJson, writeText } from '../../lib/jsonio.mjs';
import { toCsv, readCsvText } from '../../lib/csv.mjs';
import { todayKeyIn, addDays } from '../../lib/tz.mjs';
import { propose, applyMapping } from '../../skills/crm-triage/scripts/sources.mjs';
import { mergeRows, assignIds } from '../../skills/crm-triage/scripts/merge.mjs';
import { parseFreeTimes } from '../../skills/slot-finder/scripts/freetimes.mjs';
import { buildSlots } from '../../skills/slot-finder/scripts/slots.mjs';
import { writeProfile } from '../../skills/attendee-research/scripts/profiles.mjs';
import { EVENT, USER, FREE_TIMES, ATTENDEE_HEADERS, ATTENDEES, CRM_HEADERS, CRM, STATUS_MAPS, DNC, PROFILES } from './mock-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function loadMock({ goal = 'buyers', startIn = 22, now = new Date() } = {}) {
  if (!['buyers', 'investors'].includes(goal)) throw new Error('--goal is "buyers" or "investors".');
  const slug = goal === 'buyers' ? 'mock-harbour-haul' : 'mock-harbour-haul-investors';
  const dir = eventDir(slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const start = addDays(todayKeyIn(EVENT.time_zone, now), Number(startIn));
  const end = addDays(start, EVENT.days - 1);

  // Attendee list as a sponsor export, with registration columns that must be dropped.
  const sessions = ['Day 1 keynote', 'Last-mile track', 'Carrier compliance workshop'];
  const rows = ATTENDEES.map(([first, last, title, company, email, , notes, booth], i) => ({
    'First Name': first,
    'Last Name': last,
    'Job Title': title,
    'Company name': company,
    'Email Address': email,
    LinkedIn: first && last ? `https://example.com/in/${first}-${last}`.toLowerCase() : '',
    Notes: notes,
    Booth: booth,
    Sessions: sessions[i % 3],
    Interests: 'automation; compliance'
  }));
  const attendeesCsv = toCsv(ATTENDEE_HEADERS, rows);
  writeText(join(dir, 'attendees.csv'), attendeesCsv);
  writeText(
    join(dir, 'crm-export.csv'),
    toCsv(
      CRM_HEADERS,
      CRM.map((r) => Object.fromEntries(CRM_HEADERS.map((h, i) => [h, r[i]])))
    )
  );
  writeText(join(dir, 'dnc.txt'), DNC);
  writeText(join(dir, 'free-times.txt'), FREE_TIMES + '\n');
  // So the three mock commands run without questions: the list is complete, the user's contacts export is a
  // (fictional) file, colleagues' accounts apply, and floorboss writes the messages.
  writeJson(join(dir, 'attendees.meta.json'), { shown_total: attendeesCsv.trim().split('\n').length - 1 });
  writeText(join(dir, 'known-contacts.csv'), 'Name,Email,Company\n');

  // Context skills for this goal, inside the mock's own folder: the user's own profiles in context/ and the
  // context_profile in config.json are never read, written or deleted by the mock (loading it again only
  // replaces the mock's folder).
  const ctxDir = join(dir, 'context');
  cpSync(join(here, 'context', goal), ctxDir, { recursive: true });

  const event = {
    slug,
    name: EVENT.name,
    city: EVENT.city,
    time_zone: EVENT.time_zone,
    start_date: start,
    end_date: end,
    mock: true,
    context_profile: `mock-${goal}`,
    context_dir: ctxDir,
    crm: { path: join(dir, 'crm-export.csv') },
    dnc_path: join(dir, 'dnc.txt'),
    created_at: now.toISOString(),
    settings: {
      goal: goal === 'buyers' ? 'meetings with freight and logistics buyers' : "investor meetings for Lanecraft's seed round",
      context_profile: `mock-${goal}`,
      home_tz: USER.home_tz,
      own_company: USER.company,
      own_domains: [USER.domain],
      crm_user_name: USER.name,
      status_map: STATUS_MAPS[goal],
      meeting_place: 'the Lanecraft stand, B14 in Hall 2',
      account_cap: null,
      account_caps: {},
      crm_accounts: 'apply',
      drafting_mode: 'floorboss',
      known_contacts_paths: [join(dir, 'known-contacts.csv')]
    }
  };
  writeJson(join(dir, 'event.json'), event);

  // Slots from the typed free times (typed in event time).
  const days = Array.from({ length: EVENT.days }, (_, i) => addDays(start, i));
  const { ranges } = parseFreeTimes(FREE_TIMES, { eventDays: days });
  const { slots, outside } = buildSlots(ranges, { eventZone: EVENT.time_zone, now });
  writeJson(join(dir, 'slots.json'), { source_zone: EVENT.time_zone, free_times: FREE_TIMES, slots, outside });

  // Pre-built profiles, keyed by the IDs triage will assign on first import (same code, same order).
  const parsed = readCsvText(attendeesCsv);
  // The same steps load takes on a first read: the proposed mapping, duplicates merged, ids in list order.
  const mapping = propose(parsed.headers, parsed.records, 'attendees');
  const { contacts } = assignIds(mergeRows(applyMapping(parsed.records, mapping)).contacts, {});
  let written = 0;
  for (const [first, last, , , , profileSlug] of ATTENDEES) {
    if (!profileSlug || !PROFILES[profileSlug]) continue;
    const c = contacts.find((x) => x.name === `${first} ${last}`);
    if (!c) continue;
    // Canned research (the people and sources are invented): said so plainly, and not read as "couldn't
    // confirm who they are", which is what a real profile without a confirmed identity means.
    writeProfile(dir, c, {
      identity_confirmed: true,
      note: 'Mock event: this research is canned. The person and the sources are invented; nothing was searched.',
      claims: PROFILES[profileSlug].map((text, i) => ({ text, url: `https://example.com/mock/${profileSlug}/${i + 1}` }))
    });
    written++;
  }
  return {
    slug,
    dir,
    start_date: start,
    end_date: end,
    attendees: ATTENDEES.length,
    crm_records: CRM.length,
    slots: slots.length,
    profiles: written,
    context: ctxDir
  };
}

if (isMain(import.meta.url)) {
  const USAGE =
    "Usage: node load.mjs --goal buyers|investors [--start-in 22]\nLoads the mock event into floorboss's data folder (it replaces an earlier mock of the same goal; your own setup is never touched).\n";
  // Help only: nothing is loaded or replaced.
  if (process.argv.slice(2).some((a) => a === '--help' || a === '-h' || a === 'help')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  // "buyers" or "investors" given on its own, as the setup command may pass it.
  const bare = process.argv.slice(2).find((a) => ['buyers', 'investors'].includes(a));
  const { opts } = parseArgs(['load', ...process.argv.slice(2)]);
  if (bare && !opts.goal) opts.goal = bare;
  try {
    const out = loadMock({ goal: opts.goal || 'buyers', startIn: opts['start-in'] ?? 22, now: opts.now ? new Date(opts.now) : new Date() });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`floorboss: ${err.message}\n`);
    process.exit(1);
  }
}
