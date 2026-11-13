// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Where a message goes: the address, channel and step of each touch, and what that changes in the message.
import { whereTo } from '../tracking.mjs';
import { personRoute, stepLabel, sentKind, touchBefore, plannedStep } from '../../../../lib/route.mjs';
import { approvalHash, recipientOf } from '../../../../lib/sendcheck.mjs';

// The fingerprint of a draft as it would go: channel, recipient, subject and body. The critic's verdict, the
// approval and the content-addressed draft file all carry it, so an edit is a new draft.
export const toOf = (c, d) => (d.kind === 'coordinate' ? d.holder || 'colleague' : recipientOf(c.byId[d.id], d.channel, c.settings, { routeStep: !!routeOf(c, d.id)?.[d.touch - 1] }));
export const hashOf = (c, d) => approvalHash(d, toOf(c, d));
// Where a message to this person lands ("LinkedIn", the event app, ...), from their contact and channel.
const whereOf = (c, id) => whereTo(c.byId[id], c.event, c.triage.channels?.[id]);
// This person's route (lib/route.mjs), or null when one channel carries their whole sequence.
export const routeOf = (c, id) => personRoute(c.byId[id], c.event, c.settings, c.triage.channels?.[id]);
// The routing of one message: its route step, else the user's routing for the person.
export const pickAt = (c, id, touch) => {
  const step = routeOf(c, id)?.[touch - 1];
  return step === 'app' ? 'app' : step ? null : c.triage.channels?.[id];
};
export const whereAt = (c, id, touch) => whereTo(c.byId[id], c.event, pickAt(c, id, touch));
// Which inbox this sent touch can be answered in (lib/route.mjs sentKind), with this person's route step to go on.
export const kindAt = (c, id, t, x) => sentKind(x?.sent, { step: plannedStep(x, routeOf(c, id)?.[Number(t) - 1] || null), appName: c.event.app_name });
// Approved to go somewhere else than where the route now sends it: back in todo, to be approved again for this place.
export const whereMoved = (c, id, t) => {
  const appr = c.state[id]?.touches?.[t]?.approved;
  return !!appr?.where && appr.where !== whereAt(c, id, t);
};
// The fields of a message that depend on where it goes.
export function messageFields(c, id, touch, channel, followup) {
  const ct = c.byId[id];
  const steps = routeOf(c, id);
  const where = whereAt(c, id, touch);
  // A first message on LinkedIn to someone not connected goes as an invitation note, wherever it falls in the route.
  const inviteNote = where === 'LinkedIn' && (steps ? !steps.slice(0, touch - 1).includes('linkedin') : !followup);
  return {
    to: channel === 'email' ? ct.email : ct.profile_url || null,
    routed: pickAt(c, id, touch) || undefined,
    invite_note: channel === 'paste' ? inviteNote : undefined,
    app_note:
      channel === 'paste' && where !== 'LinkedIn'
        ? {
            times_in_note: c.settings.app_note_times !== 'in_app',
            event_name_in_note: c.settings.app_note_event_name !== false,
            optout_in_note: c.settings.app_note_optout !== false
          }
        : undefined,
    char_limit: channel === 'paste' ? (inviteNote ? linkedinNoteCap(c) : c.settings.paste_limit) : undefined
  };
}
// A message on a different channel from the one before it: it isn't the same thread, and they may not have seen that one.
export function channelChangeNote(c, id, touch) {
  const steps = routeOf(c, id);
  const before = touchBefore(c.state[id], touch);
  if (!steps || touch < 2 || steps[touch - 1] === steps[before - 1]) return null;
  return `This goes on ${stepLabel(steps[touch - 1], c.event)}; the message before it went on ${stepLabel(steps[before - 1], c.event)}, and they may not have seen that one. It has to make sense alone: never quote it, mention it or say which channel it went on.`;
}
// The latest message before this one with a thread of the given kind (a sent message's or a staged draft's).
export function earlierWith(st, touch, field) {
  for (let t = touch - 1; t >= 1; t--) if (st.touches?.[t]?.[field]) return st.touches[t][field];
  return null;
}
// A LinkedIn connection note's character cap: the user's setting, 300 by default, never above the paste limit.
export const linkedinNoteCap = (c) => Math.min(c.settings.paste_limit, Number(c.settings.linkedin_note_limit) || 300);

// A fresh attempt for drafts held after failing the critic twice: the user asks for it by ID.
// Where a message goes when floorboss sends it itself: email through the email.send recipe, a chat app
// through chat.send, the event app or LinkedIn in the user's browser. Null when floorboss doesn't send it.
export function sendRoute(c, id, channel, touch = 0) {
  const ch = c.settings.sending?.channels || [];
  const ct = c.byId[id];
  // The user said not to reach this person (channel none) since the plan: nothing goes.
  if (c.triage.channels?.[id] === 'none') return null;
  if (channel === 'email')
    return ch.includes('email') && c.config?.connectors?.['email.send'] ? { via: 'email.send', to: recipientOf(ct, 'email', c.settings) } : null;
  const where = whereAt(c, id, touch);
  // A route step decides the channel: a phone number and chat sending don't turn an app or LinkedIn step into a chat.
  const routeStep = !!routeOf(c, id)?.[touch - 1];
  if (where === 'LinkedIn')
    return ch.includes('linkedin') && c.settings.sending?.linkedin_ack && (routeStep || !(ch.includes('chat') && ct.phone))
      ? { via: 'browser', to: recipientOf(ct, 'paste', c.settings, { routeStep }), where }
      : null;
  if (!routeStep && ch.includes('chat') && ct.phone && c.config?.connectors?.['chat.send'] && (c.triage.channels?.[id] === 'chat' || channel !== 'email')) {
    const to = recipientOf(ct, 'paste', c.settings);
    // A chat number needs its country code; a local number ("0160 …") can't be guessed into one.
    return /^\+\d{8,15}$/.test(to)
      ? { via: 'chat.send', to }
      : { via: 'chat.send', to: null, why: `${ct.phone} has no country code: add it (e.g. +49…) to their record` };
  }
  // In the event's app people are found by name: the profile link when there is one, else name and company.
  return ch.includes('app') && (routeStep || !(ch.includes('chat') && ct.phone)) ? { via: 'browser', to: recipientOf(ct, 'paste', c.settings, { routeStep }), where } : null;
}

// The app's request limit counts everyone first written to there, whichever message of their route that is: the
// people with an app message recorded as sent, those with an app note the guard ever let through (it may have reached
// the app, whatever was said about it since: a resend, "it did not go", a page that said it was too long or not
// found, a step dropped or skipped after), plus (at send-list) those added to this list. A resend to the same person
// needs no new place.
export const releasedInApp = (c, id, t, x) =>
  Number(t) !== 0 && !!x?.ever_released_where && (x.ever_released_where === 'browser' ? whereAt(c, id, Number(t)) : x.ever_released_where) !== 'LinkedIn';
export function writtenInApp(c) {
  return new Set(
    Object.entries(c.folded.people)
      .filter(([id, p]) => Object.entries(p?.touches || {}).some(([t, x]) => kindAt(c, id, t, x) === 'app' || releasedInApp(c, id, t, x)))
      .map(([id]) => id)
  );
}
export function appLimitReached(c, id, used) {
  const raw = c.settings.app_request_limit;
  if (raw == null) return false;
  const limit = Number.isInteger(Number(raw)) && Number(raw) >= 0 && typeof raw !== 'boolean' ? Number(raw) : 0;
  return !used.has(id) && used.size >= limit;
}
