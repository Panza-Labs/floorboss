// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What belongs to one event and what is the user's own setup, reused for every event on this device.
// A rep runs floorboss for event after event: their tools, team, company, voice, offer and sending choices are
// asked once; the goal, the list and anything about this list are asked again for each event.
import { join, dirname } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { configPath } from './paths.mjs';
import { readJson, writeJson } from './jsonio.mjs';
import { nowFrom } from './event.mjs';

// Onboarding answers about one event (or its list). Everything else in onboarding.json's answers is setup.
export const EVENT_ANSWERS = new Set([
  'goal_type',
  'segments_confirmed',
  'meetings_wanted_asked',
  'must_meet_asked',
  'list_source',
  'browser_choice',
  'contact_details',
  'list_has_linkedin',
  'list_url',
  'crm_path',
  'crm_export_skipped',
  'crm_opt_out_none',
  'crm_lookup_skipped',
  'mail_history_skipped',
  'many_slots_ok',
  'app_limit_asked',
  'app_notes_asked',
  'setup_reused',
  // Worked out from this event's goal (say, hiring, then a sales event): never carried to the next event.
  'posture',
  'seller_framing',
  'optout_default_set',
  'basics_asked'
]);
// Settings about one event: saved in its event.json "settings", never in the global config.
// optout_sentence: a job search has none, a sales event does; meeting_place: a stand at one event isn't at the next.
export const EVENT_SETTINGS = new Set(['goal', 'meetings_wanted', 'must_meet', 'app_request_limit', 'app_url', 'meeting_place']);
// Worked out from one event's goal by onboarding-defaults (no opt-out line for a job search, one person per
// company): saved on that event only. The user's own opt-out line and caps stay their setup.
export const EVENT_DEFAULTS = new Set(['optout_sentence', 'company_caps']);

const home = () => dirname(configPath());

// The answers that apply to one event: the setup answers, then that event's own. The current event (the one
// set before events had their own answers) also reads event answers kept at the top level.
// The mock event (examples/mock-event) is a demo: its answers are its own, kept under events.<mock>.answers, and
// it never reads the user's setup answers (a quick setup at home must not make the mock quick, or the other way).
export function answersFor(st, slug, { mock = false } = {}) {
  if (mock && slug) return { ...(st.events?.[slug]?.answers || {}) };
  const setup = Object.fromEntries(Object.entries(st.answers || {}).filter(([k]) => !EVENT_ANSWERS.has(k) || (slug && slug === st.event)));
  return { ...setup, ...(slug ? st.events?.[slug]?.answers || {} : {}) };
}

// Split a patch of answers into setup and this event's: returns the new state.
// mock: the mock event's slug; every answer goes to its own overlay, never to the setup or another event.
export function writeAnswers(st, add, { mock = null } = {}) {
  const next = { ...st, answers: { ...(st.answers || {}) }, events: { ...(st.events || {}) } };
  if (mock) {
    next.events[mock] = { ...(next.events[mock] || {}), answers: { ...(next.events[mock]?.answers || {}), ...add } };
    return next;
  }
  for (const [k, v] of Object.entries(add)) {
    if (EVENT_ANSWERS.has(k) && next.event) {
      const e = { ...(next.events[next.event] || {}), answers: { ...(next.events[next.event]?.answers || {}), [k]: v } };
      next.events[next.event] = e;
      delete next.answers[k];
    } else next.answers[k] = v;
  }
  return next;
}

// Moving to another event (or to a new one): the event answers still at the top level, and event settings
// still in the global config, go to the event they belong to, so the next event starts clean.
export function switchEvent(st, to, { config, saveEventSettings, globalConfigWithout }) {
  const next = { ...st, answers: { ...(st.answers || {}) }, events: { ...(st.events || {}) } };
  const from = st.event;
  if (from && from !== to) {
    const moved = Object.fromEntries(Object.entries(next.answers).filter(([k]) => EVENT_ANSWERS.has(k)));
    if (Object.keys(moved).length) {
      next.events[from] = { ...(next.events[from] || {}), answers: { ...moved, ...(next.events[from]?.answers || {}) } };
      for (const k of Object.keys(moved)) delete next.answers[k];
    }
    const settings = Object.fromEntries(Object.entries(config || {}).filter(([k, v]) => EVENT_SETTINGS.has(k) && v != null));
    if (Object.keys(settings).length) {
      saveEventSettings(from, settings);
      globalConfigWithout([...Object.keys(settings)]);
    }
  }
  next.event = to || null;
  return next;
}

// Whether an event is the mock event. Its folder says so (event.json "mock": true).
export function isMockEvent(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return false;
  return readJson(join(home(), 'events', slug, 'event.json'), null)?.mock === true;
}
// The mock event a setting or an answer is for: the one named (--for-event), else the event of the run going
// on, when that is the mock. Null for a real event: then the user's setup is written as before.
export function mockTarget(named = null) {
  const slug = typeof named === 'string' && named ? named : sessionEvent(nowFrom({}).getTime())?.slug;
  return isMockEvent(slug) ? slug : null;
}

// Events on this device, newest first, with whether they're over.
export function listEvents(nowMs = Date.now()) {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((slug) => ({ slug, ev: readJson(join(dir, slug, 'event.json'), null) }))
    .filter((x) => x.ev && !x.ev.mock)
    .map(({ slug, ev }) => ({
      slug,
      name: ev.name,
      start: ev.start_date,
      end: ev.end_date || ev.start_date,
      over: Date.parse(`${ev.end_date || ev.start_date}T23:59:59Z`) < nowMs
    }))
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
}

// Which event this run is about: chosen at the start of a run and kept while the run goes on (two hours since
// the last step), so a command never acts on another event because it was the last one set up.
const sessionPath = () => join(home(), 'work', 'session-event.json');
export function sessionEvent(nowMs = Date.now()) {
  const s = readJson(sessionPath(), null);
  const age = s ? nowMs - Date.parse(s.at) : Infinity;
  // A session dated ahead of now (written under another clock) counts as stale, never as fresh for ever.
  return s && s.slug !== undefined && age >= 0 && age < 2 * 3600e3 ? s : null;
}
// Each new run (--new-run) gets an id that the steps after it keep: what was worked out in an earlier run (the
// drafting list) is worked out again once in the new one.
export function touchSession(slug, nowMs = Date.now(), { clear = false } = {}) {
  const prev = readJson(sessionPath(), {}) || {};
  const run = clear ? `r${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}` : prev.run || undefined;
  writeJson(
    sessionPath(),
    clear
      ? { at: new Date(0).toISOString(), run }
      : { slug: slug || null, at: new Date(nowMs).toISOString(), ...(run ? { run } : {}), ...(prev.marks ? { marks: prev.marks } : {}) }
  );
}
// How long an event's ledger was when this run first looked at it: what came before is from an earlier run.
export function runLedgerMark(slug, length) {
  const s = readJson(sessionPath(), null);
  if (!s) return 0;
  const marks = s.marks && typeof s.marks === 'object' ? s.marks : {};
  if (Number.isInteger(marks[slug])) return marks[slug];
  writeJson(sessionPath(), { ...s, marks: { ...marks, [slug]: length } });
  return length;
}
export const sessionRun = () => readJson(sessionPath(), {})?.run || null;
