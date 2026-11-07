// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Settings: global config.json, overridden per event by event.json's "settings".
import { configPath } from './paths.mjs';
import { readJson, writeJson } from './jsonio.mjs';

export const DEFAULTS = Object.freeze({
  goal: null,
  context_profile: null,
  home_tz: null,
  own_company: null,
  own_domains: [],
  crm: null,
  crm_user_name: null,
  status_map: null,
  touches: 2,
  max_offers: 3,
  per_slot: 1,
  account_cap: null,
  account_caps: {},
  // People per company by size (crm-triage/scripts/sizes.mjs); null means the default sliding scale.
  company_caps: null,
  meeting_minutes: 30,
  hours: { start: '08:00', end: '18:00' },
  meeting_place: null,
  warm_months: 12,
  channels: ['email', 'paste'],
  paste_limit: 600,
  draft_language: 'en',
  optout_sentence: "If this isn't relevant, say so and I won't follow up.",
  // Draft a note to the colleague who holds a contact instead of writing to them (off: the contact is just left alone).
  colleague_notes: false,
  // How careful to be with contacts a coworker owns: leave | ask | warn | mine (null until asked: leave).
  coworker_contacts: null,
  // How sent LinkedIn and app messages get into the CRM: browser | tasks | csv | none (null until asked).
  crm_log: null,
  crm_name: null,
  // Someone messaged who isn't a CRM contact: create them (yes), list them for a yes per batch (ask), or not (no).
  crm_create_contacts: null,
  // Fill empty fields on existing CRM contacts while logging (the LinkedIn URL, a job title): yes | no. A field
  // that has a value is never changed.
  crm_fill_blanks: null,
  // Reading replies in the browser: LinkedIn messages and the event app's inbox, each only on the user's yes
  // (the guard refuses those pages otherwise); log_replies puts the replies found into the CRM log window.
  inbox_read: { linkedin: false, app: false },
  log_replies: false,
  coworker_overrides: {},
  shared_domains: [],
  disclaimer_ack: false,
  connectors: {},
  // Two versions per contact scored by a simulated reader panel. Off by default: its scores don't reliably
  // track what real readers answer, and it doubles the drafting.
  reader_panel: false,
  known_days: 180,
  // From onboarding: how many meetings the user wants (the plan sizes the shortlist from it), and whether
  // messages may go out on LinkedIn (paste messages for people with only a LinkedIn profile).
  meetings_wanted: null,
  // What a "no" in the event's own opt-in column means: 'no_contact' (leave them alone), 'app_only' (no
  // meeting requests in the app, but email is fine), or null until the user says (held meanwhile).
  event_optin_means: null,
  // Must-meet names given in onboarding, before the who-to-meet skill exists.
  must_meet: [],
  // Names of the user's colleagues at the event: never contacted, even from a personal address.
  colleagues: [],
  linkedin_messages: true,
  // Event-app and LinkedIn notes (paste channel). An app meeting request often carries the time and place
  // in its own fields: 'in_app' keeps the times on the card ("pick 12:00 or 13:00 in the app") and out of
  // the note. The event name and the opt-out line can be left out of casual app notes too.
  // Who writes messages (skills/event-outreach/scripts/drafter.mjs): 'floorboss', 'delegate' (the user's
  // own outbound skill or agent drafts everything) or 'blend' (it drafts what it covers). drafter: {name,
  // invoke, type, covers: {channels, kinds}, gaps}. Set in onboarding; null means it hasn't been asked.
  drafting_mode: null,
  drafter: null,
  // Research: searches each researcher may use, and the most one batch may use in all (batches run in turn).
  research_searches_per_person: 10,
  research_search_budget: 200,
  // Meeting requests the event's app lets the user send for this event (Grip, Brella cap them), or null.
  // First messages in the app beyond it wait as backups, in ranking order.
  app_request_limit: null,
  // What existing customers get, set in onboarding: { recent_months, recent, on_deal, other }, each of
  // "warm" (a warm note), "ask" (check with the user), "hold" (leave them alone) or "cold" (treat as new).
  // recent: the deal closed in the last recent_months; on_deal: this contact was on the won deal; other:
  // someone else at a customer. Null: customers are warm (the default).
  customer_rule: null,
  // The user's own address and number: the only places a test send may go.
  own_email: null,
  own_phone: null,
  // Sending (off unless the user turns it on in onboarding). channels: where floorboss may send approved
  // messages itself: "email" (the email.send recipe), "chat" (the chat.send recipe: WhatsApp and the like),
  // "app" and "linkedin" (in the user's own browser). followups: "scheduled" (approved follow-ups go out on
  // their day unless a reply, booking or stop is seen) or "each_round" (the user approves each round).
  // linkedin_ack: the user read and accepted the LinkedIn warning.
  sending: { channels: [], followups: null, linkedin_ack: false },
  // Languages the user can hold a meeting in (the first is the default); messages are only written in these.
  languages: [],
  // The opt-out line in each extra language: {"Spanish": "Si no te encaja, dímelo y no insisto."}.
  optout_sentences: {},
  // Contacts exports (LinkedIn Connections.csv, Gmail or Outlook contacts): people the user already knows.
  known_contacts_paths: [],
  linkedin_note_limit: 300,
  // How long a lost deal or a rejection keeps someone out, in months since the last contact (set in onboarding).
  rejected_months: 6,
  // The user's own words for how to write to their customers ("a friendly hello, no pitch"), kept with the rule
  // and given to every draft for someone the customer rule placed. Empty when they only picked an option.
  customer_said: '',
  app_note_times: 'in_text',
  app_note_event_name: true,
  app_note_optout: true,
  // Emails to people the user already knows end with the opt-out line too (true) or only cold ones do (false).
  // null until setup asks; unanswered, every email keeps it.
  optout_known: null,
  known_export_days: 730,
  // Accounts the CRM implies (a colleague's customer covers everyone there): null until the user decides.
  crm_accounts: null
});

// Constants that aren't settings.
export const CONSTANTS = Object.freeze({
  research_default_n: 50,
  collection_row_cap: 5000,
  email_word_limit: 120,
  match_strong: 0.85,
  match_weak: 0.5,
  research_minutes_per_contact: 1.5,
  research_searches_per_contact: 4
});

// floorboss's own opt-out line in common languages, used when the user kept the English default.
export const OPTOUT_BUILT_IN = Object.freeze({
  German: 'Falls das nicht passt, sagen Sie es einfach, dann melde ich mich nicht wieder.',
  French: "Si ce n'est pas pertinent, dites-le-moi et je ne relancerai pas.",
  Spanish: 'Si no es relevante, dímelo y no volveré a escribir.',
  Dutch: 'Als dit niet relevant is, laat het me weten en ik volg niet op.',
  Portuguese: 'Se não for relevante, diga-me e não volto a escrever.',
  Italian: 'Se non è pertinente, me lo dica e non la ricontatterò.'
});
export const optoutFor = (settings, lang) => {
  if (!settings.optout_sentence) return settings.optout_sentence;
  if (!lang || /^english$/i.test(lang)) return settings.optout_sentence;
  return (
    settings.optout_sentences?.[lang] || (settings.optout_sentence === DEFAULTS.optout_sentence ? OPTOUT_BUILT_IN[lang] : null) || settings.optout_sentence
  );
};
// The line for one reader: none for someone the user already knows when they chose cold emails only
// (optout_known false, asked in setup; unset means every email keeps it).
export const optoutForReader = (settings, lang, known) => (known && settings.optout_known === false ? null : optoutFor(settings, lang));

export function loadConfig() {
  return { ...DEFAULTS, ...readJson(configPath(), {}) };
}

export function saveConfig(patch) {
  const current = readJson(configPath(), {});
  const next = { ...current, ...patch };
  writeJson(configPath(), next);
  return { ...DEFAULTS, ...next };
}

export function effectiveSettings(config, event) {
  const merged = { ...DEFAULTS, ...config, ...(event?.settings || {}) };
  merged.touches = Math.max(1, Math.min(3, Number(merged.touches) || 1));
  return merged;
}
