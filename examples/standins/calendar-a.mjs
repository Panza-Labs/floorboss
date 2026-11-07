#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in calendar, Google-like shape: freebusy in UTC, events with dateTime/date.
import { serve, loadData, expandEvents, instant, window, trap, newId } from './lib/server.mjs';
import { offsetMinutes } from '../../lib/tz.mjs';

const cal = loadData().calendar || { events: [] };
const zone = cal.time_zone || 'UTC';
const range = {
  type: 'object',
  properties: { timeMin: { type: 'string', description: 'RFC3339 start' }, timeMax: { type: 'string', description: 'RFC3339 end' } },
  required: ['timeMin', 'timeMax']
};

function bounds(args) {
  return window(instant(args.timeMin, 'timeMin'), instant(args.timeMax, 'timeMax'));
}

// RFC3339 with the calendar zone's offset, as Google returns event times.
function rfc(date) {
  const off = offsetMinutes(date, zone);
  const local = new Date(date.getTime() + off * 60000).toISOString().slice(0, 19);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

serve('calendar-a', {
  freebusy_query: {
    description: 'Return busy intervals for the primary calendar between timeMin and timeMax.',
    inputSchema: range,
    run(args) {
      const [from, to] = bounds(args);
      const busy = [];
      for (const i of expandEvents(cal, from, to)) {
        if (i.event.show_as === 'free') continue;
        const s = Math.max(i.start, from),
          e = Math.min(i.end, to);
        const last = busy.at(-1);
        if (last && s <= last.e) last.e = Math.max(last.e, e);
        else busy.push({ s, e });
      }
      const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
      return {
        kind: 'calendar#freeBusy',
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        calendars: { primary: { busy: busy.map((b) => ({ start: iso(b.s), end: iso(b.e) })) } }
      };
    }
  },
  list_events: {
    description: 'List events on the primary calendar between timeMin and timeMax, recurring events expanded.',
    inputSchema: range,
    run(args) {
      const [from, to] = bounds(args);
      return {
        kind: 'calendar#events',
        timeZone: zone,
        items: expandEvents(cal, from, to).map((i) => ({
          summary: i.event.summary,
          status: i.event.status || 'confirmed',
          // The user's own calendar: they organised it, and the people on it accepted (as Google Calendar shows it).
          organizer: { email: 'me@calendar.example', self: true },
          attendees: (i.event.attendees || []).map((email) => ({ email, responseStatus: 'accepted' })),
          ...(i.event.show_as === 'free' ? { transparency: 'transparent' } : {}),
          start: i.allDay ? { date: i.date } : { dateTime: rfc(i.start) },
          end: i.allDay ? { date: rfc(i.end).slice(0, 10) } : { dateTime: rfc(i.end) }
        }))
      };
    }
  },
  create_event: trap('Create an event on the primary calendar.', { summary: { type: 'string' }, start: { type: 'object' }, end: { type: 'object' } }, () => ({
    id: newId('ev'),
    status: 'confirmed'
  })),
  delete_event: trap('Delete an event from the primary calendar.', { eventId: { type: 'string' } }, () => ({}))
});
