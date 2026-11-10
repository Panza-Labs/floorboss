// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The calendar and the agenda: meetings found in the calendar, and the agenda page for the event days.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath } from '../../../../lib/paths.mjs';
import { bookingsFrom } from '../tracking.mjs';
import { companyFromSlug } from '../../../../lib/normalize.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { agendaData, validatePoints, renderHtml, renderMarkdown, renderIcs, newsPath } from '../agenda.mjs';
import { validateEvents } from '../../../connectors/scripts/tasks.mjs';
import { ctxOf, led, labelOf } from './context.mjs';

// Meetings in the calendar with a shortlisted person count as booked, whatever channel the yes came on; a
// cancelled one frees the time again.
export function calendarBookings(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const r = validateEvents(readJson(allowedPath(opts.file)));
  if (r.errors.length) return { applied: false, errors: r.errors };
  const { slotById } = c;
  const people = [...new Set([...(c.short.approved || []), ...Object.keys(c.state)])]
    .filter((id) => c.byId[id])
    .map((id) => ({
      id,
      emails: [c.byId[id].email, ...(c.byId[id].emails_seen || [])].filter(Boolean),
      slots: (c.short.assignments?.[id] || []).filter((x) => slotById[x]).map((x) => ({ id: x, start: slotById[x].start }))
    }));
  const dayStart = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 14 * 3600000).toISOString();
  const own = new Set((c.settings.own_domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '')));
  const ownEmail = String(c.settings.own_email || '').toLowerCase();
  const mine = (em) => !!em && (em === ownEmail || own.has(String(em).split('@')[1] || ''));
  const unclear = [];
  // An event the user organised, or the person did: one an outsider sent says nothing about this meeting.
  const byThemOrYou = (ev, p) => ev.organizer_is_you === true || (!!ev.organizer && (ev.organizer === ownEmail || p.emails.includes(ev.organizer)));
  // Asked once per event: an answer closes the question, and the same event in the next calendar read doesn't reopen it.
  const askedAbout = new Set((c.entries || []).filter((e) => e.type === 'outcome_unclear').map((e) => e.key));
  const unclearAbout = (p, ev, what) => {
    const key = `cal-${what}-${p.id}-${ev.start}`;
    if (askedAbout.has(key)) return;
    askedAbout.add(key);
    led(c, {
      type: 'outcome_unclear',
      id: p.id,
      key,
      why:
        what === 'stale'
          ? `a calendar event at their booked time was cancelled or declined before this booking was made: is the meeting off (record "cancelled"), or still on?`
          : what === 'declined'
            ? `they declined a calendar event at their booked time that ${ev.organizer || 'someone (no organizer shown)'} sent, not you or them: is your meeting off (record "cancelled"), or still on?`
            : `a calendar event at their booked time was cancelled by ${ev.organizer || 'someone (no organizer shown)'}, not you or them: is the meeting off (record "cancelled"), or still on?`
    });
  };
  const found = bookingsFrom(r.events, people, {
    mine,
    unclear,
    slots: c.slots.map((x) => ({ id: x.id, start: x.start })),
    window: [dayStart(c.event.start_date), new Date(Date.parse(`${c.event.end_date}T00:00:00Z`) + 38 * 3600000).toISOString()]
  });
  const conflicts = [];
  const booked = [],
    unbooked = [],
    freed = [];
  for (const b of found) {
    const st = c.state[b.id] || {};
    if (st.stopped || st.booked === b.slot) continue;
    const holder = Object.entries(c.state).find(([cid, x]) => cid !== b.id && x.booked === b.slot && !x.stopped);
    if (holder) {
      conflicts.push({ id: b.id, slot: b.slot, held_by: holder[0] });
      continue;
    }
    // Moved in the calendar: the old time is free again, here and in slots.json.
    if (st.booked && st.booked !== b.slot) {
      const old = st.booked_blocks || [st.booked];
      led(c, { type: 'unbooked', id: b.id, slot: st.booked, blocks: old, via: 'calendar' });
      freed.push(...old);
    }
    led(c, { type: 'booked', id: b.id, slot: b.slot, start: b.start, via: 'calendar' });
    c.state[b.id] = { ...st, booked: b.slot, booked_start: b.start, booked_blocks: null };
    if (!st.replied) led(c, { type: 'replied', id: b.id });
    booked.push({ id: b.id, name: c.byId[b.id].name, when: labelOf(c, b.slot, b.start) });
  }
  for (const ev of r.events.filter((e) => e.status === 'cancelled')) {
    // Cancelled and sent again at the same time (a re-invite): still booked.
    // Only a re-invite both sides accepted counts (anyone can send an invite at the same time).
    const reinvited = (p) =>
      r.events.some(
        (x) =>
          x !== ev &&
          x.status === 'confirmed' &&
          Math.abs(Date.parse(x.start) - Date.parse(ev.start)) <= 5 * 60000 &&
          bookingsFrom([x], [p], { mine }).length > 0
      );
    for (const p of people.filter((q) => !reinvited(q))) {
      const st = c.state[p.id] || {};
      const at = st.booked && (slotById[st.booked]?.start || st.booked_start);
      if (at && Math.abs(Date.parse(at) - Date.parse(ev.start)) <= 5 * 60000 && p.emails.some((e) => ev.attendees.includes(e))) {
        // As with a cancellation by email: only the user or the person calling it off frees the time. Anyone can
        // send an invite at that time and cancel it; that is put to the user, and nothing is freed.
        if (!byThemOrYou(ev, p)) {
          unclearAbout(p, ev, 'cancelled');
          continue;
        }
        // Cancelled before this booking was made (an old invite still listed): about an earlier meeting, asked.
        if (ev.updated && st.booked_at && Date.parse(ev.updated) < Date.parse(st.booked_at)) {
          unclearAbout(p, ev, 'stale');
          continue;
        }
        const blocks = st.booked_blocks || [st.booked];
        led(c, { type: 'unbooked', id: p.id, slot: st.booked, blocks, via: 'calendar' });
        freed.push(...blocks);
        unbooked.push(p.id);
      }
    }
  }
  // They declined the meeting at their booked time: the time is free again.
  for (const ev of r.events.filter((e) => e.status === 'confirmed')) {
    for (const p of people) {
      const st = c.state[p.id] || {};
      const at = st.booked && (slotById[st.booked]?.start || st.booked_start);
      const acceptedThen = r.events.some(
        (x) => x.status === 'confirmed' && Math.abs(Date.parse(x.start) - Date.parse(ev.start)) <= 5 * 60000 && bookingsFrom([x], [p], { mine }).length > 0
      );
      if (
        at &&
        !acceptedThen &&
        !unbooked.includes(p.id) &&
        Math.abs(Date.parse(at) - Date.parse(ev.start)) <= 5 * 60000 &&
        p.emails.some((e) => ev.responses?.[e] === 'declined')
      ) {
        if (!byThemOrYou(ev, p)) {
          unclearAbout(p, ev, 'declined');
          continue;
        }
        // A decline older than the booking was about an earlier invite at that time: asked, nothing freed.
        if (ev.updated && st.booked_at && Date.parse(ev.updated) < Date.parse(st.booked_at)) {
          unclearAbout(p, ev, 'stale');
          continue;
        }
        const blocks = st.booked_blocks || [st.booked];
        led(c, { type: 'unbooked', id: p.id, slot: st.booked, blocks, via: 'calendar' });
        freed.push(...blocks);
        unbooked.push(p.id);
      }
    }
  }
  led(c, { type: 'calendar_read', booked: booked.length });
  return {
    applied: true,
    booked,
    unbooked,
    ...(unclear.length
      ? {
          not_counted: unclear.map((u) => ({ id: u.id, name: c.byId[u.id]?.name, start: u.start, why: u.why })),
          not_counted_note: 'In the calendar but not counted as booked: an invite counts only when you and they both accepted it.'
        }
      : {}),
    conflicts: conflicts.length
      ? { people: conflicts, note: 'Two people are in the calendar at one time. Nothing was changed for them: sort it out in the calendar, then run again.' }
      : undefined,
    note: booked.length ? 'Booked people get a confirmation on the next draft run; anyone else holding those times gets new ones.' : undefined
  };
}

// agenda-data --event <slug> [--day YYYY-MM-DD]: the facts for every booked meeting (that day), for the agenda.
export function agendaDataCmd(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const data = agendaData(c, { day: opts.day || null });
  const file = join(c.paths.derived, 'agenda-data.json');
  writeJson(file, data);
  const companies = [...new Set(data.meetings.map((m) => m.person.company).filter(Boolean))];
  return {
    meetings: data.meetings.length,
    day: data.day,
    companies,
    file,
    no_news_yet: companies.filter((co) => !existsSync(newsPath(c.paths.dir, co, c.today)))
  };
}

// agenda-news --event <slug> --company <name> --json-file <file>: what's new about a company you're meeting
// (the researcher's briefing answer), sourced: {"news":[{"text","url","date","about":"person|company|division"}]}.
export function agendaNews(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  if (opts['company-slug'] && !opts.company)
    opts.company = companyFromSlug(
      Object.values(c.byId).map((x) => x.company),
      opts['company-slug']
    );
  need(opts, 'company');
  // --skipped: the user said not to look this company up; the agenda goes on without its news.
  const raw = opts.skipped ? { news: [], searched: [] } : readJson(allowedPath(opts['json-file'] || opts.file), {});
  const news = (Array.isArray(raw.news) ? raw.news : [])
    .filter((n) => n?.text && /^https?:\/\//.test(String(n.url || '')))
    .slice(0, 5)
    .map((n) => ({
      text: String(n.text).slice(0, 300),
      url: String(n.url),
      date: n.date ? String(n.date).slice(0, 10) : null,
      about: ['person', 'company', 'division'].includes(n.about) ? n.about : 'company'
    }));
  const f = newsPath(c.paths.dir, String(opts.company), c.today);
  writeJson(f, {
    company: String(opts.company),
    news,
    nothing_found: !news.length,
    searched: Array.isArray(raw.searched) ? raw.searched.slice(0, 6) : [],
    ...(opts.skipped ? { skipped: true } : {}),
    at: c.now.toISOString()
  });
  return { saved: true, company: opts.company, news: news.length };
}

// agenda-save --event <slug> --file <points.json>: Claude's talking points, checked against the facts, then the
// agenda as a page (agenda.html), a short version (agenda.md) and a calendar file (agenda.ics).
export function agendaSave(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const data = readJson(join(c.paths.derived, 'agenda-data.json'), null);
  if (!data) throw new Error('Run agenda-data first.');
  const v = validatePoints(data, readJson(allowedPath(opts.file), {}));
  if (v.errors.length) throw new Error(`The talking points don't fit the facts: ${v.errors.slice(0, 6).join('; ')}. Nothing was saved.`);
  const html = join(c.paths.dir, 'agenda.html'),
    md = join(c.paths.dir, 'agenda.md'),
    ics = join(c.paths.dir, 'agenda.ics');
  writeText(html, renderHtml(data, v.points));
  writeText(md, renderMarkdown(data, v.points));
  writeText(ics, renderIcs(data, v.points, { minutes: Number(c.settings.meeting_minutes) || 30 }));
  led(c, { type: 'answered', who: 'floorboss', ask: 'agenda', value: `${data.day || 'all'}:${data.meetings.length}` });
  return {
    saved: true,
    meetings: data.meetings.length,
    page: html,
    short: md,
    calendar: ics,
    next: `Open ${html}. Import ${ics} into your calendar to have each brief in the meeting's notes.`
  };
}
