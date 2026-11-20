// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The daily ChatGPT task that sends the labelled drafts (drafts.mjs), filled in from codex/daily-task.md: one fixed
// daily time, chosen at setup (default 9:00 in the user's time zone), never rescheduled. The stop checks are a list:
// each can only hold a draft, never send one. Later checks (CRM connectors) are added here.
import { join, dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FLOORBOSS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TASK_NAME = 'floorboss daily sending';
export const DEFAULT_TIME = '9:00';

export const STOP_CHECKS = Object.freeze([
  { id: 'replied', text: 'Reply: search Gmail for from:<that address> in:anywhere -in:sent -in:drafts after:<after>. Any result holds, an auto-reply too: label floorboss/held-replied.' },
  { id: 'bounced', text: 'Bounce: search Gmail for from:(mailer-daemon OR postmaster) "<that address>" in:anywhere after:<after>. Any result holds: label floorboss/held-bounced.' }
]);

// The searches' start: the day before the first auto-send yes of a drafts event (Gmail's after: is YYYY/MM/DD).
export function afterDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('the first-send date is YYYY-MM-DD');
  return String(day).replace(/-/g, '/');
}

// "9:00", "09:30", "17:05": a time of day, as the user types it. Returns "H:MM", or throws.
export function dayTime(s = DEFAULT_TIME) {
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(String(s));
  if (!m) throw new Error('--time is a time of day, like 9:00 or 13:30');
  return `${Number(m[1])}:${m[2]}`;
}
export function zoneOk(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(zone) }).format(0);
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(String(zone));
  } catch {
    return false;
  }
}

// The setup text the user gives ChatGPT, from the template's fence.
export function dailyTaskText({ time = DEFAULT_TIME, zone, after } = {}) {
  if (!zoneOk(zone)) throw new Error('--zone is an IANA time zone, like America/New_York');
  const md = readFileSync(join(FLOORBOSS, 'codex', 'daily-task.md'), 'utf8');
  const a = md.indexOf('```\n');
  const b = md.lastIndexOf('\n```');
  if (a < 0 || b <= a) throw new Error('codex/daily-task.md has no fenced task text');
  const body = md.slice(a + 4, b);
  const checks = STOP_CHECKS.map((c, i) => `${i + 1}. ${c.text.replaceAll('<after>', afterDate(after))}`).join('\n');
  return body.replaceAll('<TIME>', dayTime(time)).replaceAll('<ZONE>', zone).replace('<STOP_CHECKS>', checks);
}

// A chatgpt.com link that opens a new chat with the text typed in. Long links may be cut by the browser or the site:
// over about 6000 characters it warns, and the user copies the text from the file instead.
export const LINK_WARN_AT = 6000;
export function chatgptLink(text) {
  const url = `https://chatgpt.com/?q=${encodeURIComponent(String(text))}`;
  return { url, length: url.length, ...(url.length > LINK_WARN_AT ? { warn: `The link is ${url.length} characters long, over about ${LINK_WARN_AT}: it may not fill the chat in. Copy the text from the file instead.` } : {}) };
}
