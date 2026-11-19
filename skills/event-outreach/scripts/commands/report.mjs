// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// report --event <slug>: the after-show report (report.mjs), as a page and a CSV in the event's folder. Read from the
// event's ledger; nothing leaves the machine and nothing is opened.
import { join } from 'node:path';
import { need } from '../../../../lib/args.mjs';
import { writeText } from '../../../../lib/jsonio.mjs';
import { toCsv } from '../../../../lib/csv.mjs';
import { ctxOf } from './context.mjs';
import { buildReport, renderReport, reportCsvRows, CSV_HEADERS, OUTCOME_LABEL } from '../report.mjs';

export function reportCmd(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const r = buildReport(c.entries, { byId: c.byId, zone: c.event.time_zone, now: c.now, minutes: Number(c.settings.meeting_minutes) || 30 });
  const page = join(c.paths.dir, 'report.html');
  const csv = join(c.paths.dir, 'report.csv');
  writeText(page, renderReport(r, { event: c.event, generatedAt: `${c.now.toISOString().slice(0, 16).replace('T', ' ')} UTC` }));
  writeText(csv, toCsv(CSV_HEADERS, reportCsvRows(r)));
  return {
    counts: r.counts,
    not_marked: r.meetings.filter((m) => m.outcome === 'not_marked').map((m) => `${m.id} ${m.name} (${m.time})`),
    page,
    csv,
    say: `${r.counts.booked} booked: ${r.counts.held} held, ${r.counts.no_show} ${OUTCOME_LABEL.no_show}, ${r.counts.cancelled} cancelled, ${r.counts.rescheduled} rescheduled${r.counts.not_marked ? `, ${r.counts.not_marked} not marked yet` : ''}${r.counts.upcoming ? `, ${r.counts.upcoming} still to come` : ''}; ${r.counts.walkups} walk-ups.`
  };
}
