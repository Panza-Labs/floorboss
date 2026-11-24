// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The answer to "Besides email, where do you want to reach people?", in the user's words, and what is said back.
// reach: the channels besides email, a list of 'app' and 'linkedin' ([] for email only).
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NEG = String.raw`(?:\bnot|\bno|\bwithout|\bexcept(?:\s+for)?|\bbut\s+not|\bnever|\bskip|\bminus|\bneither|\bnor|\b(?:do\s+not|don'?t|dont)\s+(?:want|need|use|like)(?:\s+to\s+use)?)\s+(?:on\s+|via\s+|in\s+|by\s+)?(?:the\s+)?(?:event\s+)?`;
const ONLY = String.raw`\b(?:just|only)\s+(?:on\s+|via\s+|in\s+|by\s+)?(?:the\s+)?(?:event\s+)?`;

// { reach, readBack } or null when the words say nothing that can be read.
export function readReach(text, appName = '') {
  const t = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const nums = /^[\d\s,.&+and]+$/.test(t) ? t.match(/\d+/g) || [] : [];
  if (nums.length) {
    if (nums.some((n) => !['1', '2', '3', '4'].includes(n)) || (nums.includes('4') && nums.length > 1)) return null;
    const set = new Set();
    for (const n of nums) for (const x of { 1: ['app'], 2: ['linkedin'], 3: ['app', 'linkedin'], 4: [] }[n]) set.add(x);
    return { reach: ['app', 'linkedin'].filter((x) => set.has(x)), readBack: false };
  }
  const appW = `(?:app|grip|brella|swapcard|whova${appName ? `|${esc(appName.toLowerCase())}` : ''})`;
  const liW = String.raw`(?:linked\s*-?\s*in|li\b)`;
  const mailW = String.raw`(?:e-?mails?)`;
  const has = (w) => new RegExp(`(?<![a-z])${w}`).test(t);
  // "not X", "no X", "neither X nor Y", "I don't want X", and "X no" ("app yes linkedin no").
  const neg = (w) => new RegExp(`${NEG}${w}`).test(t) || new RegExp(`(?<![a-z])${w}\\s*[:=-]?\\s*(?:no|not|nope|off)\\b`).test(t);
  const only = (w) => new RegExp(`${ONLY}${w}|(?<![a-z])${w}\\s+only\\b`).test(t);
  const negated = /\b(?:not|no|without|except|but not|never|skip|minus|neither|nor|none|nope|don'?t|dont)\b/.test(t);
  if (only(mailW)) return { reach: [], readBack: negated };
  if (only(appW) || only(liW)) return { reach: [only(appW) && 'app', only(liW) && 'linkedin'].filter(Boolean), readBack: negated };
  const all = /^(?:both|all|everything|all of them|every channel)\b/.test(t) || /\b(?:everything|every channel|all of them)\b/.test(t);
  const appOn = (all || has(appW)) && !neg(appW);
  const liOn = (all || has(liW)) && !neg(liW);
  if (!has(appW) && !has(liW) && !all) {
    if (has(mailW) || /^(?:no|none|nope|neither|nowhere|nothing)\b/.test(t)) return { reach: [], readBack: false };
    return null;
  }
  return { reach: [appOn && 'app', liOn && 'linkedin'].filter(Boolean), readBack: negated };
}

// The choice in words: "email and the event app, no LinkedIn".
export function reachSaid(reach) {
  const on = ['email', ...(reach.includes('app') ? ['the event app'] : []), ...(reach.includes('linkedin') ? ['LinkedIn'] : [])];
  const off = [...(!reach.includes('app') ? ['the event app'] : []), ...(!reach.includes('linkedin') ? ['LinkedIn'] : [])];
  return `${on.length === 1 ? 'email only' : on.join(' and ')}${off.length && on.length > 1 ? `, and not ${off.join(' or ')}` : ''}`;
}

// What happens next, in one line.
export function reachNext(reach, event) {
  const app = event?.app_name ? `the event app (${event.app_name})` : 'the event app';
  if (!reach.length) return "Every message is an email: someone with no email address isn't written to.";
  if (reach.length === 2) return `Each person gets emails, one note in ${app} and one LinkedIn message, which you send yourself.`;
  if (reach[0] === 'app') return `Each person gets emails and one short note in ${app}.`;
  return 'Each person gets emails and one LinkedIn message, which you send yourself.';
}

// The count was too small to fit every chosen channel between the first and last email.
export function roomLine(reach, event, n, asked = null) {
  const names = reach.map((x) => (x === 'linkedin' ? 'LinkedIn' : event?.app_name || 'the event app'));
  return `${asked ? `${asked} messages leave` : 'That count leaves'} no room for ${names.length === 2 ? `both ${names.join(' and ')}` : names[0]} between the first and last email, so each person gets ${n}.`;
}
