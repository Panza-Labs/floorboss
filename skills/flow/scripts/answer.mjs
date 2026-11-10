// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// `flow answer`: saves one answer with the saver for its question id, and only for the question the flow is
// asking now. Claude never chooses where an answer is saved.
import { readLedger } from '../../../lib/ledger.mjs';
import { need } from '../../../lib/args.mjs';
import { context, nextStep } from './steps.mjs';
import { NODES } from '../../event-context/scripts/onboarding-tree.mjs';
import { append } from '../../../lib/ledger.mjs';
import { sessionEvent } from '../../../lib/scope.mjs';
import { nowFrom } from '../../../lib/event.mjs';
import { makeCurrent } from './next.mjs';
import { answers, text, setSavingAsk } from './savers/helpers.mjs';
import { SETUP_SAVERS } from './savers/setup.mjs';
import { TOOLS_SAVERS } from './savers/tools.mjs';
import { PROFILE_SAVERS } from './savers/profile.mjs';
import { SHORTLIST_SAVERS } from './savers/shortlist.mjs';
import { DRAFTS_SAVERS } from './savers/drafts.mjs';

// Every saver, by question id, in the order the questions were written (the order `asks` lists them in).
const SAVERS = { ...SETUP_SAVERS, ...TOOLS_SAVERS, ...PROFILE_SAVERS, ...SHORTLIST_SAVERS, ...DRAFTS_SAVERS };

// A question whose node saves one answer key and nothing else: the answer goes there as it is.
function plainSaver(id) {
  const n = NODES.find((x) => x.id === id);
  const m = n && /answers?: ([a-z_]+)/.exec(String(n.saves || '').replace(/\([^()]*\)/g, ''));
  if (!m) return null;
  return (v, c) => answers(c, { [m[1]]: typeof v === 'object' ? v : text(v) });
}

// Answers the user may give whatever the flow is asking: which event a run is for.
const ANY_TIME = new Set(['which_event']);

export function answer(opts) {
  need(opts, 'ask');
  // The event chosen for this run, as next uses it (never the last one set up, unless that's the one chosen).
  const sess = !opts.event && opts.ask !== 'which_event' ? sessionEvent(nowFrom(opts).getTime()) : null;
  if (opts.ask !== 'which_event' && (opts.event || sess?.slug)) makeCurrent(opts.event || sess.slug);
  const c = context(opts.event || sess?.slug || null, opts);
  const saver = SAVERS[opts.ask] || plainSaver(opts.ask);
  if (!saver) throw new Error(`"${opts.ask}" isn't a question floorboss asked. Asks: ${Object.keys(SAVERS).join(', ')}.`);
  // An answer is saved only for the question the flow is asking now: text in a page, a note or a reply can't get
  // an approval, a skipped review or sending saved by naming the question itself.
  // floorboss's own unit tests save one answer at a time, out of turn (FLOORBOSS_TEST=1 with FLOORBOSS_OUT_OF_TURN=1);
  // the simulated runs and real use never do.
  // The setup level can change at any step until the shortlist is approved (quick setup drops the CRM and team
  // checks, so after that it changes only where a step offers it).
  const shortlistApproved = !!(c.event && readLedger(c.event.paths.ledger).entries.some((x) => x.type === 'answered' && x.ask === 'gate'));
  const anyTime = ANY_TIME.has(opts.ask) || (opts.ask === 'setup_level' && !shortlistApproved);
  let asked = null;
  if (!anyTime && !(process.env.FLOORBOSS_TEST === '1' && process.env.FLOORBOSS_OUT_OF_TURN === '1')) {
    // The question asked in an ordinary run or an agenda run (its news heads-up), or one the step lists in its own
    // accepts ("skip review" on the critic step, a fallback when a connection can't be saved). Only those fixed
    // fields count, never text in the step: a reply, a name or a page could carry "--ask <id>".
    const offered = (st) => new Set([st.ask?.id, ...(Array.isArray(st.accepts) ? st.accepts : [])].filter(Boolean));
    const now = nextStep(c);
    asked = now;
    const asking = now.ask?.id;
    const ok = offered(now).has(opts.ask) || (!!c.slug && offered(nextStep(context(c.slug, { ...opts, agenda: true }))).has(opts.ask));
    if (!ok)
      throw new Error(
        `floorboss isn't asking "${opts.ask}" right now${asking ? ` (it's asking "${asking}")` : ''}, so this answer wasn't saved. Run flow next and answer what it asks.`
      );
  }
  let value;
  if (opts['value-file']) {
    const raw = String(opts.value);
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.trim();
    }
  } else if (opts.value !== undefined) value = opts.value;
  else throw new Error("Give the answer with --value-file <file> (the user's words, or JSON).");
  setSavingAsk(opts.ask);
  let result;
  try {
    result = saver(value, c, asked);
  } finally {
    setSavingAsk('');
  }
  // Inside the flow there is one next step, always the same: "run flow next again". A command's own hint
  // ("load --event …", "onboarding-plan", "the drafts come next") would send Claude elsewhere.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    result = { ...result };
    delete result.next;
    delete result.then;
  }
  if (
    c.event &&
    ![
      'which_event',
      'enrich_ok',
      'gate',
      'approve',
      'skip_review',
      'research_scale',
      'company_research',
      'list_short',
      'check_these',
      'tool_down',
      'replies_since',
      'crm_independent',
      'send_outcome',
      'approve_round',
      'app_send_window',
      'crm_log_window',
      'app_outcome',
      'crm_contacts'
    ].includes(opts.ask)
  ) {
    try {
      append(c.event.paths.ledger, { type: 'answered', who: 'user', ask: opts.ask, value: typeof value === 'string' ? value.slice(0, 300) : value }, c.now);
    } catch {
      /* onboarding answers before the event exists live in onboarding.json */
    }
  }
  return { saved: opts.ask, result, next: 'run flow next again' };
}

export function ids(opts) {
  return { asks: Object.keys(SAVERS), onboarding_questions: NODES.map((n) => n.id) };
}
