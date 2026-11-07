#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// UserPromptSubmit hook: when the user reports what happened with outreach ("I sent Ana and Raj",
// "he moved it to 3:40", "cut the agencies") while floorboss is tracking an event, remind Claude to
// record it in floorboss's log. Otherwise floorboss goes on believing nothing was sent, and the next run
// offers first messages to people already written to. It only adds context: it never blocks a prompt, and
// any failure is silent.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from '../lib/paths.mjs';
import { isMain } from '../lib/main.mjs';

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

if (isMain(import.meta.url)) {
  let raw = '';
  process.stdin.on('data', (d) => {
    raw += d;
  });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      const text = reminder(input.prompt, liveEvents(join(home(), 'events')));
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
