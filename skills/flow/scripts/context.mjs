// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Everything `next` reads, in one object (the setup answers, the settings, the event and its ledger), and where
// floorboss's own scripts are.
import { join } from 'node:path';
import { loadEvent, nowFrom } from '../../../lib/event.mjs';
import { readLedger, fold } from '../../../lib/ledger.mjs';
import { todayKeyIn } from '../../../lib/tz.mjs';
import { onboardingState } from '../../event-context/scripts/onboarding-state.mjs';
import { INPUT_FILES, inputFile as triageInputFile } from '../../crm-triage/scripts/view.mjs';

export const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
export const script = (skill) => join(ROOT, 'skills', skill, 'scripts', 'cli.mjs');

// Paths and files the steps look at: an input where crm-triage reads it, or null when there is none or it
// can't be read (crm-triage itself stops and says why).
const inputFile = (e, kind) => {
  try {
    return triageInputFile(e, kind);
  } catch {
    return null;
  }
};

// Everything `next` reads, in one object.
export function context(slug, opts = {}) {
  const ob = onboardingState(slug);
  const now = nowFrom(opts);
  const out = { now, ob, cfg: ob.cfg, slug: slug || ob.onboarding.event || null, home: ob.home, event: null, agendaWanted: !!opts.agenda };
  if (out.slug && ob.ev) {
    const e = loadEvent(out.slug);
    const { entries, damaged } = readLedger(e.paths.ledger);
    out.event = {
      ...e,
      entries,
      state: fold(entries, damaged),
      today: todayKeyIn(e.event.time_zone, now),
      inputs: Object.fromEntries(Object.keys(INPUT_FILES).map((k) => [k, inputFile(e, k)]))
    };
  }
  return out;
}
