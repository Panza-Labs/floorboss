// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The route: which channel each message of a person's sequence goes on, in order. One route for the event; each
// person's is that route with the steps they can't be reached on left out.
export const DEFAULT_ROUTE = Object.freeze(['email', 'app', 'linkedin', 'email']);
export const MAX_ROUTE = 8;

const WORDS = { email: 'email', mail: 'email', 'e-mail': 'email', app: 'app', 'event-app': 'app', event: 'app', linkedin: 'linkedin', li: 'linkedin' };

// The route from an answer: a list, or words ("email, app, linkedin, email", "email then linkedin").
export function parseRoute(v) {
  const list = Array.isArray(v)
    ? v
    : String(v ?? '')
        .toLowerCase()
        .replace(/event app/g, 'app')
        .split(/\s*(?:,|->|→|>|\+|\bthen\b|\band\b|\s)\s*/)
        .filter((w) => w && w !== 'only' && w !== 'just');
  const route = list.map((x) => {
    const step = WORDS[String(x).trim().toLowerCase()];
    if (!step) throw new Error(`"${String(x).slice(0, 30)}" isn't a channel. Say email, app or linkedin, in the order they go.`);
    return step;
  });
  if (!route.length) throw new Error('Name at least one channel: email, app or linkedin.');
  // "email only" keeps the follow-ups and rules out the other channels (the offered "email, email"), never one message.
  if (route.length === 1 && !Array.isArray(v) && /\b(?:only|just)\b/i.test(String(v))) return [route[0], route[0]];
  if (route.length > MAX_ROUTE) throw new Error(`A sequence can have at most ${MAX_ROUTE} messages.`);
  return route;
}

// Whether the route decides the sequence: an explicit touches setting with no route keeps every message on one channel.
export const routeApplies = (settings) => !!settings?.route || !settings?.touches_set;

const canUse = (step, ct, event, settings) => {
  const chans = settings.channels || ['email'];
  if (step === 'email') return !!ct.email && chans.includes('email');
  if (!chans.includes('paste')) return false;
  if (step === 'linkedin') return /linkedin\.com\//i.test(ct.profile_url || '') && settings.linkedin_messages !== false;
  return !!event.app_name && !event.no_app;
};

// This person's steps, in order, or null when one channel carries the whole sequence: the user routed them by hand
// (pick), a chat number carries it, the settings say so, or the route reaches them nowhere.
export function personRoute(ct, event, settings, pick = null) {
  if (!ct || pick || !routeApplies(settings)) return null;
  if (!ct.email && ct.phone && (settings.sending?.channels || []).includes('chat')) return null;
  const steps = (settings.route || DEFAULT_ROUTE).filter((s) => canUse(s, ct, event, settings));
  return steps.length ? steps : null;
}

// How many messages the settings ask for at most: the route's length, or the touches setting.
export const routeLength = (settings) => (routeApplies(settings) ? (settings.route || DEFAULT_ROUTE).length : settings.touches);

export const stepLabel = (step, event) => (step === 'email' ? 'email' : step === 'linkedin' ? 'LinkedIn' : event?.app_name || 'the event app');

// The channel a message was meant for, from what the send itself doesn't say: the where its approval names, else
// its route step. x: the touch; routeStep: this person's route at that touch, or null.
export const plannedStep = (x, routeStep) => (x?.approved?.where ? (x.approved.where === 'LinkedIn' ? 'linkedin' : 'app') : routeStep || null);

// Which inbox a message that went can be answered in: 'email', 'linkedin', 'app', or null (a chat message).
// step: the channel it was meant for (plannedStep). A label is the record of where it went, so it comes first, with
// the event's app name read before any test for "chat" (an app can be called Wizzlechat). No label (a status paste, a
// send recorded with no channel, a CRM task): an inbox read says where it was found, else the step decides.
export function sentKind(sent, { step = null, appName = null } = {}) {
  if (!sent || sent.via === 'chat.send') return null;
  if (sent.via === 'email.send') return 'email';
  const label = String(sent.channel || '').trim();
  const app = String(appName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (app && new RegExp(`(?<![\\p{L}\\d])${app}(?![\\p{L}\\d])`, 'iu').test(label)) return 'app';
  if (/chat/i.test(label)) return null;
  if (label) return /e-?mail/i.test(label) ? 'email' : /linkedin/i.test(label) ? 'linkedin' : 'app';
  if (sent.source === 'mailbox') return 'email';
  if (['linkedin', 'app'].includes(sent.source)) return sent.source;
  return step === 'linkedin' || step === 'app' ? step : 'email';
}

// The message before this one that wasn't skipped.
export function touchBefore(st, touch) {
  let t = touch - 1;
  while (t > 1 && st?.touches?.[t]?.skipped) t--;
  return t;
}
