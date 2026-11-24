// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The route: which channel each message of a person's sequence goes on, in order. One route for the event; each
// person's is that route with the steps they can't be reached on left out.
// A LinkedIn address by its site, not by "linkedin.com/" appearing somewhere in it (evil.example/linkedin.com/in/x).
// A cell from a list can carry more than the address (a label, brackets, quotes, a markdown link): each address or bare
// site in it is judged on its own, by where its site name ends.
export const isLinkedInUrl = (u) => {
  const cell = String(u || '').slice(0, 2000);
  const sites = cell.match(/(?<![\w.\/?=&%:#@-])(?:[a-z]{2,6}:\/+\s?|\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?![\w.@-])/gi) || [];
  return sites.some((s) => /^(?:[a-z]{2,6}:\/+\s?|\/\/)?(?:[a-z0-9-]+\.)*linkedin\.com$/i.test(s));
};

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

// The route less the channels the user didn't choose (settings.reach: the channels besides email, asked before any
// drafting; null: not asked, every channel). The user's own route and count are never saved over: the choice is applied
// here, each time the route is read. Nothing is drafted for a channel left out.
// - The user's own order (settings.route): its steps on chosen channels, in order; with none left but email, two emails.
// - Otherwise: an email first and last, each chosen channel once between them (the event app, then LinkedIn), and
//   emails for the rest of the count. A count too small to fit every chosen channel between two emails is raised to fit.
export function routePlan(settings) {
  const base = settings?.route || DEFAULT_ROUTE;
  if (!Array.isArray(settings?.reach)) return { route: [...base], kept: null, raised: null };
  const reach = settings.reach;
  if (settings.route) {
    const kept = [];
    base.forEach((s, i) => (s === 'email' || reach.includes(s)) && kept.push(i));
    if (kept.length > 1 || (kept.length === 1 && base.length === 1)) return { route: kept.map((i) => base[i]), kept, raised: null };
    return { route: ['email', 'email'], kept: null, raised: null };
  }
  const mids = DEFAULT_ROUTE.slice(1, -1).filter((s) => reach.includes(s));
  const want = settings.touches_set && Number.isInteger(settings.touches) ? settings.touches : null;
  if (want == null) {
    const kept = [];
    DEFAULT_ROUTE.forEach((s, i) => (s === 'email' || reach.includes(s)) && kept.push(i));
    return { route: kept.map((i) => DEFAULT_ROUTE[i]), kept, raised: null };
  }
  const n = Math.max(want, mids.length + 2);
  return { route: ['email', ...mids, ...Array(n - 1 - mids.length).fill('email')], kept: null, raised: n > want ? n : null };
}
export const chosenRoute = (settings) => routePlan(settings).route;

// The days before each follow-up once channels are left out of the user's own route (routePlan's kept): each message
// keeps the day it had, so the gap before it is the sum of the gaps of the steps left out before it. null: as set.
export function chosenGaps(settings) {
  const g = settings?.followup_gap;
  if (!Array.isArray(g) || g.length < 2) return null;
  // Only the user's own route has days to keep: the default is built from the chosen channels, its gaps as set.
  if (!settings.route) return null;
  const { kept } = routePlan(settings);
  if (!kept || kept.length === settings.route.length) return null;
  const gapBefore = (i) => g[Math.min(Math.max(i - 1, 0), g.length - 1)];
  const out = [];
  for (let k = 1; k < kept.length; k++) {
    let sum = 0;
    for (let i = kept[k - 1] + 1; i <= kept[k]; i++) sum += gapBefore(i);
    out.push(sum);
  }
  return out.length ? out : null;
}

// In words, for the user: which channels a route has between its emails.
export const reachWords = (reach, event) => {
  const names = (reach || []).map((s) => stepLabel(s, event));
  return names.length ? names.join(' and ') : null;
};

// Whether the route decides the sequence: an explicit touches setting with no route keeps every message on one channel.
export const routeApplies = (settings) => !!settings?.route || Array.isArray(settings?.reach) || !settings?.touches_set;

const canUse = (step, ct, event, settings) => {
  const chans = settings.channels || ['email'];
  if (step === 'email') return !!ct.email && chans.includes('email');
  if (!chans.includes('paste')) return false;
  if (step === 'linkedin') return isLinkedInUrl(ct.profile_url) && settings.linkedin_messages !== false;
  return !!event.app_name && !event.no_app;
};

// This person's steps, in order, or null when one channel carries the whole sequence: the user routed them by hand
// (pick), a chat number carries it, the settings say so, or the route reaches them nowhere.
export function personRoute(ct, event, settings, pick = null) {
  if (!ct || pick || !routeApplies(settings)) return null;
  if (!ct.email && ct.phone && (settings.sending?.channels || []).includes('chat')) return null;
  const steps = chosenRoute(settings).filter((s) => canUse(s, ct, event, settings));
  return steps.length ? steps : null;
}

// How many messages the settings ask for at most: the route's length, or the touches setting.
export const routeLength = (settings) => (routeApplies(settings) ? chosenRoute(settings).length : settings.touches);

export const stepLabel = (step, event) => (step === 'email' ? 'email' : step === 'linkedin' ? 'LinkedIn' : event?.app_name || 'the event app');

// The channel a message was meant for, from what the send itself doesn't say: the where its approval names, else
// its route step. x: the touch; routeStep: this person's route at that touch, or null.
export const plannedStep = (x, routeStep) => (x?.approved?.where ? (x.approved.where === 'LinkedIn' ? 'linkedin' : 'app') : routeStep || null);

// Which inbox a message that went can be answered in: 'email', 'linkedin', 'app', or null (a chat message).
// step: the channel it was meant for (plannedStep). On a LinkedIn or app step the step decides, and a label moves it
// only when it plainly names another inbox: to email only when it is nothing but an email word, to LinkedIn or the app
// when it names that one alone. On any other step the label is the record of where it went, with the event's app
// name read before any test for "chat" (an app can be called Wizzlechat). No label (a status paste, a send recorded with
// no channel, a CRM task): an inbox read says where it was found, else the step decides.
export function sentKind(sent, { step = null, appName = null } = {}) {
  if (!sent || sent.via === 'chat.send') return null;
  if (sent.via === 'email.send') return 'email';
  const label = String(sent.channel || '').trim();
  const app = String(appName || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namesApp = (app && new RegExp(`(?<![\\p{L}\\d])${app}(?![\\p{L}\\d])`, 'iu').test(label)) || /(?<![\p{L}\d])app(?![\p{L}\d])/iu.test(label);
  const namesLinkedIn = /linked\s*-?\s*in|inmail|(?<![\p{L}\d])li(?![\p{L}\d])/iu.test(label);
  const namesEmail = /e-?mail/i.test(label);
  if (label && (step === 'linkedin' || step === 'app')) {
    // Only a label that is nothing but email ("email", "by email", "emailed") moves it to email: "not email", "DM, not
    // email" and "Swapcard, not email" stay with the step.
    if (/^[^\p{L}\p{N}]*(?:by |via )?e-?mail(?:ed)?[^\p{L}\p{N}]*$/iu.test(label)) return 'email';
    if (namesLinkedIn && !namesApp) return 'linkedin';
    if (namesApp && !namesLinkedIn) return 'app';
    return step;
  }
  if (app && new RegExp(`(?<![\\p{L}\\d])${app}(?![\\p{L}\\d])`, 'iu').test(label)) return 'app';
  if (label) {
    if (namesEmail) return 'email';
    if (/linkedin/i.test(label)) return 'linkedin';
    if (/(?<![\p{L}\d])app(?![\p{L}\d])/iu.test(label)) return 'app';
    return /chat/i.test(label) ? null : 'app';
  }
  if (sent.source === 'mailbox') return 'email';
  if (['linkedin', 'app'].includes(sent.source)) return sent.source;
  return step === 'linkedin' || step === 'app' ? step : 'email';
}

// The message before this one that wasn't skipped; 0 when every earlier step was skipped (this one then goes as a
// first message would: a step that did not go never blocks the person's later steps).
export function touchBefore(st, touch) {
  let t = touch - 1;
  while (t >= 1 && st?.touches?.[t]?.skipped) t--;
  return Math.max(t, 0);
}

// A by-hand LinkedIn step never pauses the sequence (owner, 2026-11-22, spec 0.1.7 section 12). stepAt(t): this person's
// route step at t ('email', 'app', 'linkedin') as the route is now, or null (no route: one channel carries the sequence).
const wentAt = (st, t) => !!(st?.sent?.[t] || st?.touches?.[t]?.sent);
// A LinkedIn step: the route as it is now says LinkedIn, and so does its approval, if it has one (an approval says
// where === 'LinkedIn'; one with no where, an email's, is no LinkedIn step). An approval for LinkedIn on a step the
// user has since moved to another channel is no LinkedIn step either.
export const linkedInAt = (st, t, stepAt = () => null) => {
  if (stepAt(t) !== 'linkedin') return false;
  const appr = st?.touches?.[t]?.approved;
  return !appr || appr.where === 'LinkedIn';
};

// The message a later step waits for, and counts its spacing from: the one before it that wasn't skipped, passing over a
// LinkedIn step that hasn't gone (the user sends those by hand; the later step goes on its own day). 0: nothing before it
// is left (every step before it was skipped, or a route that starts on LinkedIn and that message hasn't gone): it is the
// person's first message, rule A1 (owner, 0.1.7 section 12b). The message a follow-up is written against stays
// touchBefore's. A LinkedIn step waits for the LinkedIn step before it (touchBefore): passed over only for a step on
// another channel, so no two LinkedIn messages are due to one person at once, in or out of order.
export function wentBefore(st, touch, stepAt = () => null) {
  const plain = touchBefore(st, touch);
  // Nothing before it to pass over (the step before it went, or isn't LinkedIn): the route isn't read.
  if (plain < 1 || wentAt(st, plain) || !linkedInAt(st, plain, stepAt) || linkedInAt(st, touch, stepAt)) return plain;
  let t = plain;
  while (t >= 1 && (st?.touches?.[t]?.skipped || (!wentAt(st, t) && linkedInAt(st, t, stepAt)))) t--;
  return Math.max(t, 0);
}

// A LinkedIn step that hadn't gone when a later step went: dropped ("skipped: the next message went first"). It is never
// offered after, and its open CRM task is offered to close.
export const linkedInPassed = (st, touch, stepAt = () => null) =>
  touch >= 1 && !wentAt(st, touch) && linkedInAt(st, touch, stepAt) && Object.keys(st?.sent || {}).some((k) => Number(k) > touch);
export const PASSED_WHY = 'skipped: the next message went first';
