// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The browser: where it may go during a run, and the two windows the user can open (sending notes in an event
// app or LinkedIn, logging to the CRM): which pages, which actions, which keys, and what may be typed.
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { siteKind, isBrowserReadTool, isNavigateTool, bareBrowserTool, readUrl, pageKey, looksLikeUrl, hostAllowed, crmPageAllowed, carriesData, tenantCrmHost, URL_CAP } from '../../lib/security.mjs';
import { verifySend, eventRecord, approvalHash } from '../../lib/sendcheck.mjs';
import { loadEvent } from '../../lib/event.mjs';
import { leaves, readJsonStrict, recent, squash } from './shared.mjs';
import { notRealEvent } from './sends.mjs';

// A browser call that opens LinkedIn messaging, or an app's inbox or messages page, without the user's yes.
// Addresses are read as the browser reads them (lib/security.mjs readUrl): percent-encoded, doubled-slash or
// upper-case spellings of the same page are the same page.
export function inboxRefusal(args, config) {
  const urls = leaves(args)
    .map(([, v]) => readUrl(v))
    .filter((u) => u && u.host);
  const ok = config?.inbox_read || {};
  for (const u of urls) {
    const li = /(^|\.)linkedin\.(com|test)$/.test(u.host);
    if (li && /^\/(messaging|inbox)(\/|$)/.test(u.path) && ok.linkedin !== true)
      return "floorboss doesn't open your LinkedIn messages: you didn't allow it (inbox_read.linkedin). Ask the user whether they replied instead.";
    if (
      !li &&
      /\/(inbox|messages|messaging|chat)(\/|$)/.test(u.path) &&
      !/(^|\.)(app\.hubspot\.com|mail\.google\.com)$|(^|\.)outlook\./.test(u.host) &&
      ok.app !== true
    )
      return "floorboss doesn't open the event app's inbox: you didn't allow it (inbox_read.app). Ask the user whether they replied instead.";
  }
  return null;
}

// Where a browser call would go during a run or a window: only to pages floorboss has a reason to open.
// The event's own site (a site_allowed host) is a site floorboss knows nothing else about: only the list page
// the user gave opens without a word; any other page there is put to the user first (pushed to asks, with the
// whole address). A port is part of the page (lib/security.mjs pageKey): "expo.example:8443" is another site
// unless the saved list page has that port, and any other address with a port of its own is never opened.
export function navRefusal(tool, args, hosts, pages = [], asks = []) {
  const ports = pages
    .map((p) => readUrl(p, { ports: true }))
    .filter((u) => u?.port)
    .map((u) => `${u.host}:${u.port}`);
  const vals = leaves(args)
    .filter(([p, v]) => (isNavigateTool(tool) || /(^|\.)(url|href|link|uri)$/i.test(p)) && String(v ?? '').trim())
    .map(([, v]) => [String(v), readUrl(v, { ports })]);
  for (const [raw, u] of vals) {
    if (!u) {
      if (/^(back|forward|reload)$/i.test(raw.trim()) || !isNavigateTool(tool)) continue;
      return `${tool}: "${raw.slice(0, 80)}" isn't a web address floorboss can check, and a floorboss run is under way.`;
    }
    if (!['http:', 'https:'].includes(u.scheme))
      return `${tool} was asked to open a ${u.scheme} address, and a floorboss run is under way: the browser opens only web pages floorboss has a reason to (LinkedIn profiles, the event's app or site, your CRM).`;
    const carry = carriesData(raw);
    if (carry) return `${tool}: ${carry}, and a floorboss run is under way: a link can carry what this session read out of it.`;
    if (!hostAllowed(u, hosts))
      return `${tool} was asked to open ${u.host}${u.port ? `:${u.port}` : ''}${u.path.slice(0, 40)}, and a floorboss run is under way: the browser opens only LinkedIn profiles, the event apps floorboss knows, your CRM's web app and the event's own site then.`;
    // A customer's own subdomain of a CRM (anyone can have one): the user says it's theirs.
    if (tenantCrmHost(u.host)) {
      asks.push(
        `floorboss: the browser is about to open ${u.host}, a CRM site where every customer has their own address:\n\n${u.href.slice(0, 300)}\n\nAllow only if this is your own CRM.`
      );
      continue;
    }
    // The list page as saved: same scheme, host, port and path, and no query or fragment of its own.
    if (hostAllowed(u, []) || (pages.includes(pageKey(u)) && !/[?#]/.test(u.href))) continue;
    asks.push(
      `floorboss: the browser is about to open a page on the event's own site, which floorboss can't vouch for:\n\n${u.href.slice(0, 600)}\n\nThe list page you gave opens without asking; this is another page. Allow only if it is the event's attendee or speaker list (or another page of it) and you expected it.`
    );
  }
  return null;
}

// Inside the CRM log window the browser opens only the CRM's contact, record, search and task pages.
export function logNavRefusal(tool, args) {
  const vals = leaves(args)
    .filter(([p, v]) => (isNavigateTool(tool) || /(^|\.)(url|href|link|uri)$/i.test(p)) && String(v ?? '').trim())
    .map(([, v]) => [String(v), readUrl(v)]);
  for (const [raw, u] of vals) {
    if (!u && /^(back|forward|reload)$/i.test(raw.trim())) continue;
    if (!u && !isNavigateTool(tool)) continue;
    if (/[\r\n\u2028\u2029]/.test(raw) || raw.length > URL_CAP)
      return `${tool} was asked to open an address that is long or spans lines, and the CRM log window is open: the browser opens only your CRM's own pages then.`;
    if (!crmPageAllowed(u))
      return `${tool} was asked to open ${u?.host ? `${u.host}${u.path.slice(0, 40)}` : JSON.stringify(raw.slice(0, 80))}, and the CRM log window is open: the browser opens only your CRM's contact, record, search and task pages then.`;
  }
  return null;
}

// Inside a send or CRM-log window the browser may read, open listed pages, click and type; nothing else.
const WINDOW_TOOLS = new Set([
  'click',
  'double_click',
  'hover',
  'type',
  'fill',
  'fill_form',
  'form_input',
  'press_key',
  'key',
  'select_option',
  'keyboard_type',
  'keyboard_press',
  'insert_text'
]);
const COMPUTER_ACTIONS = new Set([
  'left_click',
  'click',
  'double_click',
  'type',
  'key',
  'screenshot',
  'scroll',
  'scroll_to',
  'wait',
  'hover',
  'zoom',
  'mouse_move'
]);
export function windowRefusal(tool, args) {
  const t = bareBrowserTool(tool);
  if (isBrowserReadTool(tool) || WINDOW_TOOLS.has(t)) return null;
  if (t === 'computer' && COMPUTER_ACTIONS.has(String(args?.action || ''))) return null;
  return `${tool}${args?.action ? ` (${args.action})` : ''} isn't something the browser window allows: it opens the listed people's pages, clicks, and types the listed messages, nothing else.`;
}

// The send window opens only the platform of a note listed in it: LinkedIn only for a LinkedIn note with LinkedIn
// sending and its warning accepted, a known event app only for an app note. The typing check can't see the page, so
// this is where a note is kept on its platform, inbox pages included: the window already carries the reply check
// that let its notes in, and reply reads happen outside it.
export function windowSiteRefusal(tool, args, w) {
  const items = browserItems(w.event).filter((x) => (w.ids || []).includes(`${x.id}:${x.touch}`));
  let sending = {};
  try {
    sending = loadEvent(w.event).settings.sending || {};
  } catch {
    /* no event settings: only what's listed below can pass, and LinkedIn can't */
  }
  const linkedinOk = items.some((x) => x.where === 'LinkedIn') && (sending.channels || []).includes('linkedin') && !!sending.linkedin_ack;
  const appOk = items.some((x) => x.where !== 'LinkedIn');
  const urls = leaves(args).filter(([p, v]) => (isNavigateTool(tool) || /(^|\.)(url|href|link|uri)$/i.test(p)) && String(v ?? '').trim());
  for (const [, v] of urls) {
    const u = readUrl(v);
    const site = siteKind(u);
    if (!site || (site === 'linkedin' ? linkedinOk : appOk)) continue;
    return `${tool} was asked to open ${u.host}${u.path.slice(0, 40)}, and the send window is open for notes in ${site === 'linkedin' ? 'the event app' : 'LinkedIn'} only: it opens only the places its listed notes go.`;
  }
  return null;
}

// The approved app and LinkedIn notes listed for an event. Each is checked against the record when typed (noteWhy).
export function browserItems(slug) {
  const dir = join(home(), 'events', slug);
  if (notRealEvent(slug)) return [];
  const v = readJsonStrict(join(dir, 'derived', 'browser-send-list.json'), []);
  if (!Array.isArray(v) || !v.length) return [];
  // The list only names the person for the prompt; the user sees the text and the page and decides.
  return v.filter((x) => x && typeof x === 'object' && /^c\d+$/.test(String(x.id)) && x.via === 'browser');
}

// Why a listed note can't be typed in this send window now, or null: not a note the window was opened for, or what the
// record says of it now (sent, let through, stopped, booked or replied, and the rest of verifySend). The reply-check
// freshness is left out: it passed when the window opened, it lasts 90 seconds and a window 20 minutes, so it would
// refuse every legitimate note after the first.
export function noteWhy(w, nowMs) {
  const evDir = join(home(), 'events', w.event);
  const rec = eventRecord(evDir);
  const settings = loadEvent(w.event).settings;
  return (x) => {
    if (!(w.ids || []).includes(`${x.id}:${x.touch}`)) return { why: "this browser window wasn't opened for that note" };
    const r = verifySend(x, { evDir, settings, ...rec, nowMs, replyCheck: false });
    return r.ok ? { hash: r.hash } : { why: r.why };
  };
}

// The browser send window, if one is open: browser-send.json must match a window opened in that event's log
// (by its own command, with the user's words), at most 20 minutes ago.
export const windowKey = (kind, w) => `${kind}:${w.event}:${w.until}`;
// The call a prompt was about: a note written by the pre hook counts only for the post hook of that same call
// (Claude Code gives both the call's tool_use_id; without one, the session and tool name stand in).
export const callId = (input) => ({ call: String(input?.tool_use_id || ''), session: String(input?.session_id || ''), tool: String(input?.tool_name || '') });
export const sameCall = (note, input) =>
  note.call ? note.call === String(input?.tool_use_id || '') : note.session === String(input?.session_id || '') && note.tool === String(input?.tool_name || '');
export function openWindow(nowMs) {
  const bs = readJsonStrict(join(home(), 'browser-send.json'), null);
  if (!bs || bs.closed || !bs.event || !/^[a-z0-9-]+$/.test(bs.event) || notRealEvent(bs.event)) return null;
  const { entries } = eventRecord(join(home(), 'events', bs.event));
  const opened = entries.filter((e) => e.type === 'browser_send_opened' && e.until === bs.until && e.said).pop();
  if (!opened) return null;
  // Opened in the last 20 minutes, never dated ahead of the clock (a window "opened" tomorrow stays shut), and
  // closing within the next 21 minutes.
  return recent(opened.at, nowMs, 20 * 60000) && Date.parse(bs.until) > nowMs && Date.parse(bs.until) - nowMs <= 21 * 60000 ? bs : null;
}

// The CRM log window: the user's yes to log listed LinkedIn and app messages in their CRM's web app. Matches a
// crm_log_opened entry in that event's log (with the user's words), at most 20 minutes ago.
export function openLogWindow(nowMs) {
  const w = readJsonStrict(join(home(), 'crm-log-window.json'), null);
  if (!w || w.closed || !w.event || !/^[a-z0-9-]+$/.test(w.event) || notRealEvent(w.event)) return null;
  const { entries } = eventRecord(join(home(), 'events', w.event));
  const opened = entries.filter((e) => e.type === 'crm_log_opened' && e.until === w.until && e.said).pop();
  if (!opened) return null;
  return recent(opened.at, nowMs, 20 * 60000) && Date.parse(w.until) > nowMs && Date.parse(w.until) - nowMs <= 21 * 60000 ? w : null;
}
export function logItems(slug) {
  if (notRealEvent(slug)) return [];
  const evDir = join(home(), 'events', slug);
  const v = readJsonStrict(join(evDir, 'crm-log-list.json'), []);
  // A sent message (c001:1), or a reply read in LinkedIn or the app (c001:r:<its id>), the user asked to log.
  const items = Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && /^c\d+:(\d+|r:.+)$/.test(String(x.key)) && /^c\d+$/.test(String(x.id))) : [];
  if (!items.length) return [];
  // Is the body the text the user approved (the content-addressed draft their approval points at)? The list
  // is a file a session could write; the prompt says which bodies floorboss can vouch for and which it can't.
  const { state } = eventRecord(evDir);
  return items.map((x) => ({ ...x, _approved: !x.received && approvedBody(evDir, state, x.id, Number(x.touch)) === squash(x.body) }));
}
// The approved draft's body for a person's touch (squashed), or null.
function approvedBody(evDir, state, id, touch) {
  const appr = state[id]?.touches?.[touch]?.approved;
  if (!appr?.hash || !/^[0-9a-f]{24}$/.test(String(appr.hash))) return null;
  const d = readJsonStrict(join(evDir, 'drafts', `${appr.hash}.json`), null);
  if (!d || approvalHash(d, appr.to) !== appr.hash) return null;
  return squash(d.body);
}

// What may be typed inside the CRM log window: a listed item's own values, nothing else. Its body (the
// message logged), its name (whole, or first name and the rest, for a new contact's two fields), company,
// email, profile link, title, sent date (as written, or as a date field takes it) and the values in its fill,
// plus the activity type and a ticked or cleared box. Returns { why } or { bodies: [[item, text]] }.
const ACTIVITY_TYPES = new Set(['linkedin message', 'linkedin', 'note', 'notes', 'message', 'event app message', 'other']);
function dateForms(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').trim());
  if (!m) return [];
  const [, y, mo, da] = m;
  return [
    `${y}-${mo}-${da}`,
    `${mo}/${da}/${y}`,
    `${da}/${mo}/${y}`,
    `${da}.${mo}.${y}`,
    `${Number(mo)}/${Number(da)}/${y}`,
    `${Number(da)}/${Number(mo)}/${y}`
  ];
}
export function logTyping(texts, items, hosts = []) {
  const bodies = [];
  for (const t of texts) {
    const s = squash(t);
    if (!s) continue;
    const hit = items.find((it) => it.body && s === squash(it.body));
    if (hit) {
      bodies.push([hit, t]);
      continue;
    }
    if (ACTIVITY_TYPES.has(s) || s === 'true' || s === 'false') continue;
    const own = items.some((it) => {
      const name = String(it.name || '')
        .trim()
        .split(/\s+/);
      const vals = [
        it.name,
        name[0],
        name.slice(1).join(' '),
        name[name.length - 1],
        it.company,
        it.email,
        it.profile_url,
        it.title,
        it.sent_on,
        ...dateForms(it.sent_on),
        it.channel,
        ...Object.values(it.fill && typeof it.fill === 'object' ? it.fill : {})
      ];
      return vals.some((x) => x != null && String(x).trim() && squash(x) === s);
    });
    // A listed link is typed only when the browser could open it anyway (a profile on LinkedIn or the event app).
    const url = looksLikeUrl(t) || (/[a-z]/i.test(t) && !!readUrl(t)?.host && !/\s/.test(t.trim()));
    if (own && (!url || hostAllowed(t.trim(), hosts))) continue;
    return {
      why: `the CRM log window types only the listed messages and their people's own details (name, company, email, profile link, title, date), and ${JSON.stringify(t.slice(0, 80))} isn't one of them.`
    };
  }
  return { bodies };
}
// Keys pressed in a browser window: plain keys, and Enter with a modifier (a send shortcut). No paste or other
// shortcut: a paste would put the clipboard in the page, whatever it holds.
export const KEY_OK =
  /^((cmd|ctrl|control|meta|command)\+)?(enter|return)$|^(enter|return|tab|escape|esc|backspace|delete|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|space)$/i;
