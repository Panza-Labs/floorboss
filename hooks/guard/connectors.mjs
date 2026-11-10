// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Connected tools (MCP servers): what a tool does, judged by its name; whether its arguments fit the saved
// recipe; which servers floorboss was given; and what a tool with no recipe may carry during a run.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { home, sensitiveKind } from '../../lib/paths.mjs';
import { isBrowserCall, isKnownBrowser, looksLikeUrl, URL_CAP, sameServer } from '../../lib/security.mjs';
import { screenTool, toolWords, TASKS } from '../../skills/connectors/scripts/tasks.mjs';
import { readJsonStrict, leaves } from './shared.mjs';

const PLACE = /\{[a-z_]+\}/g;
// A template value with placeholders inside it ("WHERE Email = '{email}'"): the real value must fit it.
// Inside quotes, what fills a placeholder can't hold quotes, a backslash, a semicolon or a line break: a name
// like "x' OR '1'='1" can't step out of the query's string. Outside quotes ("id eq {crm_id}", "{name}
// {company}"), it takes letters, digits, spaces and @ . + _ - : only, and in a template that is a query
// (it has =, <, >, eq, where, and, or…) no query word either: "1 or 1 eq 1" is refused.
const QUERY_WORDS = /\b(or|and|not|eq|ne|gt|lt|ge|le|like|in|is|null|select|union|where|from|delete|update|insert|drop|exec)\b/i;
export function templateFits(t, v) {
  const parts = String(t).split(PLACE);
  let quote = 0;
  const groups = [];
  let re = '^';
  parts.forEach((s, i) => {
    re += s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    quote = (quote + (s.match(/['"]/g) || []).length) % 2;
    if (i < parts.length - 1) {
      groups.push(quote === 1);
      re += quote ? '([^\\n\\r\\u0000\'"`\\\\;]{1,300}?)' : '([\\p{L}\\p{N} @.+_:-]{1,300}?)';
    }
  });
  const m = new RegExp(`${re}$`, 'u').exec(v);
  if (!m) return false;
  const query = /[=<>]|\b(eq|ne|where|select|and|or|not|like)\b/i.test(parts.join(' '));
  return groups.every((quoted, k) => quoted || !query || !QUERY_WORDS.test(m[k + 1]));
}

// A tool name's words without the vendor and product words, which say nothing about what it does.
const VENDOR_WORDS = new Set([
  'mcp',
  'notion',
  'gmail',
  'slack',
  'google',
  'claude',
  'ai',
  'hubspot',
  'salesforce',
  'outlook',
  'microsoft',
  'calendar',
  'gcal'
]);
const nameWords = (tool) => toolWords(tool).filter((x) => !VENDOR_WORDS.has(x));

// A tool that plainly reads, judged by name: a read verb first (get, list, search…) or a known read-only
// name (guide, help), nothing that sends, deletes or writes anywhere in it, and nothing general-purpose
// or that calls out (http, webhook, url, upload, zap, execute).
const READ_NAMES = new Set(['guide', 'help', 'docs', 'whoami', 'status', 'ping', 'tabs_context', 'tabs_list', 'tabs_context_mcp']);
const OUTBOUND_WORDS = new Set([
  'replace',
  'sql',
  'eval',
  'script',
  'shell',
  'command',
  'cmd',
  'javascript',
  'code',
  'scrape',
  'crawl',
  'browse',
  'curl',
  'proxy',
  'web',
  'url',
  'urls',
  'http',
  'https',
  'webhook',
  'webhooks',
  'upload',
  'zap',
  'zapier',
  'execute',
  'exec',
  'run',
  'call',
  'invoke',
  'request',
  'action',
  'actions',
  'workflow',
  'trigger',
  'enroll',
  'sequence',
  'sequences',
  'schedule',
  'scheduled',
  'say',
  'tweet',
  'relay',
  'out',
  'connect',
  'export',
  'import',
  'sync',
  'write',
  'create',
  'add',
  'update',
  'set',
  'put',
  'post',
  'patch',
  'insert',
  'save',
  'mark',
  'move',
  'copy',
  'share',
  'invite',
  'book',
  'reply',
  'respond',
  'compose',
  'draft',
  'drafts',
  'message',
  'dm',
  'mail',
  'email'
]);
const RUN_READ_VERBS = new Set(['get', 'list', 'search', 'find', 'query', 'lookup', 'read', 'fetch', 'describe', 'show', 'retrieve', 'view', 'count', 'check']);
export function runReads(tool) {
  const name = String(tool || '');
  if (READ_NAMES.has(name.toLowerCase())) return true;
  if (sendsOrDeletes(name)) return false;
  const w = nameWords(name);
  if (!w.length || !RUN_READ_VERBS.has(w[0])) return false;
  return !w.slice(1).some((x) => OUTBOUND_WORDS.has(x));
}

export function sendsOrDeletes(tool) {
  // Judged against the non-sending tasks: a send tool that the send tasks would accept still sends.
  const tasks = Object.keys(TASKS).filter((t) => TASKS[t].kind !== 'send');
  const reasons = tasks
    .map((t) => screenTool(t, tool))
    .filter((r) => !r.ok)
    .map((r) => r.reason);
  return tasks.every((t) => !screenTool(t, tool).ok) && reasons.some((r) => /can send or publish|deletes or changes records/.test(r));
}

export const readsOnly = (tool) =>
  Object.entries(TASKS)
    .filter(([, t]) => t.kind === 'read')
    .some(([task]) => screenTool(task, tool).ok);

// The people-data server: every tool on it can spend the user's credits, whatever it is called
// ("find_email", "reveal_email", "search_people" on the server of an "apollo/people_enrichment" recipe), so
// any call there but the recipe's own tool and its read-only set goes through the lookup window too. The
// read-only set (read_only_tools in the recipe, default none) holds only tools that plainly read and don't
// look like a person lookup: "get_credit_balance" may go in it, "search_people" never.
// A read-only entry is honoured only when every word of its name is a plain read verb and then the user's own
// account on that server: "get_credit_balance", "list_credits", "get_account", "check_quota". Anything else
// ("get_executives", "find_by_domain", "get_record", a bare "search") stays in the window: a list of what to
// refuse never ends, a list of what may pass does.
const ACCOUNT_VERBS = new Set(['get', 'list', 'show', 'read', 'fetch', 'check']);
const ACCOUNT_WORDS = new Set([
  'credit',
  'credits',
  'balance',
  'usage',
  'quota',
  'plan',
  'account',
  'billing',
  'limit',
  'limits',
  'status',
  'whoami',
  'health',
  'me',
  'self',
  'version',
  'info',
  'ping'
]);
export function plainServerRead(t) {
  const w = toolWords(t);
  return w.length >= 2 && ACCOUNT_VERBS.has(w[0]) && w.slice(1).every((x) => ACCOUNT_WORDS.has(x)) && runReads(t);
}
// A browser call: judged by the server's name and the tool's (lib/security.mjs), never by the name alone.
export const isBrowser = (server, tool) => isBrowserCall(server, tool);

// What the first setup scan found each connector to be (setup_found). A later scan rebuilds "found" from a session
// file the model writes, so it can only ever be shown, never trusted. An inventory from before setup_found counts
// what it had found.
export const setupKinds = (inv) => (inv?.setup_found && typeof inv.setup_found === 'object' ? inv.setup_found : inv?.found || {});

// A browser_* tool on a server nothing else says is a browser could be any server's: a browser's reads aren't held
// to a server's limits, so it counts only on a browser server known by its exact name, one of those reached through
// remote devices (the one server that nests others, every part of the path exact), or one the first setup scan found
// to be one.
export function browserServerKnown(server, tool) {
  const nested = String(tool).split('__').slice(0, -1);
  if (isKnownBrowser(server) || (/^remote[-_]devices$/i.test(server) && nested.length && nested.every((x) => isKnownBrowser(x)))) return true;
  const inv = readJsonStrict(join(home(), 'inventory.json'), {});
  return (setupKinds(inv).browser || []).some((x) => String(x).startsWith('mcp:') && sameServer(String(x).slice(4), server));
}

// Is this server one floorboss was given, so the run lock limits it? Its recipes' servers, and the browser
// while a run reads a list there.
// A connector setup found (inventory.json, the scan's) or the user named for floorboss (onboarding.json: the CRM
// and people-data servers), as long as the first setup scan saw it.
export function foundServer(server) {
  const inv = readJsonStrict(join(home(), 'inventory.json'), {});
  const ob = readJsonStrict(join(home(), 'onboarding.json'), {});
  // Only connectors the first scan saw count (setup_servers: a later scan can't add one), and a server named in an
  // answer counts only when it is one of those: free text never names a server into the run's reads.
  const mcp = (list) => (list || []).filter((x) => String(x || '').startsWith('mcp:')).map((x) => String(x).slice(4));
  const kinds = setupKinds(inv);
  // An inventory from before setup_servers existed counts what it had found.
  const setup = (
    Array.isArray(inv?.setup_servers)
      ? inv.setup_servers
      : [...mcp(Object.values(inv?.found || {}).flat()), ...(inv?.items || []).filter((x) => x?.type === 'mcp').map((x) => x.name)]
  )
    .map(String)
    .filter(Boolean);
  const atSetup = (n) => setup.some((x) => sameServer(x, n));
  const found = mcp(Object.values(kinds).flat()).filter(atSetup);
  // A server named in an answer counts only as what setup found it to be: the CRM answer a CRM, the people-data
  // answer a people-data tool.
  const kind = (k, n) => typeof n === 'string' && n && mcp(kinds[k]).some((x) => sameServer(x, n)) && atSetup(n);
  const named = [
    kind('crm', ob?.answers?.crm_server) && ob.answers.crm_server,
    kind('enrichment', ob?.answers?.enrich_server) && ob.answers.enrich_server
  ].filter(Boolean);
  return [...found, ...named].some((n) => sameServer(server, n));
}
export function givenServer(server, config, run) {
  if (Object.values(config?.connectors || {}).some((r) => r && r.server && sameServer(server, r.server))) return true;
  return !!(run?.browser && isKnownBrowser(server));
}

// During a run, a tool floorboss has no recipe for may not be handed a web address or a path to keys and
// credentials, and general-purpose tools (fetch, query, request, SQL) wait until the run ends.
const GENERIC_WORDS = new Set(['fetch', 'query', 'request', 'get', 'read', 'sql', 'http', 'https', 'call', 'api', 'raw', 'execute', 'run']);
const secretArg = (v) => {
  try {
    return /^\s*(~\/|\/)/.test(v) && !!sensitiveKind(v.trim().replace(/^~(?=\/)/, homedir()));
  } catch {
    return false;
  }
};
export function argRefusal(tool, server, args) {
  const vals = leaves(args)
    .map(([, v]) => v)
    .filter((v) => typeof v === 'string');
  if (vals.some((v) => looksLikeUrl(v)))
    return `${tool} on ${server} was called with a web address, and a floorboss run is under way: while floorboss runs, tools it has no recipe for get no links (a link can carry data out).`;
  if (vals.some(secretArg)) return `${tool} on ${server} was called with a path to keys, credentials or configuration, and a floorboss run is under way.`;
  if (vals.some((v) => v.length > URL_CAP || /[\r\n]/.test(v)))
    return `${tool} on ${server} was called with a value that is long or spans lines, and a floorboss run is under way: tools it has no recipe for get short values only then.`;
  const w = nameWords(tool);
  if (w.length && w.every((x) => GENERIC_WORDS.has(x)))
    return `${tool} on ${server} is a general-purpose tool (it can fetch or run anything), and a floorboss run is under way: it waits until the run ends.`;
  return null;
}
