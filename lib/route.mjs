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
        .filter(Boolean);
  const route = list.map((x) => {
    const step = WORDS[String(x).trim().toLowerCase()];
    if (!step) throw new Error(`"${String(x).slice(0, 30)}" isn't a channel. Say email, app or linkedin, in the order they go.`);
    return step;
  });
  if (!route.length) throw new Error('Name at least one channel: email, app or linkedin.');
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

// Which inbox a message that went can be answered in: 'email', 'linkedin', 'app', or null (a chat message).
export function sentKind(sent) {
  if (!sent || sent.via === 'chat.send' || /chat/i.test(sent.channel || '')) return null;
  if (sent.via === 'email.send' || !sent.channel || /e-?mail/i.test(sent.channel)) return 'email';
  return /linkedin/i.test(sent.channel) ? 'linkedin' : 'app';
}

// The message before this one that wasn't skipped.
export function touchBefore(st, touch) {
  let t = touch - 1;
  while (t > 1 && st?.touches?.[t]?.skipped) t--;
  return t;
}
