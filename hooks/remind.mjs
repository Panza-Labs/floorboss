#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// UserPromptSubmit hook: when the user reports what happened with outreach ("I sent Ana and Raj",
// "he moved it to 3:40", "cut the agencies") while floorboss is tracking an event, remind Claude to
// record it in floorboss's log. Otherwise floorboss goes on believing nothing was sent, and the next run
// offers first messages to people already written to. It only adds context: it never blocks a prompt, and
// any failure is silent. On a day the morning brief built itself (scripts/scheduled.mjs), it also says once
// where the page is; and after an unattended run put drafts in or held something, it says so once, in one line.
// First import: floorboss's own process, which reads settings as Claude Code does (lib/harness.mjs).
import '../lib/own-process.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { nowMs } from '../lib/clock.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from '../lib/paths.mjs';
import { isMain } from '../lib/main.mjs';
import { writeText } from '../lib/jsonio.mjs';
import { readBriefState, todayPage, unattendedDir } from '../lib/unattended.mjs';
import { unseen, logEntries, toldFile, summaryFile, dayOf } from '../lib/unattended-drafts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Words of a report about what already happened (not plans): sends, replies, bookings and their changes.
export const REPORT =
  /\b(sent|went out|messaged|dm'?d|texted|emailed|pinged|reached out|replied|responded|answered|wrote back|got back|heard back|got a (yes|no|reply)|accepted|confirmed|booked|is in for|down for|rescheduled|moved (it|the|our|to)|pushed (it|the|our|to)|can'?t make|bailed|cancel+ed|declined|passed on|no[- ]show(ed)?|said (no|yes|stop)|unsubscribed|asked (me )?(to stop|not to)|cut (him|her|them|the)|drop(ped)? (him|her|them|the))\b/i;
// Changes to who's on the list: "add the Northwind CEO to the list", "cut the agencies".
export const LIST_CHANGE = /\b(add|cut|drop|remove|take)\b.{0,60}\b(to|from|off|on)\b.{0,12}\b(short ?list|list)\b|\bcut the\b/i;
const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/[`#<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// Events still worth tracking: from creation until the day after the last day.
export function liveEvents(dir, nowMs = Date.now()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .slice(0, 50)
    .flatMap((slug) => {
      try {
        const ev = JSON.parse(readFileSync(join(dir, slug, 'event.json'), 'utf8'));
        if (ev.mock) return [];
        // floorboss's work ends with the event (after it, the user's own follow-up process takes over); one
        // spare day covers sends and bookings reported the morning after.
        const end = Date.parse(`${ev.end_date || ev.start_date}T23:59:59Z`);
        if (!Number.isFinite(end) || nowMs > end + 864e5) return [];
        // The view floorboss rebuilds on every read (derived/), else the files an older event still has.
        const derived = join(dir, slug, 'derived');
        const fresh = existsSync(join(derived, 'shortlist.json'));
        if (!fresh && !existsSync(join(dir, slug, 'shortlist.json'))) return [];
        // Names of the people floorboss is reaching, so "Raj moved it to Monday" is caught too.
        let names = [];
        try {
          const short = JSON.parse(readFileSync(join(fresh ? derived : join(dir, slug), 'shortlist.json'), 'utf8'));
          const want = new Set(fresh ? [...(short.ranked || []), ...(short.coordinate || [])] : short.approved || []);
          const store = JSON.parse(readFileSync(join(fresh ? derived : join(dir, slug), 'contacts.json'), 'utf8'));
          names = (Array.isArray(store) ? store : store.contacts || [])
            .filter((c) => want.has(c.id))
            .map((c) =>
              String(c.name || '')
                .trim()
                .split(/\s+/)
            )
            .filter((p) => p.length >= 2)
            .map((p) => `${p[0]} ${p[p.length - 1]}`.toLowerCase())
            .slice(0, 500);
        } catch {
          names = [];
        }
        return [{ slug: clean(slug, 64), name: clean(ev.name, 80), names }];
      } catch {
        return [];
      }
    });
}

export function reminder(prompt, events) {
  const p = String(prompt || '').slice(0, 20000);
  const low = p.toLowerCase();
  // A shortlisted person named (full name, or first name as a word) is about them: remind.
  const named = events.some((e) =>
    (e.names || []).some((n) => low.includes(n) || new RegExp(`(^|[^a-z])${n.split(' ')[0].replace(/[^a-z'-]/g, '')}('s)?([^a-z]|$)`).test(low))
  );
  if (!events.length || !(REPORT.test(p) || LIST_CHANGE.test(p) || named)) return null;
  const names = events.map((e) => `"${e.name}" (${e.slug})`).join(', ');
  return `floorboss is tracking ${names}. If this message reports what happened with outreach for it (sent, replied, booked, moved, cancelled, said no or stop, or people cut or added), record it in floorboss before anything else, even outside a floorboss command and even if you also write it somewhere else: write the report as {"items":[{"who","what",…}]} to a file and run node "${ROOT}/skills/event-outreach/scripts/cli.mjs" record --event <slug> --file <file> (format in ${ROOT}/skills/event-outreach/SKILL.md, "Recording what happened"). Read back what it recorded. If the message isn't about that, ignore this.`;
}

// The brief that built itself today (scripts/scheduled.mjs): one line saying where it is, once per build. "Today"
// is the day on this machine's clock, the one the user is living.
export function briefLine(now = nowMs()) {
  const built = Object.values(readBriefState())
    .map((x) => x?.built_at)
    .filter((at) => Number.isFinite(Date.parse(at)) && new Date(at).toDateString() === new Date(now).toDateString())
    .sort()
    .pop();
  if (!built || !existsSync(todayPage())) return null;
  const told = join(unattendedDir(), 'brief-told');
  try {
    if (readFileSync(told, 'utf8').trim() === built) return null;
  } catch {
    /* not said yet */
  }
  // Noted first, by floorboss's own writer, which never writes through a link. If it can't be noted, nothing is
  // said: better silent than the same line on every message.
  try {
    writeText(told, `${built}\n`);
  } catch {
    return null;
  }
  return `floorboss built today's meeting brief on its own (facts only; nothing was sent): ${clean(todayPage(), 300)}. Tell the user where it is, in one line. Nothing else.`;
}

// What floorboss did on its own since the user last looked (lib/unattended-drafts.mjs unseen): one line, once for each
// new thing. The first attended floorboss run shows it in full.
export function unattendedLine() {
  const news = unseen(logEntries());
  if (!news.length) return null;
  const last = news[news.length - 1].at;
  try {
    if (readFileSync(toldFile(), 'utf8').trim() === last) return null;
  } catch {
    /* not said yet */
  }
  try {
    writeText(toldFile(), `${last}\n`);
  } catch {
    return null;
  }
  const drafts = news.filter((e) => e.type === 'draft_result' && e.ok === true).length;
  const held = news.filter((e) => e.type === 'held').length;
  const other = news.length - drafts - held;
  const parts = [`${drafts} follow-up draft${drafts === 1 ? '' : 's'} put into your drafts folder`, `${held} held for you`, ...(other ? [`${other} other thing${other === 1 ? '' : 's'} to look at`] : [])];
  // The day's summary file is named only when it is there.
  const file = summaryFile(dayOf(last));
  const where = existsSync(file) ? `; the day's summary is ${clean(file, 300)}` : '';
  return `floorboss worked on its own since the user last looked (nothing was sent): ${parts.join(', ')}. /floorboss:start shows it first${where}. Tell the user this in one line. Nothing else.`;
}

if (isMain(import.meta.url)) {
  let raw = '';
  process.stdin.on('data', (d) => {
    raw += d;
  });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      // The scheduled run itself gets none of this: it has its one job.
      if (process.env.FLOORBOSS_UNATTENDED) process.exit(0);
      let brief = null;
      try {
        brief = briefLine();
      } catch {
        brief = null;
      }
      let un = null;
      try {
        un = unattendedLine();
      } catch {
        un = null;
      }
      const text = [reminder(input.prompt, liveEvents(join(home(), 'events'), nowMs())), brief, un].filter(Boolean).join('\n\n') || null;
      if (text) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }), () => process.exit(0));
        return;
      }
    } catch {
      /* never in the way of the user's message */
    }
    process.exit(0);
  });
}
