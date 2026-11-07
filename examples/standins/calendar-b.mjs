#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in calendar, Outlook-like shape: getSchedule with local times (no offset) in the asked zone.
import { serve, loadData, expandEvents, BadInput, window, trap } from './lib/server.mjs';
import { wallParts, zonedToUtc, isValidZone, addDays } from '../../lib/tz.mjs';

const cal = loadData().calendar || { events: [] };

// "2026-11-03T09:00:00" is read in zone; a value with Z or an offset is taken as is.
function parseIn(value, zone, key) {
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(value);
  if (m) return zonedToUtc({ y: +m[1], m: +m[2], d: +m[3], hh: +(m[4] || 0), mm: +(m[5] || 0) }, zone);
  const t = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(t.getTime())) throw new BadInput(`"${key}" must be a date-time like 2026-11-03T09:00:00.`);
  return t;
}

const pad = (n) => String(n).padStart(2, '0');
function local(date, zone) {
  const w = wallParts(date, zone);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.hh)}:${pad(w.mm)}:${pad(w.ss)}.0000000`;
}

const STATUS = { free: 'free', tentative: 'tentative', oof: 'oof', busy: 'busy' };

serve('calendar-b', {
  get_schedule: {
    description: "Get the signed-in user's free/busy schedule between startDateTime and endDateTime, in timeZone (IANA, default UTC).",
    inputSchema: {
      type: 'object',
      properties: {
        startDateTime: { type: 'string' },
        endDateTime: { type: 'string' },
        timeZone: { type: 'string', description: 'IANA zone, e.g. Europe/Berlin' }
      },
      required: ['startDateTime', 'endDateTime']
    },
    run(args) {
      const zone = args.timeZone || 'UTC';
      if (!isValidZone(zone)) throw new BadInput(`Unknown timeZone "${zone}".`);
      const [from, to] = window(parseIn(args.startDateTime, zone, 'startDateTime'), parseIn(args.endDateTime, zone, 'endDateTime'));
      const scheduleItems = expandEvents(cal, from, to).map((i) =>
        i.allDay
          ? {
              status: 'oof',
              subject: i.event.summary,
              isAllDay: true,
              start: { dateTime: `${i.date}T00:00:00.0000000`, timeZone: zone },
              end: { dateTime: `${addDays(i.date, 1)}T00:00:00.0000000`, timeZone: zone }
            }
          : {
              status: STATUS[i.event.show_as] || 'busy',
              subject: i.event.summary,
              start: { dateTime: local(i.start, zone), timeZone: zone },
              end: { dateTime: local(i.end, zone), timeZone: zone }
            }
      );
      return { value: [{ scheduleId: 'me', availabilityView: '', scheduleItems }] };
    }
  },
  cancel_event: trap('Cancel a meeting and notify its attendees.', { eventId: { type: 'string' }, comment: { type: 'string' } }, () => ({})),
  send_meeting_invite: trap(
    'Create a meeting and send invitations to the attendees.',
    { subject: { type: 'string' }, attendees: { type: 'array' }, start: { type: 'object' }, end: { type: 'object' } },
    () => ({ id: 'AAMk-standin', isOrganizer: true })
  )
});
