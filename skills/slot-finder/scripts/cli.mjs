#!/usr/bin/env node
// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Plan: create the event, turn free times into slots, remove slots the user can't do.
import { run, need } from '../../../lib/args.mjs';
import { readJson, writeJson } from '../../../lib/jsonio.mjs';
import { allowedPath, notSensitive, expandHome } from '../../../lib/paths.mjs';
import { loadEvent, files, saveEvent, nowFrom } from '../../../lib/event.mjs';
import { loadConfig } from '../../../lib/config.mjs';
import { slugify, assertSlug } from '../../../lib/paths.mjs';
import { isValidZone, addDays, daysBetween, zoneFrom } from '../../../lib/tz.mjs';
import * as tzHelpers from '../../../lib/tz.mjs';
import { parseFreeTimes } from './freetimes.mjs';
import { buildSlots, slotLabel, removeSlots } from './slots.mjs';
import { holdersBySlot } from './assign.mjs';
import { freeFromBusy, subtractBusy } from './busy.mjs';
import { validateBusy } from '../../connectors/scripts/tasks.mjs';

function eventDays(event) {
  const n = daysBetween(event.start_date, event.end_date);
  return Array.from({ length: n + 1 }, (_, i) => addDays(event.start_date, i));
}

function create(opts) {
  need(opts, 'name', 'city', 'start', 'end', 'zone');
  if (!isValidZone(opts.zone)) throw new Error(`"${opts.zone}" isn't an IANA time zone (like Europe/Lisbon).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.start) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.end) || opts.end < opts.start) {
    throw new Error('Dates must look like 2026-10-27, with the end on or after the start.');
  }
  const slug = assertSlug(opts.slug || slugify(opts.name));
  const aliases = opts['short-name']
    ? String(opts['short-name'])
        .split(/[|,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const event = {
    slug,
    name: opts.name,
    city: opts.city,
    time_zone: opts.zone,
    start_date: opts.start,
    end_date: opts.end,
    ...(aliases.length ? { aliases } : {}),
    created_at: nowFrom(opts).toISOString(),
    settings: {}
  };
  saveEvent(slug, event);
  return { slug, event_file: files(slug).event, days: eventDays(event) };
}

function view(event, settings, slots, assignments = {}) {
  const home = settings.home_tz || event.time_zone;
  const holders = holdersBySlot(assignments);
  const byDay = {};
  for (const s of slots)
    (byDay[s.day] ||= []).push({
      id: s.id,
      label: slotLabel(s, event.time_zone, home, event.city),
      minutes: s.minutes,
      label_note: s.label || undefined,
      offered_to: holders[s.id] || undefined
    });
  return byDay;
}

// Does a typed range (wall minutes on a day in zone) overlap a busy block (UTC ms)?
function busyOverlaps(r, s0, e0, zone) {
  const { zonedToUtc: z, parseDateKey: p } = tzHelpers;
  const d = p(r.date);
  const a = z({ ...d, hh: Math.floor(r.start / 60), mm: r.start % 60 }, zone).getTime();
  const b = z({ ...d, hh: Math.floor(r.end / 60) % 24, mm: r.end % 60 }, zone).getTime() + (r.end >= 24 * 60 ? 86400000 : 0);
  return s0 < b && e0 > a;
}
const labelSpan = (x, zone) => {
  const f = (t) => new Date(t).toLocaleString('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${f(x.start)}–${f(x.end).split(', ').pop()}`;
};

// The window a calendar is read for: the event's days, whole days in the event's zone.
function eventWindow(event) {
  const { zonedToUtc: z, parseDateKey: p } = tzHelpers;
  const a = p(event.start_date),
    b = p(addDays(event.end_date, 1));
  return { from: z({ ...a }, event.time_zone).toISOString(), to: z({ ...b }, event.time_zone).toISOString() };
}

// Busy blocks from a calendar connector's answer (already in floorboss's format) or an .ics file.
async function readBusy(opts, event) {
  const win = eventWindow(event);
  let busy,
    warnings = [],
    source,
    wholeDay = [];
  const ignoreAllDay = !!opts['ignore-all-day'];
  // --ignore "staff meeting|prep call": calendar items whose title contains one of these don't count as busy.
  const skip = String(opts.ignore || '')
    .split('|')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const keep = (b) =>
    !skip.length ||
    !skip.some((x) =>
      String(b.summary || '')
        .toLowerCase()
        .includes(x)
    );
  if (opts['busy-file']) {
    const raw = readJson(allowedPath(opts['busy-file']));
    const r = validateBusy({ ...raw, busy: (raw.busy || []).filter(keep) }, { ...win, ignoreAllDay });
    if (r.errors.length) throw new Error(`The calendar's busy times didn't validate: ${r.errors.slice(0, 3).join('; ')}`);
    busy = r.busy;
    wholeDay = r.whole_day;
    source = 'calendar connector';
  } else {
    const { parseIcsBusy } = await import('./ics.mjs');
    const { readFileSync } = await import('node:fs');
    // Read from where floorboss reads lists (its data folder, the temp folder, the folder Claude Code started in).
    const p = notSensitive(allowedPath(expandHome(opts.ics), { list: true, ext: /\.ics$/i }));
    const { statSync, existsSync } = await import('node:fs');
    if (!existsSync(p)) throw new Error(`${opts.ics} isn't there: give the path to your calendar's .ics export.`);
    const { listFileProblem } = await import('../../../lib/security.mjs');
    const problem = listFileProblem(p, statSync(p).size, 'ics') || (statSync(p).isFile() ? null : `${opts.ics} isn't a plain file.`);
    if (problem) throw new Error(problem);
    const text = readFileSync(p, 'utf8');
    // The calendar's own zone (X-WR-TIMEZONE) places all-day and floating items, unless --zone says otherwise.
    const calZone = (/^X-WR-TIMEZONE:(.+)$/m.exec(text) || [])[1]?.trim();
    const r = parseIcsBusy(text, { ...win, assumeZone: opts.zone || (calZone && isValidZone(calZone) ? calZone : event.time_zone) });
    const v = validateBusy(
      { busy: r.busy.filter(keep).map((b) => ({ start: b.start, end: b.end, summary: b.summary, all_day: b.all_day })) },
      { ...win, ignoreAllDay }
    );
    busy = v.busy;
    wholeDay = v.whole_day;
    warnings = r.warnings || [];
    source = `.ics file (${opts.ics})`;
  }
  return { busy, warnings, source, wholeDay, ignoreAllDay };
}

// Free ranges from busy blocks: a calendar connector's answer (already in floorboss's format) or an .ics file.
async function rangesFromBusy(opts, event, settings) {
  const { busy, warnings, source, wholeDay, ignoreAllDay } = await readBusy(opts, event);
  const { ranges, busy_hours } = freeFromBusy(busy, {
    eventDays: eventDays(event),
    eventZone: event.time_zone,
    hours: settings.hours,
    minMinutes: settings.meeting_minutes
  });
  return { ranges, source, busy_blocks: busy.length, busy_hours, warnings, wholeDay, ignoreAllDay };
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Part of what the user typed couldn't be read: refuse the lot, so a day or an exception is never dropped quietly.
function refuseUnparsed(unparsed, event) {
  if (!unparsed.length) return;
  throw new Error(
    `Couldn't read this part of the free times: ${unparsed.map((u) => `"${u}"`).join(', ')}. Nothing was saved. Write each day with its hours, e.g. "Jan 10, 11 and 12, 9am to 6pm each day", "both days 9-18 except 12-13", "whole event, normal hours" (event days: ${eventDays(event).join(', ')}).`
  );
}

// Free days as Claude read them from the user's words: {"days":[{"date","from":"HH:MM","to":"HH:MM","except":[{"from","to"}]}],
// "notes":["booth shifts not known yet"]}. Checked against the event's days; nothing outside them is taken.
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
};
export function rangesFromDays(raw, event) {
  const days = eventDays(event),
    out = [],
    errors = [],
    except = [];
  for (const d of Array.isArray(raw?.days) ? raw.days : []) {
    const from = toMin(d.from),
      to = toMin(d.to);
    if (!days.includes(d.date)) {
      errors.push(`${d.date} isn't one of the event's days (${days.join(', ')})`);
      continue;
    }
    if (from == null || to == null || to <= from) {
      errors.push(`${d.date}: "${d.from}" to "${d.to}" isn't a time range (HH:MM to HH:MM)`);
      continue;
    }
    let parts = [[from, to]];
    for (const x of Array.isArray(d.except) ? d.except : []) {
      const a = toMin(x.from),
        b = toMin(x.to);
      if (a == null || b == null || b <= a) {
        errors.push(`${d.date}: except "${x.from}" to "${x.to}" isn't a time range`);
        continue;
      }
      except.push({ dates: [d.date], start: a, end: b });
      parts = parts
        .flatMap(([s0, e0]) => [
          [s0, Math.min(e0, a)],
          [Math.max(s0, b), e0]
        ])
        .filter(([s0, e0]) => e0 > s0);
    }
    for (const [s0, e0] of parts) out.push({ date: d.date, start: s0, end: e0 });
  }
  if (!out.length && !errors.length) errors.push('no days given');
  return { ranges: out, errors, except, notes: (Array.isArray(raw?.notes) ? raw.notes : []).map((n) => String(n).slice(0, 200)) };
}

async function build(opts) {
  need(opts, 'event');
  if (opts['days-file']) {
    const ev = loadEvent(opts.event).event;
    const r = rangesFromDays(readJson(allowedPath(opts['days-file'])), ev);
    if (r.errors.length) throw new Error(`The free days didn't validate: ${r.errors.slice(0, 4).join('; ')}. Nothing was saved.`);
    opts = { ...opts, _days: r };
  }
  if (!opts.free && !opts._days && !opts['busy-file'] && !opts.ics)
    throw new Error('Give --free "<times>", --busy-file <calendar answer> or --ics <calendar export>.');
  const { event, settings, paths } = loadEvent(opts.event);
  let zone = opts.zone ? zoneFrom(opts.zone) : event.time_zone;
  if (!zone || !isValidZone(zone))
    throw new Error(`"${opts.zone}" isn't a city or time zone floorboss knows: give the city they live in or an IANA zone like Europe/Berlin.`);
  let ranges,
    unparsed = [],
    except = [],
    fromCal = null,
    droppedForBusy = [],
    ampmNote,
    cutByCalendar = [];
  // Typed in another zone, a bare "5:30-8:30" may mean morning there (afternoon at the event). Read bare times
  // both ways and keep whichever lands more of them in the event's working hours; say which was used.
  const typed = () => {
    if (opts._days) return { ranges: opts._days.ranges, unparsed: [], except: opts._days.except };
    const first = parseFreeTimes(opts.free, { eventDays: eventDays(event), hours: settings.hours });
    if (zone === event.time_zone || !/(^|[^\d:])([1-9]|1[0-1])(?::\d{2})?\s*[-–]/.test(opts.free)) return first;
    const asWritten = parseFreeTimes(opts.free, { eventDays: eventDays(event), hours: settings.hours, bareAsAfternoon: false });
    const inHours = (rs) =>
      buildSlots(rs, { eventZone: event.time_zone, sourceZone: zone, hours: settings.hours, meetingMinutes: settings.meeting_minutes, now: nowFrom(opts) })
        .slots.length;
    const a1 = inHours(first.ranges),
      a2 = inHours(asWritten.ranges);
    if (a2 > a1) {
      ampmNote = `Times without am/pm were read as written (morning), because typed in ${zone} that puts them inside working hours in ${event.city}. Add "pm" to any you meant as afternoon.`;
      return asWritten;
    }
    if (a1 > a2) ampmNote = `Times without am/pm like "3-5" were read as afternoon in ${zone}. If you meant morning, add "am".`;
    return first;
  };
  if ((opts.free || opts._days) && (opts['busy-file'] || opts.ics)) {
    // Typed free times, minus whatever the calendar says is busy.
    ({ ranges, unparsed, except } = typed());
    refuseUnparsed(unparsed, event);
    const b = await readBusy(opts, event);
    const typedRanges = ranges;
    const sub = subtractBusy(ranges, b.busy, { sourceZone: zone, eventZone: event.time_zone, minMinutes: settings.meeting_minutes });
    // Say which typed times the calendar took away, so nothing disappears silently.
    cutByCalendar = b.busy
      .filter((x) =>
        typedRanges.some((r) => {
          const s0 = Date.parse(x.start),
            e0 = Date.parse(x.end);
          return busyOverlaps(r, s0, e0, zone);
        })
      )
      .map((x) => labelSpan(x, event.time_zone));
    ranges = sub.ranges;
    droppedForBusy = sub.dropped;
    zone = event.time_zone;
    fromCal = {
      source: `${b.source}, subtracted from your typed times`,
      busy_blocks: b.busy.length,
      busy_hours: null,
      warnings: b.warnings,
      wholeDay: b.wholeDay,
      ignoreAllDay: b.ignoreAllDay
    };
  } else if (opts.free || opts._days) {
    ({ ranges, unparsed, except } = typed());
    refuseUnparsed(unparsed, event);
  } else {
    fromCal = await rangesFromBusy(opts, event, settings);
    ranges = fromCal.ranges;
    zone = event.time_zone;
  }
  const { slots, outside } = buildSlots(ranges, {
    eventZone: event.time_zone,
    sourceZone: zone,
    hours: settings.hours,
    meetingMinutes: settings.meeting_minutes,
    now: nowFrom(opts),
    keepOutside: !!opts['keep-outside']
  });
  // Typed times that give no slot at all are a misreading, not an answer: nothing is saved over the old slots.
  if ((opts.free || opts._days) && !fromCal && !slots.length)
    throw new Error(
      `No meeting slots from "${opts.free}". Check the times fall on the event's days (${eventDays(event).join(', ')}) and within working hours (${settings.hours.start}–${settings.hours.end}); write days as dates or weekdays ("Jan 10", "Tue"), not "tomorrow". Nothing was saved.`
    );
  const prev = readJson(paths.slots, null);
  const removedHeld = [];
  const short = readJson(paths.shortlist, null);
  if (prev && short?.assignments) {
    const ids = new Set(slots.map((s) => s.id));
    for (const [cid, sids] of Object.entries(short.assignments)) for (const sid of sids) if (!ids.has(sid)) removedHeld.push({ contact: cid, slot: sid });
  }
  // Times already booked stay booked when the free times are rebuilt.
  const booked = readJson(paths.slots, {}).booked || [];
  writeJson(paths.slots, {
    source_zone: zone,
    free_times: opts.free || (opts._days ? opts._days.ranges.map((r) => `${r.date} ${hhmm(r.start)}-${hhmm(r.end)}`).join(', ') : null),
    ...(opts._days?.notes?.length ? { notes: opts._days.notes } : {}),
    from_calendar: fromCal ? fromCal.source : undefined,
    slots,
    outside,
    ...(booked.length ? { booked } : {})
  });
  return {
    from_calendar: fromCal
      ? {
          source: fromCal.source,
          busy_blocks: fromCal.busy_blocks,
          busy_hours_in_working_hours: fromCal.busy_hours ?? undefined,
          warnings: fromCal.warnings.length ? fromCal.warnings : undefined,
          all_day_items: fromCal.wholeDay.length ? fromCal.wholeDay : undefined,
          all_day_note:
            fromCal.wholeDay.length && !fromCal.ignoreAllDay
              ? 'These all-day items were counted as busy. Some are trip or conference markers, some are deadlines; if they shouldn\'t block meetings, run build again with --ignore-all-day (or --ignore "<part of a title>" for one of them).'
              : undefined,
          typed_slots_dropped_for_calendar: droppedForBusy.length ? droppedForBusy : undefined,
          calendar_took_out: cutByCalendar.length
            ? {
                busy: cutByCalendar,
                note: 'Your calendar is busy at these times inside the times you typed, so they were taken out. If one of them doesn\'t apply during the event, build again with --ignore "<part of its title>".'
              }
            : undefined
        }
      : undefined,
    no_slots_note: slots.length
      ? undefined
      : fromCal
        ? 'No meeting slots. If your calendar marks the event days as busy (a trip or conference block), run build again with --ignore-all-day, or type your free times.'
        : `No meeting slots from those times. Check they fall on the event's days (${eventDays(event).join(', ')}) and within working hours (${settings.hours.start}–${settings.hours.end}); write days as dates or weekdays, not "tomorrow".`,
    slots: slots.length,
    by_day: view(event, settings, slots),
    am_pm_note: ampmNote,
    notes: opts._days?.notes?.length ? opts._days.notes : undefined,
    taken_out: except.length ? except.map((x) => `${x.dates.join(', ')} ${hhmm(x.start)}–${hhmm(x.end)}`) : undefined,
    ...(slots.length > 40
      ? {
          too_many: `That's ${slots.length} meetings back to back. Ask which hours they'll really take meetings (talks, meals, travel, a break between meetings), then build again.`,
          too_many_count: slots.length
        }
      : {}),
    outside_hours: outside.length
      ? outside.map(
          (o) =>
            `${slotLabel({ start: o.start }, event.time_zone, zone !== event.time_zone ? zone : null, event.city)} to ${new Date(o.end).toISOString().slice(11, 16)} UTC`
        )
      : undefined,
    outside_note: outside.length ? 'These parts fall outside working hours and were left out. Re-run with --keep-outside to keep them.' : undefined,
    held_slots_removed: removedHeld.length ? removedHeld : undefined
  };
}

function remove(opts) {
  need(opts, 'event', 'ids');
  const { event, settings, paths } = loadEvent(opts.event);
  const data = readJson(paths.slots);
  const ids = String(opts.ids)
    .split(/[\s,]+/)
    .filter(Boolean);
  const unknown = ids.filter((id) => !data.slots.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Not slots of this event: ${unknown.join(', ')}`);
  data.slots = removeSlots(data.slots, ids);
  writeJson(paths.slots, data);
  return { slots: data.slots.length, by_day: view(event, settings, data.slots) };
}

// The window to ask a calendar for, so the agent calls the tool with the right range.
function calendarWindow(opts) {
  need(opts, 'event');
  const { event, settings } = loadEvent(opts.event);
  return { ...eventWindow(event), event_zone: event.time_zone, working_hours: settings.hours };
}

function show(opts) {
  need(opts, 'event');
  const { event, settings, paths } = loadEvent(opts.event);
  const data = readJson(paths.slots, { slots: [] });
  const short = readJson(paths.shortlist, null);
  return {
    event: { name: event.name, zone: event.time_zone, dates: [event.start_date, event.end_date] },
    by_day: view(event, settings, data.slots, short?.assignments || {})
  };
}

// Short names people use for the event ("GreenRift"): drafts may name the event by them.
function alias(opts) {
  need(opts, 'event', 'short-name');
  const { event } = loadEvent(opts.event);
  const aliases = [
    ...new Set([
      ...(event.aliases || []),
      ...String(opts['short-name'])
        .split(/[|,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ])
  ];
  saveEvent(event.slug, { ...event, aliases });
  return { event: event.name, short_names: aliases };
}

// The event's app for messages and meetings (Brella, Swapcard…): tasks and the tracker name it.
function app(opts) {
  need(opts, 'event', 'name');
  const { event } = loadEvent(opts.event);
  let name = String(opts.name)
    .replace(/[^\p{L}\p{N} .&'-]/gu, '')
    .trim()
    .slice(0, 40);
  if (/^(none|no|n\/?a|nothing|no app|-)$/i.test(name)) name = '';
  saveEvent(event.slug, { ...event, app_name: name || null, no_app: !name });
  return { event: event.name, app_name: name || null, no_app: !name || undefined };
}

run({ create, build, remove, show, alias, app, 'calendar-window': calendarWindow });
