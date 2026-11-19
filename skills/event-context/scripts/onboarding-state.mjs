// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The state the onboarding tree reads, gathered from the home folder: the scan, the settings, the event, the
// answers so far, the slots and the list. Shared by the onboarding-plan verb and the flow's `next`.
import { join, dirname } from 'node:path';
import { configPath } from '../../../lib/paths.mjs';
import { readJson } from '../../../lib/jsonio.mjs';
import { loadConfig } from '../../../lib/config.mjs';
import { loadEvent, nowFrom, otherOwnerValues } from '../../../lib/event.mjs';
import { ownerSettingRead, sentenceLike, plainOwnerValue, ownerSavedMark } from '../../../lib/names.mjs';
import { ownerReadingFor } from '../../../lib/reading.mjs';
import { crmOwnerList } from '../../crm-triage/scripts/view.mjs';
import { ownerIsUserFor } from '../../crm-triage/scripts/resolve.mjs';
import { planQuestions } from './onboarding-tree.mjs';
import { answersFor, EVENT_SETTINGS, isMockEvent } from '../../../lib/scope.mjs';
import { effectiveSettings } from '../../../lib/config.mjs';
import { contextFor } from '../../../lib/event.mjs';
import { parseInsights } from './context-check.mjs';
import { inventoryView } from '../../../lib/harness.mjs';

export function onboardingState(slug = null) {
  const dir = dirname(configPath());
  const st = readJson(join(dir, 'onboarding.json'), { rounds: {}, event: null, answers: {} });
  // Outside Claude Code nothing connected is offered (lib/harness.mjs).
  const inv = inventoryView(readJson(join(dir, 'inventory.json'), null));
  const global = loadConfig();
  let ev = null,
    slots = 0,
    list = null,
    days = null,
    crmOwners = () => [],
    crmOwnerFlag = null,
    crmOwnerReading = null;
  // A mock event left as the current one (by an older version) is never the event of a run nobody named.
  const current = isMockEvent(st.event) ? null : st.event;
  const eventSlug = slug || current;
  // Another event than the current one never reads the current one's goal or must-meets from the global config.
  let cfg = eventSlug && eventSlug !== st.event ? Object.fromEntries(Object.entries(global).filter(([k]) => !EVENT_SETTINGS.has(k))) : global;
  if (eventSlug) {
    try {
      const e = loadEvent(eventSlug);
      ev = e.event;
      cfg = effectiveSettings(cfg, ev);
      // The owners the crm_name question shows, every one of them: the one list its answer is read against (crm-triage
      // crmOwnerList), read from the export only when the question is asked.
      let ownerList = null;
      crmOwners = () => (ownerList ||= crmOwnerList({ paths: e.paths, event: e.event }));
      // The CRM owner that is the user, read as loadEvent reads it. A saved sentence that names no owner here and no
      // owner at the user's other events is flagged, and the crm_name question asked again (onboarding-tree.mjs), unless
      // the user saved that value through the question itself (crm_name_saved). So is a value that reads as two
      // different owners in this event's CRM ("B. Janssens" with Bram and Bas Janssens): triage holds their people until
      // the user says which one they are (crm-triage resolve.mjs ownerIsUserFor).
      const ans0 = answersFor(st, eventSlug, { mock: ev?.mock === true });
      if (sentenceLike(cfg.crm_user_name) && ownerSavedMark(cfg.crm_user_name) !== ans0.crm_name_saved) {
        const read = ownerSettingRead(cfg.crm_user_name, crmOwners(), { listed: otherOwnerValues(eventSlug).map((x) => x.value) });
        if (read.read_from) cfg = { ...cfg, crm_user_name: read.value };
        if (read.unmatched) crmOwnerFlag = { saved: cfg.crm_user_name };
      }
      // A saved value that isn't plainly a name or an address, and wasn't saved through the question on the user's yes
      // (saved by hand, or by an older version): asked again, shown quoted.
      if (!crmOwnerFlag && typeof cfg.crm_user_name === 'string' && !/^not an owner/.test(cfg.crm_user_name) && !plainOwnerValue(cfg.crm_user_name) && ownerSavedMark(cfg.crm_user_name) !== ans0.crm_name_saved)
        crmOwnerFlag = { saved: cfg.crm_user_name, unconfirmed: true };
      if (!crmOwnerFlag && cfg.crm_user_name && !/^not an owner/.test(cfg.crm_user_name)) {
        const unclear = [...ownerIsUserFor(cfg, crmOwners()).unclear];
        if (unclear.length) crmOwnerFlag = { saved: cfg.crm_user_name, unclear };
      }
      // A reading of the last crm_name answer waiting for the user's yes.
      const w = ownerReadingFor(dir, { event: eventSlug, nowMs: nowFrom({}).getTime() });
      if (w.reading) crmOwnerReading = { text: w.reading.text, question: typeof w.reading.question === 'string' ? w.reading.question : null };
      // A mock profile in the settings (left there by an older version of the mock) isn't the user's.
      if (!ev.mock && /^mock-/.test(cfg.context_profile || '')) cfg = { ...cfg, context_profile: null };
      slots = (readJson(e.paths.slots, { slots: [] }).slots || []).length;
      const contacts = readJson(join(e.paths.derived, 'contacts.json'), null) || readJson(e.paths.contacts, null)?.contacts;
      if (Array.isArray(contacts)) list = { rows: contacts.length, with_email: contacts.filter((c) => c.email).length };
      days = Math.round((Date.parse(`${ev.start_date}T12:00:00Z`) - nowFrom({}).getTime()) / 864e5);
    } catch {
      ev = null;
    }
  }
  if (!ev && /^mock-/.test(cfg.context_profile || '')) cfg = { ...cfg, context_profile: null };
  // The mock reads only its own answers: the user's setup level, tools and team never steer the demo.
  // What what-you-bring already says: who the sender is ("About me") and how many insights it has.
  let bring = null;
  try {
    const t = cfg.context_profile ? contextFor(cfg, ev || {}).whatYouBring || '' : '';
    bring = { about: /^\*\*About me:\*\*[ \t]*[^<\s]/m.test(t), insights: parseInsights(t).length };
  } catch {
    bring = null;
  }
  return {
    inv,
    cfg,
    ev,
    bring,
    ans: answersFor(st, ev ? eventSlug : null, { mock: ev?.mock === true }),
    slots,
    list,
    days,
    crmOwners,
    crmOwnerFlag,
    crmOwnerReading,
    onboarding: { ...st, event: ev ? eventSlug : current },
    home: dir
  };
}

export function onboardingPlan(slug = null, { batch } = {}) {
  const s = onboardingState(slug);
  const plan = planQuestions(s, batch ? { batch } : {});
  return {
    ...plan,
    ...(s.days != null && s.days <= 7
      ? { short_on_time: `The event is ${s.days <= 0 ? 'under way' : `${s.days} days away`}: keep each question short, but don't skip them.` }
      : {})
  };
}
