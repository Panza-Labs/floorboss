// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Savers for the questions about tools and data: coworkers' contacts, the inbox, the CRM (reading, logging,
// new contacts), do-not-contact lists, connections, the mailbox, the calendar, where the attendee list is,
// and looking up contact details.
import { withLock } from '../../../../lib/lock.mjs';
import { lookupCount } from '../../../../lib/normalize.mjs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath, expandHome } from '../../../../lib/paths.mjs';
import { readJson, writeJson } from '../../../../lib/jsonio.mjs';
import { context, nextStep } from '../steps.mjs';
import { readUrl, listFileProblem } from '../../../../lib/security.mjs';
import { saysNoOptOut } from '../../../crm-triage/scripts/mapping-words.mjs';
import { ownerMatch, ownerFromAnswer, fillerOnlyAnswer, ownerQuoted, ownerSaid, ownerSavedMark, NOT_AN_OWNER, OWNERS_SHOWN } from '../../../../lib/names.mjs';
import { crmOwnerValues, otherOwnerValues } from '../../../../lib/event.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { ctxOf as triageCtx, viewOf } from '../../../crm-triage/scripts/view.mjs';
import { ownerIsUserFor, sameHolder } from '../../../crm-triage/scripts/resolve.mjs';
import { shown, plainText, isAgreement, holdOwnerReading, dropOwnerReading, ownerReadingFor, effectsHash, ownerQuestionFor } from '../../../../lib/reading.mjs';
import { HOLDING_GROUPS } from '../../../event-outreach/scripts/commands/context.mjs';
import { parseRoute } from '../../../../lib/route.mjs';
import { answersFor } from '../../../../lib/scope.mjs';
import { parseGap, gapWords } from '../../../../lib/spacing.mjs';
import { approvedDays, gapNote } from './gap.mjs';
import { crmOwners, config, answers, ledger, windowYes, cli, isNo, fileAnswer, writeWorkText, namedFile, pathOf, writeWork, listSourceOnly } from './helpers.mjs';

// What saving `to` as the user's CRM owner would change at each of the user's events (not the mock): who changes group,
// approved unsent messages whose person becomes held (drop_off: any group the send check holds, HOLDING_GROUPS) or stops
// being held (live_again), and at this event how many people the CRM has as the user's and how many as coworkers'. An
// event that keeps its own owner setting changes nothing (own), and one that can't be read now is named (unread), never
// passed over in silence. Read with the view as it would be; nothing is written.
function ownerEffects(c, to) {
  const root = join(c.home, 'events');
  const out = { events: [], own: [], unread: [] };
  if (!existsSync(root)) return out;
  const held = (r) => HOLDING_GROUPS.includes(r?.group);
  for (const slug of readdirSync(root).sort()) {
    let ev = null;
    try {
      ev = readJson(join(root, slug, 'event.json'), null);
      if (!ev || ev.mock || !existsSync(join(root, slug, 'ledger.jsonl'))) continue;
      if (ev.settings?.crm_user_name != null) {
        out.own.push({ slug, name: ev.name || slug, value: ev.settings.crm_user_name });
        continue;
      }
      const base = triageCtx(slug, { now: c.now.toISOString() });
      if (!Object.keys(base.state.people).length) continue;
      const v0 = viewOf(base);
      const s1 = { ...base.settings, crm_user_name: to };
      const v1 = viewOf({ ...base, settings: s1 });
      const name = (id) => shown(v1.contacts.find((x) => x.id === id)?.name || id);
      // A coworker named as written when plainly a name, else quoted, as data (lib/names.mjs ownerSaid).
      const word = (r) => (r?.group === 'colleague' ? `held for ${r.holder ? ownerSaid(r.holder) : 'a coworker'}` : r?.group === 'reach' ? 'to reach' : r?.group === 'skip' ? 'left alone' : r?.group || 'not on the list');
      // Approved for the text saved now, and not gone: what the outbox page offers.
      const approved = (id) =>
        Object.values(base.state.people[id]?.touches || {}).some((x) => x.approved && x.approved.hash === x.hash && !x.sent && !x.revising && !x.dropped && !x.skipped);
      const ids = Object.keys(v1.resolved).filter((id) => /^c\d+$/.test(id));
      const changed = ids.filter((id) => v0.resolved[id]?.group !== v1.resolved[id]?.group).map((id) => ({ id, name: name(id), from: word(v0.resolved[id]), to: word(v1.resolved[id]) }));
      const drop_off = ids.filter((id) => approved(id) && !held(v0.resolved[id]) && held(v1.resolved[id])).map((id) => ({ id, name: name(id) }));
      const live_again = ids.filter((id) => approved(id) && held(v0.resolved[id]) && !held(v1.resolved[id])).map((id) => ({ id, name: name(id) }));
      const holderOf = (id) => v1.resolved[id]?.crm?.holder || null;
      // Read as triage reads it, against every owner in the CRM (crm-triage view.mjs readInputs), not only the owners of
      // the people on this list: a CRM that writes the user in full only on someone else's record still makes a bare
      // first name one to check.
      const mine = v1.inputs?.ownerIsUser || ownerIsUserFor(s1, [...new Set(ids.map(holderOf).filter(Boolean))]);
      const yours = ids.filter((id) => holderOf(id) && mine(holderOf(id))).length;
      // Owners written with the user's first name alone, where the CRM writes their name in full too: held to check.
      const firstOnly = [...(mine.firstOnly || [])];
      out.events.push({
        slug,
        name: ev.name || slug,
        changed,
        drop_off,
        live_again,
        yours,
        held: ids.filter((id) => v1.resolved[id]?.group === 'colleague').length,
        first_only: firstOnly,
        first_only_people: ids.filter((id) => holderOf(id) && firstOnly.includes(holderOf(id))).length
      });
    } catch (e) {
      out.unread.push({ slug, name: ev?.name || slug, why: String(e.message || e).slice(0, 160) });
    }
  }
  return out;
}
// What a read-back's hash covers: the value, the owners it was read against, and everything saving it would change.
const effectsKey = (value, owners, fx) => ({
  value,
  owners,
  events: fx.events.map((x) => [x.slug, x.changed.map((y) => [y.id, y.from, y.to]), x.drop_off.map((y) => y.id), x.live_again.map((y) => y.id)]),
  own: fx.own.map((x) => [x.slug, x.value]),
  unread: fx.unread.map((x) => x.slug)
});
// Two owner values are one person as triage reads names (either way round).
const samePerson = (a, b, domains) => sameHolder(a, b, { domains }) || sameHolder(b, a, { domains });

// A yes to the reading shown: the whole answer is a word of agreement ("yes", "ok", "confirm"), or one with the
// reading's own value beside it ("yes, Sanne de Vries", "confirm: none of these", "yes, that's me").
const LEADING_YES = /^\s*(yes|y|yep|yeah|yup|ok|okay|sure|correct|confirm(?:ed)?)(?![\p{L}\p{N}])[\s,:;.!-]*(.*)$/isu;
function agrees(said, read, target) {
  if (isAgreement(said)) return true;
  const m = LEADING_YES.exec(said);
  if (!m || target == null) return false;
  const rest = m[2].trim();
  if (!rest || isAgreement(rest) || fillerOnlyAnswer(rest)) return true;
  const r = read(rest);
  return (r.owner != null && r.owner === target && r.read_back !== 'question') || (!!r.none && target === NOT_AN_OWNER && r.read_back !== 'question');
}
// An owner value as it is said back: word for word, in quotes, as data (lib/names.mjs ownerQuoted).
const ownerShown = ownerQuoted;
// The question a read-back ends with: the value whole, however long, so the yes covers every word saved.
const saveIt = (value) =>
  value === NOT_AN_OWNER ? 'Save that you are no owner in the CRM (every owner there reads as a coworker)? (yes or no)' : `Save ${ownerQuoted(value, Infinity)} as you in the CRM? (yes or no)`;
const eventLine = (x) =>
  `${plural(x.changed.length, 'person', 'people')} at ${plainText(x.name, 60)}${x.drop_off.length ? ` (${plural(x.drop_off.length, 'approved message')} there would no longer be yours)` : ''}${x.live_again.length ? ` (${plural(x.live_again.length, 'approved message')} there would be ready to send again)` : ''}`;
// The people at this event whose CRM owner is the user's first name alone (resolve.mjs ownerIsUserFor firstOnly): held
// for the user to decide, said plainly.
const firstOnlyLine = (here) =>
  here?.first_only?.length && here.first_only_people
    ? `${plural(here.first_only_people, 'person', 'people')} owned by ${here.first_only
        .slice(0, 3)
        .map((o) => ownerShown(o))
        .join(' or ')} in your CRM ${here.first_only_people === 1 ? 'is' : 'are'} held for you to decide in triage: floorboss can't tell if that's you.`
    : null;
// The user's answer as it is said back: word for word, in quotes, as data, cleaned as the Save line cleans its value
// (lib/names.mjs ownerQuoted), its question mark included.
const echo = (said) => ownerShown(said, 300);
// The reading shown back, waiting on disk for the user's own yes.
function readBack(c, value, fx, all, said, { why = null, lead = '', owners = [], of = null, two = [] } = {}) {
  const here = fx.events.find((x) => x.slug === c.slug) || null;
  const elsewhere = fx.events.filter((x) => x.slug !== c.slug && x.changed.length);
  const reason =
    why === 'question'
      ? `Your answer asks a question, so it isn't saved as it stands. `
      : why === 'only_one'
        ? `Your CRM lists one owner, ${ownerShown(owners[0] ?? value)}, and your answer names nobody, so it is taken as that owner. `
        : why === 'phrase'
          ? `${ownerShown(value)} is the name of an owner in your CRM, written like an answer. If you meant you're not in the CRM, answer "I'm not in the CRM". `
          : why === 'first_name' && of
            ? `Your CRM writes the owner ${ownerShown(of)} with a first name only, and no other owner there has that first name, so your answer is taken as that owner and saved as you wrote it. `
          : why === 'taken_out'
            ? `Your answer holds more than a name, so the name was taken out of it. `
            : why === 'doubtful'
              ? `It isn't plainly a name or an address, so it is shown back before it is saved. `
              : why === 'not_listed'
                ? `It isn't one of the owners your CRM export lists. `
                : why === 'several'
                  ? `It could be more than one owner in your CRM. `
                  : why === 'two_owners'
                    ? `In this CRM it reads as ${two.map((o) => ownerShown(o)).join(' and ')}, different owners, so the people they own would be held for you to decide. `
                    : why === 'list_changed'
                      ? `The owners in your CRM export aren't the ones the question showed (the export changed since), so the number is read against the list as it is now: ${owners
                          .slice(0, OWNERS_SHOWN)
                          .map((o, i) => `${i + 1}. ${ownerShown(o)}`)
                          .join('; ')}. `
                      : '';
  const changes = [here && here.changed.length ? eventLine({ ...here, name: 'this event' }) : null, ...elsewhere.map(eventLine)].filter(Boolean);
  const text = [
    `${lead}You said: ${echo(said)}. ${reason}`.trim(),
    changes.length ? `This changes ${changes.join(', and ')}.` : null,
    here?.drop_off.length ? `At this event, ${here.drop_off.map((x) => `${x.id} ${x.name}`).join(', ')} would no longer be yours, and off the outbox page.` : null,
    firstOnlyLine(here),
    fx.unread.length ? `${fx.unread.map((x) => plainText(x.name, 60)).join(' and ')} can't be read now, so what it changes there isn't known.` : null,
    saveIt(value)
  ]
    .filter(Boolean)
    .join(' ');
  holdOwnerReading(c.home, { event: c.slug || null, target: value, hash: effectsHash(effectsKey(value, all, fx)), created_at: c.now.toISOString(), text, question: saveIt(value), answer: String(said).slice(0, 300) });
  return {
    saved: false,
    pending: true,
    read_as: value,
    say_to_user: text,
    next: 'Show say_to_user to the user word for word and wait for their own reply; save it with flow answer --ask crm_name. Never answer it for them.'
  };
}
// Saves the owner value, then says what it changed: who changes group here (by name) and at the other events (counts),
// approved messages that are ready to send again or no longer the user's, and events that keep their own setting.
function saveOwner(c, value, fx, { none = false, owners = [], elsewhere = [], elsewhereHit = false, prior = null } = {}) {
  const here = fx.events.find((x) => x.slug === c.slug) || null;
  const others = fx.events.filter((x) => x.slug !== c.slug && x.changed.length);
  // This event keeps its own owner setting (its event.json): the change is the user's setting, for the other events.
  const ownHere = !c.event?.event?.mock && c.event?.event?.settings?.crm_user_name != null ? c.event.event.settings.crm_user_name : null;
  const keepsOwn = ownHere != null ? { value: ownHere } : null;
  const saved = config(c, { crm_user_name: value });
  // Saved through this question: a value saved here is never asked about again because it reads like a sentence
  // (onboarding-state flags only a value saved some other way, by an older version or by hand).
  try {
    answers(c, { crm_name_saved: ownerSavedMark(value) });
  } catch {
    /* the setting is saved; the mark only spares a question */
  }
  // A change: this event's derived files (the shortlist, who holds whom) read again with the new value. (A first
  // answer leaves that to the load that comes next.)
  if (prior && here && c.slug)
    try {
      cli('crm-triage', ['view', '--event', c.slug], c);
    } catch {
      /* read again at the next step */
    }
  const you = none ? 'no owner' : ownerShown(value);
  const listedAt = elsewhereHit ? elsewhere.find((x) => x.value === value)?.event : null;
  const lines = [
    here ? `Saved: you are ${you} in the CRM; ${plural(here.yours, 'person', 'people')} on this list ${here.yours === 1 ? 'is' : 'are'} yours there and ${here.held} ${here.held === 1 ? 'is' : 'are'} held for coworkers.` : `Saved: you are ${you} in the CRM.`,
    ...(listedAt ? [`That owner is listed at ${plainText(listedAt, 60)}; this event's CRM export doesn't list them, so nobody on this list is yours here.`] : []),
    ...(keepsOwn ? [`This event keeps its own owner setting (${ownerShown(keepsOwn.value)}), so nothing changes here.`] : []),
    ...(here?.changed.length
      ? [
          `${here.changed.length} ${here.changed.length === 1 ? 'person changes' : 'people change'} group here: ${here.changed
            .slice(0, 20)
            .map((x) => `${x.id} ${x.name} (${x.from}, now ${x.to})`)
            .join('; ')}${here.changed.length > 20 ? `; and ${here.changed.length - 20} more` : ''}.`
        ]
      : []),
    ...(here?.live_again.length ? [`${here.live_again.map((x) => `${x.id} ${x.name}`).join(', ')}: their approved message is ready to send again.`] : []),
    ...(here?.drop_off.length ? [`${here.drop_off.map((x) => `${x.id} ${x.name}`).join(', ')}: their approved message is no longer yours to send, and is off the outbox page.`] : []),
    ...(firstOnlyLine(here) ? [firstOnlyLine(here)] : []),
    ...(others.length ? [`At your other events: ${others.map(eventLine).join('; ')}.`] : []),
    ...(fx.own.filter((x) => x.slug !== c.slug).length ? [`${fx.own.filter((x) => x.slug !== c.slug).map((x) => plainText(x.name, 60)).join(' and ')} keep${fx.own.filter((x) => x.slug !== c.slug).length === 1 ? 's' : ''} its own owner setting, so nothing changes there.`] : []),
    ...(fx.events.some((x) => x.changed.length) ? ['Your own answers about people stand, and do-not-contact, opt-out and uncertain-match holds still apply.'] : [])
  ];
  // What was saved, as it goes back to Claude: a value that isn't plainly a name or an address is quoted, its control
  // and invisible characters out (ownerSaid), so a cell said yes to is data here too, never words to act on.
  const asData = (v) => (typeof v === 'string' && v !== NOT_AN_OWNER ? ownerSaid(v) : v);
  return {
    saved_settings: { ...saved.saved_settings, crm_user_name: asData(value) },
    crm_user_name: asData(value),
    ...(here ? { changed_group: here.changed, ready_again: here.live_again, no_longer_yours: here.drop_off } : {}),
    ...(others.length ? { other_events: others.map((x) => ({ event: x.slug, changed: x.changed.length, no_longer_yours: x.drop_off.length, ready_again: x.live_again.length })) } : {}),
    ...(keepsOwn ? { this_event_keeps_its_own: asData(keepsOwn.value) } : {}),
    ...(none && owners.length ? { note: `No owner in your CRM is you: every owner there reads as a coworker.` } : {}),
    say_to_user: lines.join(' ')
  };
}

export const TOOLS_SAVERS = {
  // "leave them alone" | "ask me each time" | "write…but warn me" | "treat them as mine", optionally with
  // per-coworker lines ("Noa: leave alone; Dana: warn me") or {"mode","overrides":{name: mode}}.
  coworker_contacts: (v, c) => {
    const modeOf = (t) => {
      t = String(t || '').toLowerCase();
      return /warn/.test(t) ? 'warn' : /ask/.test(t) ? 'ask' : /mine|own|as if/.test(t) ? 'mine' : /leave|alone|skip|no\b/.test(t) ? 'leave' : null;
    };
    const o = typeof v === 'object' && v ? v : null;
    const text = o ? '' : String(v);
    const overrides = { ...(o?.overrides || {}) };
    // One rule per coworker, however it's typed: "Dana: leave alone. Noa: warn me, Sam: treat as mine" splits before
    // each "Name:", so a later coworker's mode never lands on an earlier one.
    const parts = text.split(/[;\n]|[.,]\s*(?=[^.;,\n:]{2,60}:)/);
    for (const part of parts) {
      const m = /^\s*([^:]{2,60}):\s*(.+)$/.exec(part);
      if (m && modeOf(m[2])) overrides[m[1].trim()] = modeOf(m[2]);
    }
    const mode = (o && modeOf(o.mode)) || modeOf(parts.find((p) => !/:/.test(p)) || '') || (Object.keys(overrides).length ? 'leave' : null);
    if (!mode) throw new Error('Say one of: leave them alone, ask me each time, write but warn me, treat them as mine (optionally "Name: mode" per coworker).');
    // A coworker named as the user says it ("Ben: warn me") is saved as the CRM's owner value ("Ben Hartley"),
    // which is what the rule is looked up by; a name that is no owner at all is asked again.
    const owners = crmOwners(c);
    if (owners.length)
      for (const k of Object.keys(overrides)) {
        const hit = ownerMatch(k, owners, { first: true });
        if (!hit) throw new Error(`"${k}" isn't an owner in your CRM: ${owners.slice(0, 12).join(', ')}? Say "Name: mode" with one of these.`);
        if (hit !== k) {
          overrides[hit] = overrides[k];
          delete overrides[k];
        }
      }
    // The account-level rule follows: a coworker's company stays theirs unless their contacts count as the user's.
    return config(c, { coworker_contacts: mode, coworker_overrides: overrides, crm_accounts: mode === 'mine' ? 'off' : 'apply' });
  },
  // Reading replies in the browser: each inbox only on a yes for it; "no" leaves both closed.
  // Reading replies in the browser: each inbox only on a yes for it; "no" leaves both closed.
  // {"linkedin":bool,"app":bool,"log_replies":bool}, or the option's words.
  inbox_read: (v, c) => {
    const o = typeof v === 'object' && v ? v : null;
    const t = String(o ? '' : v)
      .toLowerCase()
      .trim();
    const appName = String(c.event?.event?.app_name || '').toLowerCase();
    const yes = /^yes/.test(t);
    const both = yes && (/ and /.test(t.replace(/, and log.*/, '')) || /log the replies/.test(t));
    // A channel the user names with a "not", "no", "never", "except" or "without" before it is a no, whatever else
    // the sentence says ("yes but only Meetwell, not LinkedIn"); "only <one>" leaves the other out.
    const said = (w) => !!w && t.includes(w);
    const refused = (w) =>
      !!w && new RegExp(`\\b(?:not|no|never|except|without|but not)\\b(?:\\s+\\S+){0,2}?\\s+${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
    const only = (w) => !!w && new RegExp(`\\bonly\\s+(?:\\S+\\s+){0,2}?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
    const linkedin = o ? o.linkedin === true : yes && !refused('linkedin') && !only(appName) && (both || said('linkedin'));
    const app = o ? o.app === true : yes && !!appName && !refused(appName) && !only('linkedin') && (both || said(appName));
    config(c, { inbox_read: { linkedin, app }, log_replies: o ? o.log_replies === true : yes && /log/.test(t) });
    return answers(c, { inbox_read_asked: true });
  },
  crm_log: (v, c) => {
    const t = String(typeof v === 'object' ? v.mode || '' : v).toLowerCase();
    const mode = /browser|automatic/.test(t) ? 'browser' : /task/.test(t) ? 'tasks' : /csv|import/.test(t) ? 'csv' : /don|none|^no/.test(t) ? 'none' : null;
    if (!mode) throw new Error("Say one of: in the browser, tasks, CSV, or don't log them.");
    return config(c, { crm_log: mode, ...(typeof v === 'object' && v.crm_name ? { crm_name: String(v.crm_name).slice(0, 40) } : {}) });
  },
  message_route: (v, c) => {
    const t = String(Array.isArray(v) ? v.join(',') : v).toLowerCase().replace(/\([^)]*\)/g, '').trim();
    // Marked asked only once it saved: an answer it can't read is asked again.
    const saved = config(c, { route: parseRoute(t) });
    answers(c, { message_route_asked: true });
    return saved;
  },
  // The days between follow-ups, in the user's words ("3 days", "a week apart", "2 days, then 5", "the default"). One
  // it can't read as whole days from 1 to 14 is refused with what to type, and the question stays open.
  // It's the user's setting for every event (like the route); the answer names each approved follow-up it moves.
  followup_gap: (v, c) => {
    const gap = parseGap(v);
    const before = approvedDays(c);
    const saved = config(c, { followup_gap: gap });
    answers(c, { followup_gap_asked: true });
    const note = gapNote(c, gap, before, approvedDays(c));
    // Said back whole: what was saved, and every approved follow-up it moves or drops.
    return { ...saved, followup_gap: gap ? gapWords(gap) : 'the default', note, say_to_user: note, show: 'Say say_to_user to the user as written.' };
  },
  crm_create_contacts: (v, c) => {
    const t = String(v).toLowerCase();
    const mode = /(?:^yes)|create them/.test(t) ? 'yes' : /ask/.test(t) ? 'ask' : /(?:^no)|list them/.test(t) ? 'no' : null;
    if (!mode) throw new Error('Say yes, ask me each time, or no.');
    return config(c, { crm_create_contacts: mode });
  },
  // The list of people to create in the CRM, for "ask": "yes" creates all listed; anything else declines them.
  crm_create_ok: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: String(v) };
    const ids = (o.ids || []).map(String);
    if (!ids.length) throw new Error('The answer is {"answer":"yes"|"no","ids":[<the ids listed>]}.');
    return ledger(c, {
      type: /^y/i.test(String(o.answer || '')) ? 'crm_create_ok' : 'crm_create_declined',
      who: 'user',
      ids,
      said: String(o.answer || '').slice(0, 120)
    });
  },
  // People about to be emailed who aren't in the connected CRM: add them through the connection, import them, or
  // go on without (those are left off the list to add, and their replies are asked about).
  crm_contacts: (v, c) => {
    const a = String(typeof v === 'object' && v ? v.answer || v.said || '' : v).trim();
    const said = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).slice(0, 200);
    const value = /without|go on|skip|don'?t add|leave them/i.test(a)
      ? 'without'
      : /import/i.test(a)
        ? 'imported'
        : /add|create|now|connect|^y/i.test(a)
          ? 'create'
          : null;
    if (!value) throw new Error('Say "add them now", "imported" or "go on without them".');
    if (value === 'without') {
      // About the people named (one person's "no" at the prompt), else everyone on the list the question named.
      const listed = readJson(join(c.event.paths.dir, 'contact-list.json'), []).map((x) => String(x.id));
      const named = typeof v === 'object' && v && Array.isArray(v.ids) ? v.ids.map(String) : null;
      const ids = named ? listed.filter((id) => named.includes(id)) : listed;
      return ids.length ? ledger(c, { type: 'crm_create_declined', who: 'user', ids, said }) : { nothing_to_add: true };
    }
    // A yes for some people names them: it lets only those be added again after a no.
    const ids = typeof v === 'object' && v && Array.isArray(v.ids) ? v.ids.map(String).slice(0, 200) : undefined;
    return ledger(c, { type: 'answered', who: 'user', ask: 'crm_contacts', value, said, ...(ids ? { ids } : {}) });
  },
  crm_fill_blanks: (v, c) => config(c, { crm_fill_blanks: /(?:^y)|fill/i.test(String(v)) && !/(?:^no)|don/i.test(String(v)) ? 'yes' : 'no' }),
  // A browser window opens only on a plain yes: anything else ("no", "later", "skip it") is a not-now.
  crm_log_window: (v, c) => {
    const said = String(typeof v === 'object' && v ? v.said || v.answer || '' : v).trim();
    if (!windowYes(said)) return ledger(c, { type: 'answered', who: 'user', ask: 'crm_log_window', value: 'not now', said: said.slice(0, 200) });
    return cli('event-outreach', ['open-log-window', '--event', c.slug, '--said', said.slice(0, 200)], c);
  },
  // Notes to the coworker who holds a contact: on or off, asked once with the team (and "notes on" at the gate).
  colleague_notes: (v, c) => {
    const t = String(typeof v === 'object' && v ? (v.answer ?? v.colleague_notes ?? '') : v)
      .trim()
      .toLowerCase();
    const on =
      typeof v === 'object' && v && typeof v.colleague_notes === 'boolean'
        ? v.colleague_notes
        : /^(yes|y|on|draft|sure|ok)\b/.test(t)
          ? true
          : /^(no|n|off|just leave|leave|don'?t|none)\b/.test(t)
            ? false
            : null;
    if (on == null) throw new Error('Say "yes, draft a note to the coworker" or "no, just leave them to my coworker".');
    config(c, { colleague_notes: on });
    answers(c, { colleague_notes_asked: true });
    return {
      colleague_notes: on,
      note: on
        ? 'A short note to the coworker is drafted for each person they hold, approved with the rest.'
        : 'People a coworker holds are left to them, with no note. Say "notes on" at the shortlist to change it.'
    };
  },
  colleagues: (v, c) => {
    config(c, {
      colleagues: isNo(v)
        ? []
        : Array.isArray(v)
          ? v
          : v?.colleagues ||
            String(v)
              .split(/[,;\n]/)
              .map((x) => x.trim())
              .filter(Boolean)
    });
    return answers(c, { colleagues_asked: true });
  },
  accounts: (v, c) => fileAnswer(c, v, 'accounts', { accounts_asked: true }),
  // People and companies that must never be contacted, in one answer: {"dnc": <file>, "accounts": <file>}.
  // Typed names and companies are saved as lists too ("never Globex, they're a competitor"): only a file used to
  // work, and a typed name was lost.
  dnc: (v, c) => {
    if (typeof v === 'string' && !isNo(v) && !existsSync(expandHome(v)))
      throw new Error('Typed names or companies go in as {"dnc":["<person or email>",…],"accounts":["<company>",…]}: people in dnc, companies in accounts.');
    if (typeof v === 'object' && v && (v.dnc || v.accounts)) {
      const asFile = (x, name, body) =>
        Array.isArray(x)
          ? writeWorkText(
              c,
              name,
              body(
                x
                  .map((y) =>
                    String(y)
                      .replace(/[\r\n,]+/g, ' ')
                      .trim()
                  )
                  .filter(Boolean)
              )
            )
          : x;
      const acc = v.accounts
        ? asFile(v.accounts, 'accounts-typed.csv', (l) => `Company,Status\n${l.map((x) => `${x},do not contact this company`).join('\n')}\n`)
        : null;
      const dnc = v.dnc ? asFile(v.dnc, 'dnc-typed.txt', (l) => `${l.join('\n')}\n`) : null;
      if (acc) fileAnswer(c, acc, 'accounts', { accounts_asked: true });
      return dnc ? fileAnswer(c, dnc, 'dnc', { dnc_asked: true, accounts_asked: true }) : answers(c, { dnc_asked: true, accounts_asked: true });
    }
    return fileAnswer(c, v, 'dnc', { dnc_asked: true, accounts_asked: true });
  },
  // Connecting a chosen tool failed: the user's fallback changes the choice itself (an export, typing free
  // time, no mailbox), so the flow goes on knowing the tool isn't there.
  connect_fallback: (v, c) => {
    const o = typeof v === 'object' && v ? v : { answer: v };
    const a = String(o.answer || o.said || '').trim();
    const task = String(o.task || '');
    if (/^(try|retry|again)/i.test(a)) return { retry: true };
    if (task === 'crm.lookup') return answers(c, { crm_choice: /export|csv|file/i.test(a) ? 'export' : 'none', crm_connect_failed: a.slice(0, 200) });
    if (task === 'crm.activity') return answers(c, { crm_activity: 'none', crm_activity_failed: a.slice(0, 200) });
    if (task === 'email.history') return answers(c, { mailbox_choice: 'no', mail_connect_failed: a.slice(0, 200) });
    if (task === 'calendar.busy') return answers(c, { calendar_choice: 'no', calendar_connect_failed: a.slice(0, 200) });
    throw new Error('task is crm.lookup, crm.activity, email.history or calendar.busy.');
  },
  tools: (v, c) => {
    const o = typeof v === 'object' && v ? v : null;
    if (!o)
      throw new Error(
        'The answer is {"crm":"<server>"|"export"|"none","mailbox":true|false,"calendar":true|false}, with what was found and the user\'s changes.'
      );
    const crm = o.crm == null ? null : String(o.crm);
    return answers(c, {
      tools_confirmed: true,
      ...(crm
        ? {
            crm_choice: /^export/i.test(crm) ? 'export' : /^none|^no$/i.test(crm) ? 'none' : 'connector',
            ...(/^(export|none|no)$/i.test(crm) ? {} : { crm_server: crm })
          }
        : {}),
      ...(o.mailbox != null ? { mailbox_choice: o.mailbox ? 'yes' : 'no' } : {}),
      ...(o.calendar != null ? { calendar_choice: o.calendar ? 'yes' : 'no' } : {})
    });
  },
  crm_use: (v, c) =>
    answers(c, {
      crm_choice: /export/i.test(String(v)) ? 'export' : /none|not for this/i.test(String(v)) ? 'none' : 'connector',
      ...(typeof v === 'object' && v.crm_server ? { crm_server: v.crm_server } : {})
    }),
  // "HubSpot, not connected. I exported it to ~/Downloads/export.csv": a file named in the answer that exists is
  // the export, so it isn't asked for again.
  crm_where: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || v.said || '' : v);
    // The CRM's name when they say it ("HubSpot, I exported it"), for the next event's "same setup?".
    const label = (/\b(hubspot|salesforce|pipedrive|zoho|dynamics|attio|close|copper|freshsales|monday|insightly|odoo|sugarcrm)\b/i.exec(t) || [])[1] || null;
    const choice = {
      crm_choice: /spreadsheet/i.test(t) ? 'spreadsheet' : /built|home/i.test(t) ? 'home-made' : /nowhere|none/i.test(t) ? 'none' : 'other',
      ...(label ? { crm_label: `${label[0].toUpperCase()}${label.slice(1).toLowerCase()} (an export)`.replace(/^Hubspot/, 'HubSpot') } : {})
    };
    const named = namedFile(t, { bare: true });
    if (named && c.slug) return { ...fileAnswer(c, named, 'crm', { ...choice, ...(saysNoOptOut(t) ? { crm_opt_out_none: true } : {}) }), export_saved: named };
    return answers(c, choice);
  },
  // A path inside a sentence ("here: ~/Downloads/export.csv") is the file, as for the attendee list.
  crm_export: (v, c) => {
    if (isNo(v)) return answers(c, { crm_export_skipped: true });
    const whole = pathOf(v);
    const said = String(typeof v === 'object' && v ? v.said || v.path || v.file || '' : v);
    const p = whole && existsSync(String(whole).trim()) ? whole : namedFile(said, { bare: true }) || whole;
    // "There's no opt-out column in it, we never added one": kept for the mapping question, which then doesn't
    // ask it again.
    return fileAnswer(c, typeof v === 'object' && v ? { ...v, path: p } : p, 'crm', saysNoOptOut(said) ? { crm_opt_out_none: true } : {});
  },
  // Matched against every owner of the CRM export, the one list the question showed, numbered and quoted (view.mjs
  // crmOwnerList): an answer that is one owner's name and nothing else but "that's me", "I'm", "yep" and the like
  // (lib/names.mjs OWNER_FILLERS), or its number, is that owner as the CRM writes it; "none of these" saves no owner
  // name. Nothing is refused for its wording: only an empty answer, one too long, a number not on the list, or one that
  // names no one ("yes" with several owners, a bare "no"). A value that is plainly a name or an address saves at once;
  // anything else (an owner cell with a label, a tag or a remark, words that are no owner, a negation, a word to Claude,
  // an order), an answer read from more than the user's words (a question mark, "yes" with one owner listed, an owner
  // named like an answer), one that reads as two owners, and any change that would take an approved message from the
  // user at any event, is shown back word for word ("Save "X" as you in the CRM? (yes or no)") and saved only on the
  // user's own yes to it (lib/reading.mjs holdOwnerReading: the value and a hash of everything saving it would change;
  // if any of that changes, the yes saves nothing). Answerable any time (answer.mjs ANY_TIME); do-not-contact, opt-out
  // and uncertain-match holds keep applying.
  crm_name: (v, c) => {
    const said = String(typeof v === 'object' && v ? v.name || v.crm_user_name || v.said || '' : v).trim();
    const all = crmOwners(c);
    const owners = all;
    const listed = owners.length > 0;
    const savedName = readJson(join(c.home, 'config.json'), {}).crm_user_name || null;
    // The value this answer replaces where it is saved: the user's own setting (config.json), or at the mock its own
    // (the mock keeps every setting in its event.json, and nothing it saves reaches the user's other events).
    const mock = !!c.event?.event?.mock;
    const prior = mock ? c.event.event.settings?.crm_user_name ?? null : savedName;
    const effectsOf = (to) => (to === prior ? { events: [], own: [], unread: [] } : mock ? { events: [], own: [], unread: [] } : ownerEffects(c, to));
    const ownDomains = c.cfg?.own_domains || [];
    // Owners at the user's other events, and in older exports read for this one: answers by name, never by number.
    const elsewhere = otherOwnerValues(c.slug || '');
    const older = c.event ? crmOwnerValues(c.event.paths.dir).filter((x) => !all.includes(x)) : [];
    const known = [...new Set([...elsewhere.map((x) => x.value), ...older])];
    // The value saved now, when it was saved through this question (crm_name_saved): given again, it isn't read back again.
    const lastSaved = answersFor(readJson(join(c.home, 'onboarding.json'), {}), c.slug || null, { mock })?.crm_name_saved ?? null;
    const confirmed = lastSaved != null && prior != null && lastSaved === ownerSavedMark(prior) ? prior : null;
    const opts = { listed, saved: savedName, confirmed, known, ownDomains };
    const list = `${owners.slice(0, OWNERS_SHOWN).map((o, i) => `${i + 1}. ${ownerShown(o)}`).join('; ')}${owners.length > OWNERS_SHOWN ? `; and ${owners.length - OWNERS_SHOWN} more (type the name)` : ''}`;
    const offer = owners.length
      ? `The owners: ${list}. Say which of these is you (the name, or its number), or "none of these" if you're not in the CRM (you own no records in it). Show the user this question and the owners, and save only their own answer.`
      : `Your CRM export lists no owners: say your name as your CRM writes it, or "I'm not in the CRM".`;
    // A reading shown before, waiting for the user's yes: a yes to it saves exactly it, once what it changes is checked
    // again; any other answer drops it and is read afresh.
    const waiting = ownerReadingFor(c.home, { event: c.slug || null, nowMs: c.now.getTime() });
    let dropped = false;
    if (!waiting.none) {
      const target = waiting.reading?.target;
      const yes = agrees(said, (t) => ownerFromAnswer(t, owners, opts), target);
      if (yes) {
        dropOwnerReading(c.home);
        if (waiting.stale) throw new Error(`The reading shown before can't be used: ${waiting.stale}. Nothing was saved: answer again with the name, its number, or "none of these".`);
        const fx = effectsOf(target);
        if (effectsHash(effectsKey(target, all, fx)) !== waiting.reading.hash)
          return readBack(c, target, fx, all, waiting.reading.answer, { lead: `What saving it would change has changed since it was shown, so nothing was saved yet. ` });
        return saveOwner(c, target, fx, { none: target === NOT_AN_OWNER, owners, elsewhere, prior });
      }
      dropped = dropOwnerReading(c.home);
    }
    const r = ownerFromAnswer(said, owners, opts);
    const lead = dropped ? 'The reading shown before was dropped, since this is a new answer. ' : '';
    // Refused only for being empty, too long, a number not on the list, or naming no one.
    if (r.ask)
      throw new Error(
        lead +
          (r.ask === 'empty'
            ? `The answer is empty. Nothing was saved. ${offer}`
            : r.ask === 'too_long'
              ? `The answer is longer than 200 characters. Nothing was saved. ${offer}`
              : r.ask === 'not_on_list'
                ? `${ownerShown(said)} isn't a number on the list${owners.length ? '' : ' (there is no list)'}. Nothing was saved. ${offer}`
                : `${ownerShown(said)} names no one${owners.length > 1 ? `, and your CRM lists ${plural(owners.length, 'owner')}` : ''}. Nothing was saved. ${offer}`)
      );
    const value = r.none ? NOT_AN_OWNER : r.owner;
    // Several spellings, or a name triage would also read as another owner: at most one person may be the user (triage
    // holds them all, unclear, when it is more: resolve.mjs ownerIsUserFor), so such a value is read back, saying so.
    let two = [];
    if (!r.none) {
      const mine = ownerIsUserFor({ crm_user_name: value, own_domains: ownDomains, colleagues: c.cfg?.colleagues || [] }, owners);
      const hits = mine.unclear?.size ? [...mine.unclear] : owners.filter((o) => mine(o));
      const people = [];
      for (const h of hits) if (!people.some((p) => samePerson(p[0], h, ownDomains))) people.push([h]);
      if (people.length > 1) two = people.map((p) => p[0]);
    }
    const fx = effectsOf(value);
    const dropping = fx.events.reduce((n, x) => n + x.drop_off.length, 0);
    // A number read against a list other than the one the question showed at this event (the export changed in
    // between: the question notes the list it numbered, onboarding-tree.mjs): read back with the list as it is now.
    const shownQ = ownerQuestionFor(c.home);
    const listChanged = !!r.by_number && !!shownQ && (shownQ.event || null) === (c.slug || null) && shownQ.hash !== effectsHash(owners);
    const why = listChanged ? 'list_changed' : two.length ? 'two_owners' : r.read_back || null;
    if (why || dropping || fx.unread.length) return readBack(c, value, fx, all, said, { why, lead, owners, of: r.first_of || null, two });
    return { ...saveOwner(c, value, fx, { none: !!r.none, owners, elsewhere, elsewhereHit: r.elsewhere, prior }), ...(dropped ? { dropped_reading: true } : {}) };
  },
  customers: (v, c) => {
    const s = String(typeof v === 'object' ? '' : v).toLowerCase();
    // The option's own words decide, before "(recommended)" does: "a warm note (recommended)" is warm for all.
    const all = (x) => ({ recent_months: 6, recent: x, on_deal: x, other: x });
    const rule =
      typeof v === 'object'
        ? v
        : /^a warm note|^warm/.test(s)
          ? all('warm')
          : /^ask me/.test(s)
            ? all('ask')
            : /^leave customers|^leave all/.test(s)
              ? all('hold')
              : /recommended|6 months/.test(s)
                ? { recent_months: 6, recent: 'hold', on_deal: 'warm', other: 'ask' }
                : /warm note for every/.test(s)
                  ? { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' }
                  : /leave all/.test(s)
                    ? { recent_months: 6, recent: 'hold', on_deal: 'hold', other: 'hold' }
                    : /ask/.test(s)
                      ? { recent_months: 6, recent: 'ask', on_deal: 'ask', other: 'ask' }
                      : null;
    if (!rule) throw new Error('The customers answer is one of the options, or a rule object.');
    // Their own words, beyond an option's ("warm, but just a hello and a coffee, no pitch"), go to the drafts.
    // What's left once the options' own words are taken out: two words or more (beyond filler) are the user's guidance.
    const beyond = s
      .replace(
        /\(recommended\)|\brecommended\b|\ba warm note\b|\bwarm note\b|\bwarm\b|\bask me( about)?( each( one)?| each time)?\b|\bleave (customers|them|all)( alone)?\b|\bcustomers\b/g,
        ' '
      )
      .replace(/[^a-z0-9']+/g, ' ')
      .trim();
    // Words that only pick an option ("yes", "the first one", "for all of them") aren't guidance either.
    const left = beyond
      .replace(
        /\b(yes|ok|okay|the|one|default|option|first|thanks|thank you|please|for|all|of|them|every|each|customer|go with|pick|i'?ll take|that|is|fine|a|i|guess|sounds|good|by|me|great|sure)\b/g,
        ' '
      )
      .split(/\s+/)
      .filter(Boolean);
    const said = String(typeof v === 'object' ? v.said || '' : left.length >= 2 ? String(v) : '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const cleanRule = typeof v === 'object' ? { recent_months: rule.recent_months, recent: rule.recent, on_deal: rule.on_deal, other: rule.other } : rule;
    return config(c, { customer_rule: cleanRule, customer_said: said });
  },
  lost_deals: (v, c) => {
    const s = String(typeof v === 'object' ? (v.months ?? v.rejected_months ?? '') : v).toLowerCase();
    const n = /no wait|(?:^none)|(?:^0\b)|never mind|like anyone/.test(s)
      ? 0
      : /(\d+)\s*(year|yr)/.test(s)
        ? 12 * Number(/(\d+)\s*(?:year|yr)/.exec(s)[1])
        : /^\D*(\d+)/.test(s)
          ? Number(/(\d+)/.exec(s)[1])
          : /recommended/.test(s)
            ? 6
            : null;
    if (n == null || !Number.isInteger(n) || n < 0 || n > 120)
      throw new Error('The lost-deals answer is one of the options, or a whole number of months (0 for no wait).');
    config(c, { rejected_months: n });
    return answers(c, { lost_deals_asked: true });
  },
  mailbox_use: (v, c) => answers(c, { mailbox_choice: /(?:^y)|yes/i.test(String(v)) ? 'yes' : 'no' }),
  known_contacts: (v, c) => {
    if (isNo(v)) return answers(c, { known_asked: true });
    const p = allowedPath(pathOf(v), { list: true });
    const bad = existsSync(p) ? listFileProblem(p, 0, 'known') : `${p} isn't there.`;
    if (bad) throw new Error(`${bad} Nothing was saved.`);
    const have = c.cfg.known_contacts_paths || [];
    config(c, { known_contacts_paths: [...new Set([...have, p])] });
    return answers(c, { known_asked: true });
  },
  calendar_use: (v, c) => answers(c, { calendar_choice: /(?:^y)|yes/i.test(String(v)) ? 'yes' : 'no' }),
  // Claude reads the user's words into days ({"days":[…]}); the typed words are kept with them. The old
  // sentence parser is the fallback for a plain string.
  free_time: (v, c) => {
    if (/^\s*keep (them )?all/i.test(String(typeof v === 'object' && v ? v.said || '' : v))) return answers(c, { many_slots_ok: true });
    const o = typeof v === 'object' && v ? v : { free: String(v) };
    const busy = c.event && existsSync(join(c.event.paths.work, 'calendar-busy.json')) ? ['--busy-file', join(c.event.paths.work, 'calendar-busy.json')] : [];
    if (Array.isArray(o.days))
      return cli(
        'slot-finder',
        [
          'build',
          '--event',
          c.slug,
          '--days-file',
          writeWork(c, 'free-days.json', { days: o.days, notes: o.notes || [] }),
          ...busy,
          ...(o.zone ? ['--zone', o.zone] : [])
        ],
        c
      );
    return cli('slot-finder', ['build', '--event', c.slug, '--free', o.free, ...busy, ...(o.zone ? ['--zone', o.zone] : [])], c);
  },
  list_source: (v, c) => {
    // Saved only while the flow is asking it: the answer file is one Claude writes, so an answer given at any
    // other moment (an instruction in a page asking to "save the list source") lets no site in.
    if (nextStep(context(c.slug, {})).ask?.id !== 'list_source')
      throw new Error(
        "floorboss isn't asking where the attendee list is right now, so this answer wasn't saved. Run flow next and answer the question it asks."
      );
    // A path inside a sentence ("it's at ~/Downloads/x.csv, the organiser sent it") is the file too.
    const whole = pathOf(v);
    const p =
      whole && /[\/\\].*\.(csv|tsv|txt|xlsx?)$/i.test(String(whole).trim())
        ? whole
        : namedFile(String(typeof v === 'object' && v ? v.said || v.path || v.file || '' : v));
    if (p && /[\/\\].*\.(csv|tsv|txt|xlsx?)$/i.test(String(p).trim())) {
      const r = cli('crm-triage', ['inputs', '--event', c.slug, '--kind', 'attendees', '--file', String(p).trim()], c);
      return { ...r, ...answers(c, { list_source: 'export' }) };
    }
    // A link (the event's speaker or attendee page) is read from the public page: the link is kept for that step.
    const url = (/https?:\/\/\S+/.exec(String(typeof v === 'object' && v ? v.url || '' : v)) || [])[0];
    if (url) {
      // The one place the event's own site is let into the browser's list of pages it may open during a run:
      // the link the user gave as their answer, kept with their words.
      const said = String(typeof v === 'object' && v ? v.said || v.url || '' : v).slice(0, 300);
      const u = readUrl(url.replace(/[).,]+$/, ''), { ports: true });
      const host = (u?.host || '').replace(/^www\./, '');
      // The list page itself (scheme, host, port and path, no query or fragment): the guard opens it without
      // asking, and asks before any other page on that site.
      const page = u && !u.odd && u.host ? `${u.scheme}//${u.host}${u.port ? `:${u.port}` : ''}${u.path}` : null;
      if (c.event && host && said.toLowerCase().includes(host)) ledger(c, { type: 'site_allowed', who: 'user', host, said, ...(page ? { url: page } : {}) });
      return answers(c, { list_source: 'app', list_url: url.replace(/[).,]+$/, '') });
    }
    return listSourceOnly(v, c);
  },
  browser: (v, c) => answers(c, { browser_choice: /^now/i.test(String(v)) ? 'now' : /later/i.test(String(v)) ? 'later' : 'never' }),
  // "yes, with apollo": that tool looks the missing people up (connected first, lookups agreed first).
  contact_details: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v);
    const tool = ((/with (.+?)(?:\s*\(|$)/i.exec(t) || [])[1] || '').trim() || (typeof v === 'object' && v?.server) || null;
    const mode = /csv/i.test(t) ? 'csv' : tool ? 'mcp' : /decide|later/i.test(t) ? 'later' : 'app';
    return answers(c, { contact_details: mode, ...(mode === 'mcp' ? { enrich_server: tool } : {}) });
  },
  // How many lookups the user agrees to (the credits): all of them, the top n, a CSV instead, or none.
  enrich_ok: (v, c) => {
    const t = String(typeof v === 'object' && v ? v.answer || '' : v).toLowerCase();
    const step = nextStep(context(c.slug, {}));
    // Only while the flow asks it, and only people on the list with no email now: the count can't grow past them.
    if (step.ask?.id !== 'enrich_ok') throw new Error("floorboss isn't asking about lookups right now, so this answer wasn't saved. Run flow next.");
    const stored = readJson(join(c.event.paths.derived, 'contacts.json'), []);
    const noEmail = new Set(stored.filter((x) => x && !x.email).map((x) => x.id));
    const byId = Object.fromEntries(stored.filter(Boolean).map((x) => [x.id, x]));
    const ids = (step.ask.ids || []).filter((id) => noEmail.has(id));
    if (/csv/.test(t)) {
      answers(c, { contact_details: 'csv' });
      return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_ok', value: 'csv' });
    }
    if (/^\s*(no|skip|none|not now)\b/.test(t)) return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_ok', value: 'skip' });
    const n = lookupCount(t, ids.length);
    const chosen = ids.slice(0, n);
    // Under the lookup lock: a lookup being counted at this moment can't write the old window back over this one.
    withLock('enrich', () =>
      writeJson(join(c.home, 'enrich-window.json'), {
        event: c.slug,
        ids: chosen,
        // Who may be looked up, as the list has them: a lookup carries one of these people and nothing else.
        people: chosen.map((id) => {
          const p = byId[id] || {};
          return { id, name: p.name || '', company: p.company || '', title: p.title || '', profile_url: p.profile_url || '' };
        }),
        count: chosen.length,
        used: 0,
        until: new Date(c.now.getTime() + 30 * 60e3).toISOString(),
        said: t.slice(0, 120)
      })
    );
    return ledger(c, { type: 'answered', who: 'user', ask: 'enrich_ok', value: `yes:${chosen.join(',')}` });
  },
};
