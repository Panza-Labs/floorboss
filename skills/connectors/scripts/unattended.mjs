// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Turning unattended email drafts on for one event (step 2 of 3), and what is on. Nothing here writes the opt-in:
// floorboss's guard asks the user before this call runs (a Claude Code prompt naming the event and its end), and only
// its PostToolUse hook writes unattended/optin/<event>.json, once this call ran. Run outside Claude Code, this only
// says what it would have done.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { home, assertSlug, readChecked, allowedPath } from '../../../lib/paths.mjs';
import { need } from '../../../lib/args.mjs';
import { loadEvent } from '../../../lib/event.mjs';
import { nowMs } from '../../../lib/clock.mjs';
import { DRAFTS_SENTENCE, normSentence, liveOptins, authorisedLines, eventEndMs } from '../../../lib/unattended-drafts.mjs';
import { isOff } from '../../../lib/unattended.mjs';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

export function unattendedOn(opts) {
  need(opts, 'event', 'said-file');
  const slug = assertSlug(opts.event);
  const ev = loadEvent(slug).event;
  if (ev.mock) throw new Error('The mock event never runs on its own.');
  const end = eventEndMs(ev);
  if (!end || nowMs() > end) throw new Error(`${ev.name || slug} is over, or its dates can't be read: nothing goes in for it on its own.`);
  const said = readChecked(allowedPath(String(opts['said-file'])), 4096);
  if (normSentence(said) !== normSentence(DRAFTS_SENTENCE))
    throw new Error(`Those aren't the words that turn this on. The user types, themselves: ${DRAFTS_SENTENCE}`);
  return {
    event: slug,
    // The guard's PostToolUse hook reads this line in this call's output: it writes the opt-in only for a call that ran.
    marker: `FLOORBOSS-OPTIN-OK:${slug}`,
    until: ev.end_date || ev.start_date,
    note: "If you allowed Claude Code's prompt, unattended drafts are on for this event once this call finishes. Nothing goes in yet: the schedule is installed from your own terminal (step 3), and each follow-up is authorised in one prompt after its sequence is approved.",
    step_3_in_your_terminal: `node "${join(ROOT, 'scripts', 'unattended.mjs')}" install-followups`,
    off: `/floorboss:unattended off, or node "${join(ROOT, 'scripts', 'unattended.mjs')}" off`
  };
}

export function unattendedStatus() {
  const now = nowMs();
  const auth = authorisedLines();
  return {
    turned_on_for: liveOptins(now).map((x) => ({ event: x.slug, name: x.optin?.name || x.slug, until: x.optin?.end_date || null, authorised: auth.filter((a) => a.event === x.slug).length })),
    schedule_installed: existsSync(join(home(), 'unattended', 'followups-installed.json')),
    switched_off: isOff(),
    summaries: join(home(), 'unattended'),
    status_in_full: `node "${join(ROOT, 'scripts', 'unattended.mjs')}" status`
  };
}
