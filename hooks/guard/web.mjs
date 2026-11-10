// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// WebFetch and WebSearch during a run: no long or multi-line address or query, and WebFetch only to sites
// floorboss has a reason to open (event sites the user named, hosts a search returned, companies on the list).
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { readUrl, pageKey, hostAllowed, carriesData } from '../../lib/security.mjs';
import { readLedger } from '../../lib/ledger.mjs';
import { writeText } from '../../lib/jsonio.mjs';
import { readJsonStrict } from './shared.mjs';
import { lockNote } from './run.mjs';

// Claude Code's own web tools (WebFetch, WebSearch) during a floorboss run: a link or a search query can carry
// what Claude read out of the session (an attendee list, a CRM export), so while a run is under way neither
// takes a long or multi-line address or query, and WebFetch opens only the sites floorboss has a reason to
// (hostAllowed: LinkedIn profiles, the event apps it knows, CRM web apps and the event sites the user named).
// The attendee-researcher agent reads the open web for its briefs: it has no file tools, so it holds only the
// brief it was given, and it keeps any host within the same length limit. Outside a run both are let through.
export const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
export const WEB_CAP = 300;
// Only floorboss's own researcher, by its full name (Claude Code names a plugin's agent "<plugin>:<agent>"):
// another plugin's agent of the same name may have file tools, and one named attendee-researcher in a project's
// own .claude/agents could otherwise claim its web access.
export const isResearcher = (input) => String(input?.agent_type ?? '') === 'floorboss:attendee-researcher';
const hostUnder = (host, root) => {
  const h = String(host || '').toLowerCase(),
    r = String(root || '')
      .toLowerCase()
      .replace(/^www\./, '');
  return !!r && (h === r || h.endsWith(`.${r}`) || h === `www.${r}`);
};
export function webRefusal(tool, input, run = { active: false }, hosts = [], { researcher = false, seen = [], companies = [] } = {}) {
  if (!run.active) return null;
  const why = 'during a floorboss run, Claude may fetch only event and connector sites; a link can carry data out.';
  const text = String((tool === 'WebSearch' ? input?.query : input?.url) ?? '');
  const what = tool === 'WebSearch' ? 'search query' : 'address';
  const carry = carriesData(text, what);
  if (carry) return `${carry}, and ${why}${lockNote(run)}`;
  if (tool === 'WebSearch') return null;
  const u = readUrl(text);
  if (!u || !['http:', 'https:'].includes(u.scheme) || !u.host || u.odd)
    return `WebFetch was asked to open ${JSON.stringify(text.slice(0, 80))}, which isn't a plain web address floorboss can check, and ${why}${lockNote(run)}`;
  if (hostAllowed(u, hosts, { crm: false })) return null;
  // The researcher reads the open web, but only pages its own searches turned up and the companies' own sites
  // (their email domains): a page it reads can't send it to a host of the page's choosing.
  // A host a search returned opens as returned (or with www.); a company's own site opens with its subdomains. A
  // search can return a bare hosting suffix (trycloudflare.com), and every subdomain under it isn't a page it found.
  const exact = (h) => {
    const x = String(h || '')
      .toLowerCase()
      .replace(/^www\./, '');
    const y = String(u.host || '')
      .toLowerCase()
      .replace(/^www\./, '');
    return !!x && x === y;
  };
  if (researcher && (seen.some(exact) || companies.some((h) => hostUnder(u.host, h)))) return null;
  if (researcher)
    return `WebFetch was asked to open ${u.host}, which none of this run's searches turned up and which isn't the site of a company on the list. The researcher opens only pages its searches found and the companies' own sites, so a page can't send it, or what it holds, somewhere else.`;
  return `WebFetch was asked to open ${u.host}${u.path.slice(0, 40)}, and ${why} It opens LinkedIn profiles, the event apps floorboss knows and the event sites you named.${lockNote(run, hosts)}`;
}

// The hosts this run's web searches turned up (recorded after each search, by the PostToolUse hook), for 12 hours.
const SEEN_MS = 12 * 3600 * 1000;
const seenPath = () => join(home(), 'web-seen.json');
export function seenHosts(nowMs = Date.now()) {
  const v = readJsonStrict(seenPath(), {});
  return Object.entries(v?.hosts || {})
    .filter(([h, at]) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) && Number(at) > nowMs - SEEN_MS && Number(at) <= nowMs + 60000)
    .map(([h]) => h);
}
// A host the researcher may then open is one the search engine returned, never one the search was asked about: a
// host named in the query (the model chose it, a page may have told it to) is left out, so is a bare public suffix
// ("co.uk" would open every site under it). Result fields named url/link are read first; plain text only without them.
const SUFFIX_ONLY =
  /^((co|com|org|net|ac|gov|edu|ne|or|go|gob|nic|mil|sch|ltd|plc)\.[a-z]{2}|github\.io|gitlab\.io|vercel\.app|netlify\.app|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|herokuapp\.com|appspot\.com|blogspot\.com|wordpress\.com|azurewebsites\.net|cloudfront\.net|amazonaws\.com|s3\.amazonaws\.com|onrender\.com|fly\.dev|substack\.com|notion\.site|trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app|glitch\.me|r2\.dev|deno\.dev|repl\.co|replit\.app)$/;
const hostsIn = (text) =>
  [...String(text).matchAll(/https?:\\?\/\\?\/([a-z0-9.-]+\.[a-z]{2,})(?=[:/?#"\\\s]|$)/gi)].map((m) => m[1].toLowerCase().replace(/^www\./, ''));
export function recordSearchHosts(response, nowMs = Date.now(), query = '') {
  const asked = new Set([
    ...hostsIn(query),
    ...String(query)
      .toLowerCase()
      .split(/[^a-z0-9.-]+/)
      .filter((w) => /\.[a-z]{2,}$/.test(w))
      .map((w) => w.replace(/^www\./, ''))
  ]);
  const fields = [];
  const walk = (v, k = '') => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, k));
    else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walk(x, kk);
    else if (typeof v === 'string' && /^(url|link|href|uri|source_url)$/i.test(k)) fields.push(v);
  };
  walk(response);
  const raw = fields.length ? fields.flatMap(hostsIn) : hostsIn(JSON.stringify(response ?? ''));
  // The query squashed to its letters and digits ("evil.example.org.", "evil 。example。org" and "evil . example .
  // org" all become "evilexampleorg"): a host whose own squashed name is in it was named in the search. This leaves
  // out a little more than it must, which is the safe side.
  const squash = (x) =>
    String(x)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const sq = squash(query);
  const named = (h) => {
    const bare = squash(h.replace(/^www\./, ''));
    return bare.length >= 4 && sq.includes(bare);
  };
  const found = new Set(
    raw.filter(
      (h) => h.split('.').length >= 2 && !SUFFIX_ONLY.test(h) && !named(h) && ![...asked].some((q) => q === h || q.endsWith(`.${h}`) || h.endsWith(`.${q}`))
    )
  );
  if (!found.size) return 0;
  const v = readJsonStrict(seenPath(), {});
  const hosts = Object.fromEntries(Object.entries(v?.hosts || {}).filter(([, at]) => Number(at) > nowMs - SEEN_MS));
  for (const h of found) hosts[h] = nowMs;
  const kept = Object.entries(hosts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3000);
  writeText(seenPath(), JSON.stringify({ hosts: Object.fromEntries(kept) }));
  return found.size;
}
// The companies' own sites: the email domains of people on the event lists, leaving out mail providers.
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|mac|aol|proton|protonmail|gmx|web|mail|yandex|zoho)\./;
export function companyHosts() {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  const out = new Set();
  for (const slug of readdirSync(dir)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) continue;
    const store = readJsonStrict(join(dir, slug, 'derived', 'contacts.json'), []);
    for (const c of Array.isArray(store) ? store : store?.contacts || []) {
      const d = String(c?.email || '')
        .toLowerCase()
        .split('@')[1];
      if (d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !FREEMAIL.test(d)) out.add(d);
    }
  }
  return [...out];
}

// The event sites a run may open in the browser, beyond the fixed ones: only a site_allowed entry in an
// event's log, which one command writes (the flow's list_source answer) from a link in the user's own words.
// Links in event.json, onboarding.json or anything else Claude could have written from a page are never read.
// Returns those entries' hosts, and the list pages they name (scheme, host, port and path), which open without asking.
export function knownEventSites() {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return { hosts: [], pages: [] };
  const out = new Set(),
    pages = new Set();
  for (const slug of readdirSync(dir)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || !existsSync(join(dir, slug, 'ledger.jsonl'))) continue;
    for (const e of readLedger(join(dir, slug, 'ledger.jsonl')).entries) {
      const host = String(e.host || '')
        .toLowerCase()
        .replace(/^www\./, '');
      if (
        e.type !== 'site_allowed' ||
        e.who !== 'user' ||
        !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ||
        !String(e.said || '')
          .toLowerCase()
          .includes(host)
      )
        continue;
      // A link aggregator or a social site is never an event's own site.
      if (/(^|\.)(linkedin|google|bit\.ly|facebook|twitter|x\.com|t\.co|instagram)\b/.test(host)) continue;
      out.add(host);
      const u = typeof e.url === 'string' ? readUrl(e.url, { ports: true }) : null;
      if (u && !u.odd && u.host.replace(/^www\./, '') === host) pages.add(pageKey(u));
    }
  }
  return { hosts: [...out].sort(), pages: [...pages] };
}
