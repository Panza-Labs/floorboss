#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// PreToolUse guard for MCP calls, for Claude's own file tools (Read, Grep, Glob, Write, Edit, MultiEdit,
// NotebookEdit), and for the shell and subagent tools (Bash, PowerShell, Monitor, Agent, Task: see the main path);
// also binds the run lock to the session running floorboss (Bash) and ends it (SessionEnd).
// Run with "post" (PostToolUse), it records what a call that ran had asked about: a lookup counted, a staged
// batch confirmed (afterCall).
// - A tool floorboss has a recipe for may be called only with the recipe's own arguments, and stage_draft only
//   with a message floorboss listed to stage, word for word, to its own recipient.
// - While a floorboss run is under way (lib/runlock.mjs: for the session that ran floorboss, until it ends;
//   for others, until run-end or RUN_LOCK_MINUTES after the last refresh), every MCP tool on every server
//   must plainly read (runReads) and gets no links, the connectors floorboss was given must pass its stricter
//   read screens, and the browser only reads, opens only pages floorboss has a reason to, and never runs
//   script: an instruction hidden in an attendee note, a web page or a tool description can't send, write or
//   call out anywhere. Outside a run, tools floorboss has no recipe for are the user's own business.
// - Claude's own file tools: never a read of keys, credentials, shell histories or browser profiles; never a
//   write to floorboss's own records (only its scripts write those); and while a run is under way, no write
//   outside floorboss's data folder and the temp folder.
// - Claude Code's WebFetch and WebSearch, while a run is under way: no address or query past WEB_CAP or with a
//   line break, and WebFetch only to the sites the browser may open (webRefusal).
// - Any failure inside the guard blocks the call (fail closed).
import { readFileSync, readdirSync, existsSync, unlinkSync, writeFileSync, openSync, closeSync, mkdirSync, statSync, readSync } from 'node:fs';
import { join, basename, resolve, sep, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { home, allowedPath, readChecked, sensitiveKind, secretPlace, realPath, linkRefusal, recordFile, hardLinkRefusal, followed } from '../lib/paths.mjs';
import { readRun, readRunAnySession, stampRun, lockPath, endSession, touchSession, ranBefore } from '../lib/runlock.mjs';
import {
  isBrowserCall,
  isBrowserServer,
  isBrowserTool,
  isScriptTool,
  isBrowserReadTool,
  isNavigateTool,
  bareBrowserTool,
  readUrl,
  pageKey,
  looksLikeUrl,
  hostAllowed,
  crmPageAllowed,
  carriesData,
  tenantCrmHost,
  URL_CAP,
  SECRET_NAME,
  SECRET_SEARCH,
  sameServer
} from '../lib/security.mjs';
import { bareToolName, screenTool, toolWords, checkRecipe, TASKS, TEST_TASK } from '../skills/connectors/scripts/tasks.mjs';
import { verifySend, eventRecord, eventDay, approvalHash, recipientOf, lastReplyCheck, readersOf, taskMark } from '../lib/sendcheck.mjs';
import { contactable, readLedger } from '../lib/ledger.mjs';
import { withLock } from '../lib/lock.mjs';
import { screenArgs } from '../skills/connectors/scripts/tasks.mjs';
import { loadEvent } from '../lib/event.mjs';
import { writeSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { appendLine, writeText } from '../lib/jsonio.mjs';
import { isMain } from '../lib/main.mjs';
import { nowMs as clockNow } from '../lib/clock.mjs';

const norm = (x) =>
  String(x || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// A file that's missing reads as the fallback; one that exists but can't be read stops the guard.
function readJsonStrict(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Every leaf path in a value ("message.toRecipients[].emailAddress.address") with its value. Iterative and
// capped, so a deeply nested input can't crash the guard into letting a call through.
export function leaves(v) {
  const out = [];
  const stack = [[v, '', 0]];
  while (stack.length) {
    const [x, path, depth] = stack.pop();
    if (depth > 12) throw new Error('input nested too deep');
    if (out.length > 2000) throw new Error('input too large');
    if (Array.isArray(x)) x.forEach((y) => stack.push([y, `${path}[]`, depth + 1]));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) stack.push([y, path ? `${path}.${k}` : k, depth + 1]);
    else out.push([path, x]);
  }
  return out;
}

const PLACE = /\{[a-z_]+\}/g;
// A template value with placeholders inside it ("WHERE Email = '{email}'"): the real value must fit it.
// Inside quotes, what fills a placeholder can't hold quotes, a backslash, a semicolon or a line break: a name
// like "x' OR '1'='1" can't step out of the query's string. Outside quotes ("id eq {crm_id}", "{name}
// {company}"), it takes letters, digits, spaces and @ . + _ - : only, and in a template that is a query
// (it has =, <, >, eq, where, and, or…) no query word either: "1 or 1 eq 1" is refused.
const QUERY_WORDS = /\b(or|and|not|eq|ne|gt|lt|ge|le|like|in|is|null|select|union|where|from|delete|update|insert|drop|exec)\b/i;
function templateFits(t, v) {
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
// Setup's test draft or test task (connectors test-allow): one call, this server and tool, 15 minutes, and a
// test draft goes only to the address named.
// A once-only marker: created or refused, never both. It holds floorboss's clock time, so the record can tell an
// answer given after it from one given before.
const nameOfStaged = (evDir, it) => it.name || personName(evDir, it.id);
function markOnce(path, nowMs) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, new Date(nowMs).toISOString());
  } finally {
    closeSync(fd);
  }
}
export function testPasses(input, pending, nowMs) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m || !pending || nowMs - Date.parse(pending.at) > 15 * 60 * 1000) return false;
  if (bareToolName(pending.tool) !== m[2] || !sameServer(m[1], pending.server)) return false;
  if (!screenTool(pending.task, m[2]).ok) return false;
  // The call's arguments must have the shape a saved recipe for this task could have (only recipient,
  // subject, body and thread for a draft or send; title, body, due and contact for a task).
  if (testArgProblems(pending.task, input.tool_input || {}).length) return false;
  // The test task's words are floorboss's own (connectors test-allow says them): a test can't carry other text.
  if (pending.task === 'crm.create_task') {
    const vals = leaves(input.tool_input || {})
      .map(([, v]) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 40);
    if (vals.some((v) => v !== TEST_TASK.body)) return false;
  }
  if (pending.task === 'stage_draft' || pending.task === 'email.send' || pending.task === 'crm.create_contact') {
    const addrs = leaves(input.tool_input || {})
      .map(([, v]) => String(v ?? ''))
      .filter((v) => /@/.test(v));
    return addrs.length > 0 && addrs.every((a) => a.trim().toLowerCase() === pending.to);
  }
  // A test chat message goes only to the user's own number: every number-like value in the call is theirs.
  if (pending.task === 'chat.send') {
    // Every number-like value (7+ digits, spaced or not) must be the user's own number, compared as digits only;
    // a name-like field with letters in it (a chat, group or recipient name) refuses the call.
    const vals = leaves(input.tool_input || {});
    const nums = vals.map(([, v]) => String(v ?? '')).filter((v) => v.replace(/\D/g, '').length >= 7 && v.replace(/[\d\s+()-]/g, '').length === 0);
    const names = vals
      .filter(([p]) => /(^|\.)(chat|group|name|recipient|to|channel|conversation)[^.]*$/i.test(p))
      .map(([, v]) => String(v ?? ''))
      .filter((v) => /[a-z]/i.test(v));
    const mine = String(pending.to || '').replace(/\D/g, '');
    // Every other field (a thread, an address, an email, a reply-to id) is a destination too: it is the user's own
    // number or absent, never a second chat the prompt's "to your own number" wouldn't mention.
    const TEXT_KEY = new Set(['text', 'body', 'bodytext', 'message', 'content', 'caption', 'subject']);
    const keyOf = (p) => String(p).replace(/\[\]$/, '').split('.').pop().toLowerCase().replace(/[_-]/g, '');
    const others = vals.filter(([p]) => !TEXT_KEY.has(keyOf(p)) && !TEST_LITERALS.has(keyOf(p))).map(([, v]) => String(v ?? '').trim());
    const ownOnly = others.every((v) => v === '' || v.replace(/\D/g, '') === mine);
    return nums.length > 0 && !names.length && ownOnly && nums.every((n) => n.replace(/\D/g, '') === mine);
  }
  return true;
}

// The test call's arguments, with each value put back as the placeholder its key stands for, run through the
// same argument screen a recipe gets (skills/connectors/scripts/tasks.mjs screenArgs).
const TEST_PLACEHOLDER = {
  to: '{to}',
  address: '{to}',
  email: '{to}',
  subject: '{subject}',
  body: '{body}',
  content: '{body}',
  text: '{body}',
  bodytext: '{body}',
  thread: '{thread_id}',
  threadid: '{thread_id}',
  conversationid: '{thread_id}',
  inreplyto: '{reply_to_message_id}',
  replytomessageid: '{reply_to_message_id}',
  references: '{reply_to_message_id}'
};
const TASK_PLACEHOLDER = {
  title: '{title}',
  subject: '{title}',
  name: '{title}',
  hstasksubject: '{title}',
  body: '{body}',
  notes: '{body}',
  note: '{body}',
  description: '{body}',
  content: '{body}',
  hstaskbody: '{body}',
  due: '{due}',
  duedate: '{due}',
  dueat: '{due}',
  timestamp: '{due}',
  hstimestamp: '{due}',
  activitydate: '{due}',
  date: '{due}',
  contact: '{contact_ref}',
  contactid: '{contact_ref}',
  personid: '{contact_ref}',
  whoid: '{contact_ref}',
  id: '{contact_ref}',
  toobjectid: '{contact_ref}',
  email: '{contact_ref}'
};
const CONTACT_PLACEHOLDER = {
  name: '{name}',
  fullname: '{name}',
  firstname: '{first_name}',
  givenname: '{first_name}',
  lastname: '{last_name}',
  familyname: '{last_name}',
  surname: '{last_name}',
  email: '{email}',
  emailaddress: '{email}',
  primaryemail: '{email}',
  value: '{email}',
  company: '{company}',
  companyname: '{company}',
  organization: '{company}',
  organizationname: '{company}',
  orgname: '{company}',
  title: '{title}',
  jobtitle: '{title}',
  position: '{title}'
};
// Fields a test call may carry as they are (a content type, a draft flag): not destinations.
const TEST_LITERALS = new Set([
  'contenttype',
  'isdraft',
  'type',
  'tasktype',
  'hstasktype',
  'status',
  'hstaskstatus',
  'priority',
  'hstaskpriority',
  'objecttype',
  'associationtypeid',
  'associationcategory',
  'types',
  'primary',
  'label'
]);
export function testArgProblems(task, args) {
  const map = task === 'crm.create_task' ? TASK_PLACEHOLDER : task === 'crm.create_contact' ? CONTACT_PLACEHOLDER : TEST_PLACEHOLDER;
  const literal = TEST_LITERALS;
  const back = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => back(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, back(x, k.toLowerCase().replace(/[_-]/g, ''))]));
    if (literal.has(key)) return v;
    return map[key] && (typeof v === 'string' || typeof v === 'number') ? map[key] : v;
  };
  return screenArgs(back(args, ''), task);
}

// The first new contact (a test call, before the recipe exists) is held to the same list as every later one: a
// person floorboss listed in the last 30 minutes, with each name, email, company and title in the call read by its
// key and equal to the listed value. Null when no listed person matches.
export function testContactItem(args, pending, items, nowMs) {
  const vals = {};
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k.toLowerCase().replace(/[_-]/g, '')));
    const ph = CONTACT_PLACEHOLDER[key];
    if (ph && (typeof v === 'string' || typeof v === 'number')) (vals[ph] ||= []).push(String(v).trim());
  };
  walk(args || {}, '');
  const same = (ph, want) => (vals[ph] || []).every((x) => !x || x === String(want ?? '').trim());
  return (
    (items || []).find(
      (x) =>
        x &&
        typeof x === 'object' &&
        recent(x.listed_at, nowMs, 30 * 60 * 1000) &&
        fold(x.email) === fold(pending.to) &&
        same('{name}', x.name) &&
        same('{first_name}', x.first_name) &&
        same('{last_name}', x.last_name) &&
        same('{company}', x.company) &&
        same('{title}', x.title)
    ) || null
  );
}

const readsOnly = (tool) =>
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
export function enrichServerTool(config, server, tool) {
  const r = config?.connectors?.['enrich.person'];
  if (!r || !r.server || !sameServer(server, r.server)) return null;
  const ro = (Array.isArray(r.read_only_tools) ? r.read_only_tools : []).map(String).filter(plainServerRead);
  if (bareToolName(r.tool) === tool || ro.includes(tool)) return null;
  return r;
}
// The lookup window, for the recipe's tool and every other tool on its server: open, not used up, and the
// first lookup of the window asks the user. `used` counts lookups that ran (the PostToolUse hook adds one
// after each), never ones only asked about: a "no" at the first prompt leaves it at 0, so the next asks again.
// The window's numbers as the file has them, read strictly: an end that isn't a date is a closed window,
// a count or used that isn't a whole number is its floor (anything else 0), and ids differing only by case
// or spaces are one person.
const wholeOf = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
export const windowUsed = (w) => wholeOf(w?.used);
export const windowOpen = (w, nowMs) => !!w && !w.closed && Number.isFinite(Date.parse(w.until)) && Date.parse(w.until) >= nowMs;
export const windowAllowed = (w) =>
  Math.min(wholeOf(w?.count), Array.isArray(w?.ids) ? new Set(w.ids.map((x) => String(x).trim().toLowerCase()).filter(Boolean)).size : 0);
// What a lookup carries: one person from the lookup window (the shortlisted people with no email, written by
// floorboss's script when the user agreed), by their own name, company, title or profile link, or their
// company's domain. Anything else (a CRM note, a link, another person) is no lookup.
export function enrichArgRefusal(values, enrichWindow) {
  const people = Array.isArray(enrichWindow?.people) ? enrichWindow.people : [];
  const vals = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!vals.length) return null;
  if (!people.length) return 'the lookup window names no people to look up; floorboss asks again before any lookup.';
  const low = (x) =>
    String(x ?? '')
      .trim()
      .toLowerCase();
  const fits = (p, v) => {
    const parts = low(p.name).split(/\s+/).filter(Boolean);
    const known = [p.name, p.company, p.title, p.profile_url, parts[0], parts.slice(1).join(' '), parts[parts.length - 1]].map(low).filter(Boolean);
    if (known.includes(low(v))) return true;
    const slug = low(p.company).replace(/[^a-z0-9]/g, '');
    return (
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) &&
      v.length <= 80 &&
      slug.length >= 3 &&
      low(v)
        .replace(/[^a-z0-9]/g, '')
        .includes(slug.slice(0, 12))
    );
  };
  if (people.some((p) => vals.every((v) => fits(p, v)))) return null;
  return 'a lookup carries one listed person (their name, company, title, profile link or company domain) and nothing else.';
}
function enrichRefusal(r, server, tool, enrichWindow, asks, enrichUsed, own, values = []) {
  const nowMs = clockNow();
  const where = `${r.server || server}/${tool}`;
  if (!windowOpen(enrichWindow, nowMs)) {
    return own
      ? `a lookup in ${r.server || 'the people-data tool'} spends your credits, and you haven't agreed to any right now: floorboss asks first, with how many.`
      : `${tool} on ${server} isn't the lookup tool floorboss set up (${r.tool}), and a call there can spend your credits: floorboss lets it run only inside a lookup window you agreed to.`;
  }
  // Never more lookups than the people the window names (the shortlisted people with no email when the
  // user answered, each once), whatever count the file says.
  const allowed = windowAllowed(enrichWindow);
  const used = windowUsed(enrichWindow);
  // Lookups let through in this window that haven't finished count too, so several started at once can't pass the
  // count, before the first one ran (each of those asks) as after.
  const outstanding = enrichNotes(enrichWindow.until, nowMs).length;
  if (used + outstanding >= allowed) return lookupsGone(allowed, used, outstanding);
  {
    const why = enrichArgRefusal(values, enrichWindow);
    if (why) return why;
  }
  // The yes that opened the window came through an answer file Claude writes: until one lookup has run, each
  // asks the user, with the tool and the count; after that the rest of the count goes without asking.
  if (!(used > 0))
    asks.push(
      `floorboss: look people up in ${where}.${own ? '' : ` This isn't the lookup tool floorboss set up (${r.tool}), but it is on the same server and can spend credits too.`} Each lookup can spend a credit. This window allows ${allowed} lookup${allowed === 1 ? '' : 's'} (the people on your shortlist with no email), in the next ${Math.max(1, Math.round((Date.parse(enrichWindow.until) - nowMs) / 60000))} minutes; this is the first${outstanding ? ` (${outstanding} other${outstanding === 1 ? '' : 's'} already asked and not run count${outstanding === 1 ? 's' : ''} too)` : ''}. ${allowed - 1 - outstanding > 0 ? `Allowing it lets the other ${allowed - 1 - outstanding} go without asking again; ` : ''}if you decline, nothing is looked up, but this lookup still counts as one of the ${allowed} until the window ends (floorboss can't see a decline).`
    );
  enrichUsed.push(1);
  return null;
}

// Why no more lookups go in this window: the agreed number ran, or some of it is held by lookups let through that
// haven't run (waiting at a prompt, or declined, failed or stopped: floorboss can't tell which).
export function lookupsGone(allowed, used, waiting) {
  const n = (k) => `${k} lookup${k === 1 ? '' : 's'}`;
  return waiting
    ? `you agreed to ${n(allowed)} in this window: ${used} ran and ${waiting} ${waiting === 1 ? 'was' : 'were'} let through without running yet (waiting at a prompt, or declined, failed or stopped), and those count until the window ends. floorboss asks again before any more.`
    : `you agreed to ${n(allowed)} and they're used up; floorboss asks again before any more.`;
}
// Lookups let through and not run yet: one note per call (by its tool_use_id), in a folder. A note counts against
// its window until the window is replaced (floorboss can't tell a call declined at its prompt from one still
// waiting there, so it holds a slot rather than risk one too many), and goes after a day.
const enrichPendingDir = () => join(home(), 'enrich-pending');
const callNote = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
function enrichNotes(until, nowMs) {
  const dir = enrichPendingDir();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!/^[0-9a-f]{32}$/.test(f)) continue;
    let v = null;
    try {
      v = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue; // gone (another hook took it) or half there
    }
    if (v && v.until === until && recent(v.at, nowMs, 864e5)) out.push({ ...v, file: join(dir, f) });
    else
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* gone */
      }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
// Case folding for addresses: ASCII letters only, so a look-alike letter (the Kelvin sign for k) never
// compares equal to the real one.
const fold = (v) =>
  String(v ?? '')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
// A browser call: judged by the server's name and the tool's (lib/security.mjs), never by the name alone.
const isBrowser = (server, tool) => isBrowserCall(server, tool);

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
  // An inventory from before setup_servers existed counts what it had found.
  const setup = (
    Array.isArray(inv?.setup_servers)
      ? inv.setup_servers
      : [...mcp(Object.values(inv?.found || {}).flat()), ...(inv?.items || []).filter((x) => x?.type === 'mcp').map((x) => x.name)]
  )
    .map(String)
    .filter(Boolean);
  const atSetup = (n) => setup.some((x) => sameServer(x, n));
  const found = mcp(Object.values(inv?.found || {}).flat()).filter(atSetup);
  // A server named in an answer counts only as what setup found it to be: the CRM answer a CRM, the people-data
  // answer a people-data tool.
  const kind = (k, n) => typeof n === 'string' && n && mcp(inv?.found?.[k]).some((x) => sameServer(x, n)) && atSetup(n);
  const named = [
    kind('crm', ob?.answers?.crm_server) && ob.answers.crm_server,
    kind('enrichment', ob?.answers?.enrich_server) && ob.answers.enrich_server
  ].filter(Boolean);
  return [...found, ...named].some((n) => sameServer(server, n));
}
export function givenServer(server, config, run) {
  if (Object.values(config?.connectors || {}).some((r) => r && r.server && sameServer(server, r.server))) return true;
  return !!(run?.browser && isBrowserServer(server));
}

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

// run: what readRun() returns: { active, browser, until, path }, plus session (this session ran floorboss) and
// unreadable (a lock it can't read counts as active). A subagent's comes from readRunAnySession(), with session
// and subagent set: it gets the limits of the session that ran floorboss. A plain true means active, no details.
// What the run-lock refusals say: to the user, who decides; never an instruction to Claude to lift it.
// hosts: the event sites the user let in (site_allowed), shown when a page was refused, so the user sees
// exactly which sites beyond the fixed ones the browser may open.
function lockNote(run, hosts = null) {
  const at = run.until ? `${run.until.slice(11, 16)} UTC (${run.until})` : null;
  const when = run.subagent
    ? ` This call comes from a subagent, and a floorboss run is under way${at ? ` (until ${at} at the latest)` : ''}: floorboss holds subagents to the run's limits whichever session started it.`
    : run.session
      ? ` floorboss keeps this limit on this Claude session, which read the run's text, until the session ends: /clear or a new session lifts it, unless floorboss is running in another session too${at ? ` (it lifts by itself at ${at})` : ''}.`
      : at
        ? ` It ends when the run finishes, or at ${at} at the latest.`
        : run.unreadable
          ? ` floorboss's run lock (${run.path}) can't be read, so floorboss counts a run as under way.`
          : '';
  const sites =
    hosts == null
      ? ''
      : hosts.length
        ? ` Event sites you gave floorboss, which it may open too: ${hosts.join(', ')}.`
        : ' No event site of your own is allowed: floorboss lets one in only from the link you give when it asks where the attendee list is.';
  return `${when}${sites} If this is unexpected, it's for you, the user, to decide; Claude must not edit or delete floorboss's files to get past it.`;
}

// Where a browser call would go during a run or a window: only to pages floorboss has a reason to open.
// The event's own site (a site_allowed host) is a site floorboss knows nothing else about: only the list page
// the user gave opens without a word; any other page there is put to the user first (pushed to asks, with the
// whole address). A port is part of the page (lib/security.mjs pageKey): "expo.example:8443" is another site
// unless the saved list page has that port, and any other address with a port of its own is never opened.
function navRefusal(tool, args, hosts, pages = [], asks = []) {
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
function logNavRefusal(tool, args) {
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
function windowRefusal(tool, args) {
  const t = bareBrowserTool(tool);
  if (isBrowserReadTool(tool) || WINDOW_TOOLS.has(t)) return null;
  if (t === 'computer' && COMPUTER_ACTIONS.has(String(args?.action || ''))) return null;
  return `${tool}${args?.action ? ` (${args.action})` : ''} isn't something the browser window allows: it opens the listed people's pages, clicks, and types the listed messages, nothing else.`;
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
function argRefusal(tool, server, args) {
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

export function check(
  input,
  {
    config,
    stageItems,
    taskItems = [],
    contactItems = [],
    sendItems = [],
    active = false,
    browserSend = null,
    crmLog = null,
    sent = [],
    enrichWindow = null,
    enrichUsed = [],
    hosts = [],
    pages = [],
    asks = [],
    tasks = [],
    contacts = [],
    staged = []
  }
) {
  const name = String(input?.tool_name || '');
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const browser = isBrowser(m[1], m[2]);
  // Inboxes are private: LinkedIn messages and an event app's inbox are opened only if the user said yes
  // (inbox_read), whether or not a floorboss run is going on.
  if (browser || isBrowserServer(m[1]) || isBrowserTool(m[2])) {
    const why = inboxRefusal(input.tool_input || {}, config);
    if (why) return why;
  }
  const run = active === true ? { active: true } : active || { active: false };
  // Script in a web page: never while floorboss runs or a browser window is open.
  if ((browser || isBrowserServer(m[1])) && isScriptTool(m[2]) && (run.active || browserSend || crmLog))
    return `${m[2]} runs script in a web page, and ${run.active ? 'a floorboss run is under way' : 'a floorboss browser window is open'}: floorboss never lets a page run script then.${lockNote(run)}`;
  const recipes = Object.entries(config?.connectors || {}).filter(([, r]) => r && bareToolName(r.tool) === m[2] && (!r.server || sameServer(m[1], r.server)));
  // A recipe whose tool no longer passes floorboss's screen (an edited config.json) is never honoured.
  // A recipe that writes (a send, a staged draft, a new CRM contact, a CRM task) must pass the whole recipe check
  // (its test seen by the user, the tool's fingerprint, only its own placeholders), not just its name: a
  // config.json written by anything else is refused.
  for (const [task, r] of recipes)
    if ((TASKS[task]?.kind === 'send' || ['stage_draft', 'crm.create_contact', 'crm.create_task'].includes(task)) && checkRecipe(task, r).length)
      return `config.json's ${task} recipe isn't one floorboss saved (${checkRecipe(task, r)[0]}). Re-run discovery in /floorboss:event-setup.`;
  for (const [task, r] of recipes)
    if (!screenTool(task, r.tool).ok)
      return `config.json maps ${task} to ${r.tool}, which floorboss's screen refuses (${screenTool(task, r.tool).reason}). Re-run discovery in /floorboss:event-setup.`;
  if (!recipes.length) {
    // Another tool on the people-data server: the lookup window holds it, run or not; during a run it also
    // gets no links or key paths, and must be a read or a lookup.
    const er = enrichServerTool(config, m[1], m[2]);
    if (er) {
      if (run.active) {
        const arg = argRefusal(m[2], m[1], input.tool_input || {});
        if (arg) return `${arg}${lockNote(run)}`;
      }
      if (!runReads(m[2]) && !screenTool('enrich.person', m[2]).ok)
        return `${m[2]} on ${m[1]} isn't the lookup tool floorboss set up (${er.tool}) and isn't a read or a single lookup: floorboss doesn't let it run on the server it uses for paid lookups. If you, the user, want it, turn the floorboss plugin off for that session.`;
      return enrichRefusal(
        er,
        m[1],
        m[2],
        enrichWindow,
        asks,
        enrichUsed,
        false,
        leaves(input.tool_input || {})
          .map(([, v]) => v)
          .filter((v) => typeof v === 'string')
      );
    }
    const windowOpen = !!(browserSend || crmLog);
    if (!run.active && !(windowOpen && browser)) return null;
    const note = lockNote(run);
    // During a run, nothing anywhere may send, reply or delete: an instruction hidden in an attendee note or a
    // web page can't reach the user's mail, chat or CRM through any server, given to floorboss or not.
    // The browser does only reads during a run (no clicks, typing or form filling on a page), except inside a
    // send window the user's approval opened (outreach browser-send), for its listed messages, or the CRM log
    // window (outreach open-log-window), for logging listed messages in the CRM's web app; and it opens only
    // pages floorboss has a reason to (navRefusal).
    if (browser) {
      const nav = navRefusal(m[2], input.tool_input || {}, hosts, pages, asks);
      if (nav) return `${nav}${lockNote(run, hosts)}`;
      const logNav = crmLog && !browserSend ? logNavRefusal(m[2], input.tool_input || {}) : null;
      if (logNav) return logNav;
      if (windowOpen) return windowRefusal(m[2], input.tool_input || {});
      // Read tools keep their name with or without an _mcp suffix (tabs_context_mcp reads the open tabs).
      return isBrowserReadTool(m[2])
        ? null
        : `${m[2]} acts in the browser, and a floorboss run is under way: the browser only reads while floorboss runs.${note}`;
    }
    const arg = argRefusal(m[2], m[1], input.tool_input || {});
    if (arg) return `${arg}${note}`;
    // The connectors floorboss was given are held to floorboss's own read screens.
    // A tool name with a further "__" (mcp__hubspot__get__contacts) can come from a server named "hubspot__get":
    // it is never taken for the given or found server's.
    if (!m[2].includes('__') && givenServer(m[1], config, run))
      return readsOnly(m[2])
        ? null
        : `${m[2]} on ${m[1]} isn't a read-only tool, and a floorboss run is using this connector, so floorboss holds it to reads.${note}`;
    // Every other server: only tools that plainly read. A list of send words always misses one (a Resend
    // "emails.create", "add contacts to sequence", a Zapier action, an HTTP or webhook tool), so during a run
    // anything that isn't clearly a read waits until the run ends.
    // A connector setup found or the user chose (the scan's inventory, the onboarding answers): reads only, held
    // to floorboss's own read screens, as a given one is. Any other server (a workspace, a chat, a search or
    // DNS tool) gets nothing while floorboss runs: a read there can carry what this session read, in its query.
    // Another session, while a run is live (it didn't read the run's text): reads pass, as before.
    if (!run.session && !run.subagent) {
      if (runReads(m[2])) return null;
      return `${m[2]} on ${m[1]} isn't plainly a read, and a floorboss run is under way: while floorboss runs, tools on any server may only read (anything that could send, write or call out waits until the run ends).${note}`;
    }
    if (!m[2].includes('__') && foundServer(m[1]))
      return readsOnly(m[2])
        ? null
        : `${m[2]} on ${m[1]} isn't a read floorboss uses, and a floorboss run is under way: while floorboss runs, a connector it hasn't set up yet may only be read with the tools floorboss checks for.${note}`;
    return `${m[2]} is on ${m[1]}, which floorboss wasn't given and didn't find at setup, and a floorboss run is under way: while floorboss runs, it calls only the connectors it uses (anything else could carry what this session read). ${m[1]} is available again when the run ends.${note}`;
  }
  const args = input.tool_input || {};
  const got = leaves(args);
  for (const [task, r] of recipes) {
    // The recipe's leaves by path; a path may hold several values (a list of fields), any of which is fine.
    const template = new Map();
    for (const [p, v] of leaves(r.args || {})) template.set(p, [...(template.get(p) || []), v]);
    for (const [p, v] of got) {
      const allowed = template.get(p);
      if (!allowed) return `${m[2]} was called with "${p}", which isn't in floorboss's ${task} recipe.`;
      const fits = allowed.some((t) =>
        typeof t === 'string' && /\{[a-z_]+\}/.test(t) ? /^\{[a-z_]+\}$/.test(t) || templateFits(t, String(v ?? '')) : t === v
      );
      if (!fits) return `${m[2]}: "${p}" must be as in the recipe (${allowed.map((t) => JSON.stringify(t)).join(' or ')}).`;
    }
    // A people-data lookup spends the user's credits: only inside the window their yes opened, and no more
    // lookups than they agreed to.
    if (task === 'enrich.person') {
      // The values at the recipe's placeholders (its literals are checked above, as written).
      const placeheld = got.filter(([p]) => (template.get(p) || []).some((t) => typeof t === 'string' && /\{[a-z_]+\}/.test(t))).map(([, v]) => v);
      const why = enrichRefusal(
        r,
        m[1],
        m[2],
        enrichWindow,
        asks,
        enrichUsed,
        true,
        placeheld.filter((v) => typeof v === 'string')
      );
      if (why) return why;
      continue;
    }
    if (task === 'crm.create_task') {
      const v = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, x]) => String(x ?? ''));
      const title = v('{title}'),
        body = v('{body}'),
        ref = v('{contact_ref}'),
        due = v('{due}');
      if (!title.length || !body.length) return 'a task needs its title and body, exactly as floorboss listed them.';
      if (ref.length > 1) return 'a task goes on one contact only.';
      // A due date is a date (2026-10-30, or with a time: 2026-10-30T09:00:00Z), never a line of text: it goes
      // in the prompt as it is.
      if (!due.every((d) => !d.trim() || /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?$/.test(d.trim())))
        return "a task's due date is the date floorboss listed (YYYY-MM-DD), nothing else.";
      // Listed in the last 30 minutes: a list made before someone said stop can't be used after.
      // floorboss's clock (FLOORBOSS_NOW in tests and simulations), else the real one.
      const nowMs = clockNow();
      const fresh = (x) => !x.listed_at || recent(x.listed_at, nowMs, 30 * 60 * 1000);
      const item = (taskItems || [])
        .filter((x) => x && typeof x === 'object' && fresh(x))
        .find(
          (x) =>
            title.every((t) => t.trim() === String(x.title).trim()) &&
            body.every((b) => b.trim() === String(x.body).trim()) &&
            (x.contact_ref ? ref.every((r) => r.trim().toLowerCase() === String(x.contact_ref).toLowerCase()) : ref.every((r) => !r.trim())) &&
            due.every((d) => !x.due || d.slice(0, 10) === String(x.due).slice(0, 10) || Math.abs(Date.parse(d) - Date.parse(x.due)) < 36 * 3600000)
        );
      if (!item)
        return 'this task isn\'t one floorboss listed in the last 30 minutes (title, body, contact and due date must match an item in task-list.json). Run "outreach task-list" again and use its text as written.';
      // A task is a write in the user's CRM: they see what goes in before it does (the list is a file a
      // session could write, like the send list).
      tasks.push({
        server: r.server || m[1],
        tool: m[2],
        title: title[0],
        body: body[0],
        contact: ref[0] || null,
        due: due[0] || null,
        name: item.name || item.id || null,
        id: item.id || null,
        key: item.key || null,
        _event: item._event || null
      });
      continue;
    }
    // A new CRM record: one person floorboss listed in the last 30 minutes, with their own name, email,
    // company and title exactly as listed. The user sees it whole before it goes in.
    if (task === 'crm.create_contact') {
      const v = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, x]) => String(x ?? '').trim());
      const email = v('{email}');
      if (email.length !== 1) return 'a new CRM record carries exactly one address, the listed one.';
      const nowMs = clockNow();
      const same = (vals, want) => vals.every((x) => !x || x === String(want ?? '').trim());
      const item = (contactItems || [])
        .filter((x) => x && typeof x === 'object' && recent(x.listed_at, nowMs, 30 * 60 * 1000))
        .find(
          (x) =>
            fold(email[0]) === fold(x.email) &&
            same(v('{name}'), x.name) &&
            same(v('{first_name}'), x.first_name) &&
            same(v('{last_name}'), x.last_name) &&
            same(v('{company}'), x.company) &&
            same(v('{title}'), x.title)
        );
      if (!item)
        return 'this person isn\'t one floorboss listed to add to your CRM in the last 30 minutes (name, email, company and title must match an item in contact-list.json). Run "outreach contact-list" again and use its values as written.';
      contacts.push({
        server: r.server || m[1],
        tool: m[2],
        name: item.name,
        email: item.email,
        company: item.company || '',
        title: item.title || '',
        id: item.id,
        _event: item._event,
        // What the call itself carries, shown as sent: the prompt never shows only the list's version.
        args: got.map(([p, x]) => `${p}: ${String(x ?? '').slice(0, 120)}`)
      });
      continue;
    }
    if (TASKS[task]?.kind === 'send') {
      // A send: exactly one approved message from today's send list, listed in the last 30 minutes, to its own
      // recipient with its own text, and not sent before (each item goes once).
      const value = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, v]) => String(v ?? ''));
      const to = value('{to}'),
        subject = value('{subject}'),
        body = value('{body}');
      if (!to.length || !body.length) return 'a send needs its recipient and body, exactly as floorboss listed them.';
      const nowMs = clockNow();
      const item = (sendItems || [])
        .filter((x) => x && typeof x === 'object' && x.via === task && recent(x.listed_at, nowMs, 30 * 60 * 1000))
        .find(
          (x) =>
            to.every((t) => fold(t) === fold(x.to)) &&
            body.every((b) => b.trim() === String(x.body).trim()) &&
            subject.every((v) => v.trim() === String(x.subject || '').trim())
        );
      if (!item)
        return 'this message isn\'t one floorboss listed to send in the last 30 minutes (recipient, subject and body must match an item in send-list.json exactly, and each goes once). Run "outreach send-list" and send its items as written.';
      // The thread: a follow-up goes in the thread of the message before it, and only that one. A thread
      // argument holding anything else (another person's conversation) is refused; one left out is refused
      // when floorboss knows the thread and the tool can take it.
      const threads = [...value('{thread_id}'), ...value('{reply_in_thread}')].map((t) => t.trim()).filter(Boolean);
      const replyTo = value('{reply_to_message_id}')
        .map((t) => t.trim())
        .filter(Boolean);
      if (replyTo.some((t) => t !== String(item.reply_to_message_id || '')))
        return `the reply-to argument must be the listed one (${item.reply_to_message_id || 'none'}).`;
      const canThread = [...template.values()].flat().some((t) => t === '{thread_id}' || t === '{reply_in_thread}');
      if (threads.some((t) => t !== String(item.thread_id || '')))
        return `the thread argument must be the listed one (${item.thread_id || 'none: a first message starts a new thread'}).`;
      if (canThread && item.thread_id && !threads.length) return `this follow-up goes in the thread of the message before it: pass thread ${item.thread_id}.`;
      sent.push(item);
      continue;
    }
    if (task !== 'stage_draft') continue;
    const value = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, v]) => String(v ?? ''));
    const to = value('{to}'),
      subject = value('{subject}'),
      body = value('{body}');
    if (!to.length || !body.length) return 'a staged draft needs its recipient and body, exactly as floorboss listed them.';
    const same = (x) =>
      to.every((t) => fold(t) === fold(x.to)) &&
      body.every((b) => b.trim() === String(x.body).trim()) &&
      subject.every((s) => s.trim() === String(x.subject || '').trim());
    const item = (stageItems || []).filter((x) => x && typeof x === 'object' && !x._why).find(same);
    // Listed and approved, but the record says no now (a stop, a reply, removed, or listed too long ago).
    const held = !item && (stageItems || []).filter((x) => x && typeof x === 'object' && x._why).find(same);
    if (held) return `the draft for ${held.id} can't be staged now: ${held._why}.`;
    if (!item)
      return 'this draft isn\'t one floorboss listed to stage (recipient, subject and body must match an item in stage-list.json exactly). Run "outreach stage-list" and use its text as written.';
    // The thread, as for a send: only the listed one (the draft before it with this person), never another
    // conversation; and no reply-to of its own.
    {
      const threads = [...value('{thread_id}'), ...value('{reply_in_thread}')].map((t) => t.trim()).filter(Boolean);
      if (threads.some((t) => t !== String(item.reply_in_thread || '')))
        return `the thread argument must be the listed one (${item.reply_in_thread || 'none: a first message starts a new thread'}).`;
      if (value('{reply_to_message_id}').some((t) => t.trim() && t.trim() !== String(item.reply_to_message_id || '')))
        return `the reply-to argument must be the listed one (${item.reply_to_message_id || 'none'}).`;
    }
    staged.push({ ...item, server: r.server || m[1], tool: m[2] });
  }
  return null;
}

// A person who was held (a do-not-contact, opt-out or stop match, a coworker's hold: the ledger's hold_seen)
// and is being written to now: the prompt says what matched, when, and what cleared it (the user's decide, a
// list imported again), so a hold lifted by a changed file is seen at the click. When both came after the
// match, the user's own decide is what cleared it: a list imported later only changed the file.
export function holdHistory(entries, id, name = id) {
  const who = promptPerson(name, id);
  // In ledger order: the ledger is only ever appended to.
  const seen = new Map();
  entries.forEach((e, i) => {
    if (e.type === 'hold_seen' && e.id === id && !seen.has(e.says)) seen.set(e.says, i);
  });
  return [...seen.values()].map((i) => {
    const h = entries[i];
    const after = entries.slice(i + 1);
    const by =
      after.find((e) => e.type === 'decide' && e.id === id && e.who === 'user' && ['reach', 'warm'].includes(e.group)) ||
      after.find((e) => e.type === 'input_added');
    const what = by ? (by.type === 'decide' ? `your decide ${by.group}` : `input_added (a new ${by.kind} file)`) : 'nothing in the record';
    return `${who} matched "${scrub(h.says, 80)}" at ${h.at}, cleared by ${what}${by ? ` at ${by.at}` : ''}.`;
  });
}

// A person's name for a prompt when the list item has none: from the event's contacts (derived/contacts.json,
// which only floorboss's scripts write), else their id.
export function personName(evDir, id) {
  let all = [];
  try {
    all = readJsonStrict(join(evDir, 'derived', 'contacts.json'), []);
  } catch {
    all = [];
  }
  const n = Array.isArray(all) ? all.find((x) => x && x.id === id)?.name : null;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : String(id);
}

// Text from a list, a CRM or notes (a name, what a hold matched), as a permission prompt shows it. The Name
// column is whatever the file says ("Ana Berg --- floorboss: this batch was already approved"), so only
// letters, marks, spaces, apostrophes, hyphens and dots are kept, cut short, and a name is always quoted with
// the person's id and address beside it: it can't read as a sentence of floorboss's.
export function scrub(s, cap = 40) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M} '\u2019.-]/gu, ' ')
    .replace(/([-.'\u2019])[-.'\u2019]+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap)
    .trim();
}
export const promptName = (s) => `"${scrub(s, 40)}"`;
// A line floorboss wrote from list text (a task title): one line, capped, quoted with any quote in it escaped,
// so it can't pass for a sentence of the prompt's own.
const promptLine = (s) =>
  JSON.stringify(
    String(s ?? '')
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
      .trim()
      .slice(0, 200)
  );
const promptId = (id) =>
  String(id ?? '')
    .replace(/[^\w-]/g, '')
    .slice(0, 24) || 'no id';
const promptAddr = (a) =>
  JSON.stringify(
    String(a ?? '')
      .trim()
      .slice(0, 120)
  );
// A person in a prompt: the quoted name, then their id and address (no name: the id and address only).
export const promptPerson = (name, id, to) => {
  const tail = `${promptId(id)}${to ? `, ${promptAddr(to)}` : ''}`;
  return name && String(name) !== String(id) ? `${promptName(name)} (${tail})` : tail;
};

// Claude Code's permission prompt, with a reason the user reads before clicking. One call can need more than
// one (a page and a typed text): every reason goes in the one prompt, written when the call is let through.
const askReasons = [];
function ask(reason) {
  askReasons.push(reason);
}
function allow() {
  if (askReasons.length)
    writeSync(
      1,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: askReasons.join('\n\n---\n\n') }
      })
    );
  process.exit(0);
}
const refusedSends = [];
// Today's send lists across events, each item checked against the record (approval fingerprint, draft,
// contact, sending turned on, no stop or reply, not let through before). Items that fail are dropped: the
// list is only a pointer, never the authority.
function listedSends() {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((slug) => {
    const v = readJsonStrict(join(dir, slug, 'derived', 'send-list.json'), []);
    if (!Array.isArray(v) || !v.length) return [];
    let settings;
    try {
      settings = loadEvent(slug).settings;
    } catch {
      return [];
    }
    const rec = eventRecord(join(dir, slug));
    const nowMs = clockNow();
    return v
      .map((x) => {
        const r = verifySend(x, { evDir: join(dir, slug), settings, ...rec, nowMs });
        // Kept to explain a refusal: "check their replies again" says more than "not listed".
        if (!r.ok && x && typeof x === 'object')
          refusedSends.push({ to: String(x.to || ''), body: String(x.body || ''), name: x.name || x.id, id: x.id, why: r.why });
        return r.ok ? { ...x, hash: r.hash, _event: slug } : null;
      })
      .filter(Boolean);
  });
}

// The approved app and LinkedIn notes of an event, each checked against the record like an email send.
function browserItems(slug) {
  const dir = join(home(), 'events', slug);
  const v = readJsonStrict(join(dir, 'derived', 'browser-send-list.json'), []);
  if (!Array.isArray(v) || !v.length) return [];
  // The list only names the person for the prompt; the user sees the text and the page and decides.
  return v.filter((x) => x && typeof x === 'object' && /^c\d+$/.test(String(x.id)) && x.via === 'browser');
}

// The browser send window, if one is open: browser-send.json must match a window opened in that event's log
// (by its own command, with the user's words), at most 20 minutes ago.
const windowKey = (kind, w) => `${kind}:${w.event}:${w.until}`;
// The call a prompt was about: a note written by the pre hook counts only for the post hook of that same call
// (Claude Code gives both the call's tool_use_id; without one, the session and tool name stand in).
const callId = (input) => ({ call: String(input?.tool_use_id || ''), session: String(input?.session_id || ''), tool: String(input?.tool_name || '') });
const sameCall = (note, input) =>
  note.call ? note.call === String(input?.tool_use_id || '') : note.session === String(input?.session_id || '') && note.tool === String(input?.tool_name || '');
function openWindow(nowMs) {
  const bs = readJsonStrict(join(home(), 'browser-send.json'), null);
  if (!bs || bs.closed || !bs.event || !/^[a-z0-9-]+$/.test(bs.event)) return null;
  const { entries } = eventRecord(join(home(), 'events', bs.event));
  const opened = entries.filter((e) => e.type === 'browser_send_opened' && e.until === bs.until && e.said).pop();
  if (!opened) return null;
  // Opened in the last 20 minutes, never dated ahead of the clock (a window "opened" tomorrow stays shut), and
  // closing within the next 21 minutes.
  return recent(opened.at, nowMs, 20 * 60000) && Date.parse(bs.until) > nowMs && Date.parse(bs.until) - nowMs <= 21 * 60000 ? bs : null;
}

// The CRM log window: the user's yes to log listed LinkedIn and app messages in their CRM's web app. Matches a
// crm_log_opened entry in that event's log (with the user's words), at most 20 minutes ago.
function openLogWindow(nowMs) {
  const w = readJsonStrict(join(home(), 'crm-log-window.json'), null);
  if (!w || w.closed || !w.event || !/^[a-z0-9-]+$/.test(w.event)) return null;
  const { entries } = eventRecord(join(home(), 'events', w.event));
  const opened = entries.filter((e) => e.type === 'crm_log_opened' && e.until === w.until && e.said).pop();
  if (!opened) return null;
  return recent(opened.at, nowMs, 20 * 60000) && Date.parse(w.until) > nowMs && Date.parse(w.until) - nowMs <= 21 * 60000 ? w : null;
}
export function logItems(slug) {
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

function listed(file, nowMs = Date.now()) {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((slug) => {
    const v = readJsonStrict(join(dir, slug, file), []);
    if (!Array.isArray(v)) return [];
    if (file === 'contact-list.json' || file === 'task-list.json') return v.filter((x) => x && typeof x === 'object').map((x) => ({ ...x, _event: slug }));
    if (file !== 'stage-list.json') return v;
    // An approved draft is staged only while the record still lets floorboss write to that person.
    return v
      .filter((x) => approvedText(join(dir, slug), x))
      .map((x) => {
        const why = stageRefusal(join(dir, slug), x, nowMs);
        return why ? { ...x, _why: why, _event: slug } : { ...x, _event: slug };
      });
  });
}

// Within `ms` before now, and not dated in the future (more than a minute ahead of floorboss's clock).
export function recent(at, nowMs, ms) {
  const t = Date.parse(at);
  return Number.isFinite(t) && nowMs - t < ms && t - nowMs <= 60000;
}

// Why an approved draft can't be put in the mailbox now: the same record checks a send has (a stop, a reply
// or booking, removed or dropped, a damaged ledger line), and listed in the last 30 minutes. Null: it can.
export function stageRefusal(evDir, item, nowMs = Date.now()) {
  const { state, folded } = eventRecord(evDir);
  const touch = item.touch ?? 1;
  const kind = touch === 0 ? 'confirmation' : 'message';
  const held = contactable(folded, item.id, kind, eventDay(evDir, nowMs));
  if (held) return held;
  const st = state[item.id] || {};
  if (st.stopped || st.removed || st.dropped) return "they're stopped, removed or dropped";
  if (kind !== 'confirmation' && (st.replied || st.booked)) return 'they replied or booked';
  if (kind === 'confirmation' && !folded.people[item.id]?.booked) return 'their booking was taken back';
  if (!recent(item.listed_at, nowMs, 30 * 60 * 1000)) return 'it wasn\'t listed in the last 30 minutes: run "outreach stage-list" again';
  return null;
}

// A staged draft must be one the user approved, word for word: an item written into stage-list.json by
// anything else (an injected Write) has no approved draft behind it.
// A staged draft is held to the same approval fingerprint as a send: the saved text, to the contact's own
// address, with the approved subject. A list entry with the approved body but another recipient or subject
// is not approved.
export function approvedText(evDir, item) {
  if (!item || typeof item !== 'object' || !/^c\d+$/.test(String(item.id))) return false;
  const touch = item.touch ?? 1;
  const { state } = eventRecord(evDir);
  const appr = state[item.id]?.touches?.[touch]?.approved;
  if (!appr?.hash || !appr.to) return false;
  const d = readJsonStrict(join(evDir, 'drafts', `${appr.hash}.json`), null);
  if (!d || approvalHash(d, appr.to) !== appr.hash) return false;
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  return same(item.body, d.body) && same(item.subject || '', d.subject || '') && fold(item.to) === fold(appr.to);
}

// What a send prompt shows: the whole message (subject and body, up to 1,500 characters) and the recipient
// as the call carries it, so the user reads what actually goes, not a summary.
export function fullText(subject, body, cap = 1500) {
  const t = `${subject ? `Subject: ${subject}\n\n` : ''}${String(body ?? '')}`;
  return t.length > cap ? `${t.slice(0, cap)}… (${t.length - cap} more characters)` : t;
}

// The recipient a send prompt shows: the values the call carries where the recipe has its {to}
// placeholder (not any value with an @ in it, which a body or a subject can hold too).
export function recipientShown(args, recipe, fallback) {
  const template = new Map();
  for (const [p, v] of leaves(recipe?.args || {})) template.set(p, [...(template.get(p) || []), v]);
  const to = [
    ...new Set(
      leaves(args)
        .filter(([p]) => (template.get(p) || []).includes('{to}'))
        .map(([, v]) => String(v ?? '').trim())
        .filter(Boolean)
    )
  ];
  return to.length ? to.join(', ') : fallback;
}

// Claude's own file tools (Read, Grep, Glob, Write, Edit, NotebookEdit).
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PLUGIN_ROOT = resolve(process.env.CLAUDE_PLUGIN_ROOT || new URL('..', import.meta.url).pathname);
const expand = (p) => resolve(String(p).replace(/^~(?=$|\/)/, homedir()));
const inside = (p, root) => {
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};
// A glob as the screens read it: each brace alternative spelled out ("~/.s{s,x}h" is "~/.ssh" and "~/.sxh"),
// and every other wildcard ("?", "[…]", braces past 64 spellings) read as "*". A name screen cut at the first
// wildcard missed "~/.s{s,}h/*" and "**/.s?h/*".
export function globForms(g) {
  let out = [String(g ?? '')];
  for (let i = 0; i < 8 && out.some((s) => /\{[^{}]*\}/.test(s)); i++) {
    out = out.flatMap((s) => {
      const m = /\{([^{}]*)\}/.exec(s);
      return m ? m[1].split(',').map((alt) => s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)) : [s];
    });
    if (out.length > 64) {
      out = out.slice(0, 64).map((s) => s.replace(/\{[^}]*\}?/g, '*'));
      break;
    }
  }
  return [
    ...new Set(
      out.map((s) =>
        s
          .replace(/\{[^}]*\}?/g, '*')
          .replace(/\[[^\]]*\]?/g, '*')
          .replace(/\?/g, '*')
          .replace(/\*{3,}/g, '**')
      )
    )
  ];
}
// Key and credential files by name, under the home folder: a glob that would match one of these (with at
// least two plain letters in it, so "**/*" in a project isn't read as a search for keys) is one. Only names
// that say what they hold: a "config.json" search isn't a key search (SECRET_SEARCH still names .docker).
const SECRET_SAMPLES = [
  '.ssh',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.aws/credentials',
  '.gnupg/secring.gpg',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.vault-token',
  '.config/gcloud/credentials.db',
  '.zsh_history',
  '.bash_history',
  '.env',
  'project/.env',
  'Library/Keychains/login.keychain-db',
  'Library/Cookies/Cookies.binarycookies',
  'Library/Application Support/Google/Chrome/Default/Login Data',
  'certs/server.pem',
  'keys/id_rsa'
];
const globRe = (p) =>
  p
    .split(/(\*\*\/|\*\*|\*)/)
    .map((x) => (x === '**/' ? '(?:.*/)?' : x === '**' ? '.*' : x === '*' ? '[^/]*' : x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
export function globSeeksSecrets(g) {
  const hh = homedir();
  return globForms(g).some((f) => {
    if (SECRET_SEARCH.test(f)) return true;
    let p = f.replace(/^~(?=\/|$)/, hh);
    const anchored = p === hh || p.startsWith(`${hh}/`);
    p = anchored ? p.slice(hh.length + 1) : p.replace(/^\/+/, '');
    if (p.replace(/[*/]/g, '').length < 2) return false;
    const re = new RegExp(`${anchored ? '^' : '(^|/)'}${globRe(p)}$`, 'i');
    return SECRET_SAMPLES.some((s) => re.test(s) || re.test(`${hh.slice(1)}/${s}`));
  });
}
// The paths a file tool call names (Glob's pattern only when it is an absolute or ~ path, once per spelling,
// up to its first wildcard).
function pathsOf(tool, input) {
  const i = input || {};
  const out = [i.file_path, i.notebook_path, i.path].filter((x) => typeof x === 'string' && x.trim());
  if (tool === 'Glob' && typeof i.pattern === 'string' && /^(~|\/)/.test(i.pattern))
    for (const f of globForms(i.pattern)) out.push(f.replace(/\*.*$/, '') || '/');
  return out.map(expand);
}
// recordFile (the records only floorboss's scripts write) lives in lib/paths.mjs: script --out paths use it too.
export { recordFile };
// SECRET_NAME (key folders, never written) and SECRET_SEARCH (a search by name for keys and tokens) live in
// lib/security.mjs: crm-triage's list files are screened by the same names.
// Grep that prints matching lines (output_mode "content") over the home folder, a folder above it, or
// ~/Library prints keys and tokens wherever they sit: refused, run or not. Naming the files that match (the
// default, files_with_matches) or counting them per file is refused there too: the names alone say which
// files hold a key ("grep AKIA" over the home folder lists them).
const libraryDir = () => join(homedir(), 'Library');
function grepContentRefusal(input, mine = false) {
  const mode = String(input?.output_mode || 'files_with_matches');
  if (!['content', 'files_with_matches', 'count'].includes(mode))
    return mine ? `"${mode.slice(0, 30)}" isn't a search mode floorboss knows, and a floorboss run is under way.` : null;
  const where = typeof input?.path === 'string' && input.path.trim() ? expand(input.path) : process.cwd();
  const rp = realPath(where);
  // While floorboss runs in this session, a search that prints lines runs only over floorboss's data folder:
  // anywhere else it could print a key or credential file (a project's .env, a
  // .docker folder) that Read is refused, and no list of names or file types matches ripgrep's own. Listing the
  // files that match, then reading them, still works: Read refuses those files.
  if (mode === 'content' && mine && !inside(rp, realPath(home())))
    return `a search that prints matching lines over ${where} could print a key or credential file, and a floorboss run is under way: search floorboss's data folder, or list the files that match (output_mode "files_with_matches") and read the ones you need.`;
  if (inside(realPath(homedir()), rp) || inside(rp, realPath(libraryDir())))
    return mode === 'content'
      ? `a search that prints matching lines over ${where} would print keys and credentials, and floorboss never lets Claude read those: search inside a project folder.`
      : `a search that lists the files matching it over ${where} would say which files hold keys and credentials, and floorboss never lets Claude look for those: search inside a project folder.`;
  return null;
}
// Why a file tool call is refused, or null.
// The limits that hold while a run is under way apply to the session that ran floorboss (run.session); other
// sessions keep their file tools (the MCP limits still cover them for the lock's 30 minutes).
export function fileRefusal(tool, input, run = { active: false }) {
  const mine = !!(run.active && run.session);
  const searches = tool === 'Grep' || tool === 'Glob';
  // A search by name for keys or credentials ("**/.ssh/*", "**/*_history"), wherever it starts: Glob's
  // pattern, and the file filter of either tool.
  if (searches && [tool === 'Glob' ? input?.pattern : null, input?.glob].some((g) => typeof g === 'string' && globSeeksSecrets(g)))
    return `that search looks for keys, credentials or private history, and floorboss never lets Claude read those.`;
  for (const p of pathsOf(tool, input)) {
    if (inside(realPath(p), realPath(PLUGIN_ROOT))) {
      if (WRITE_TOOLS.has(tool)) return `floorboss's own plugin files aren't written by Claude.`;
      if (!sensitiveKind(p) || sensitiveKind(p) !== 'secret') continue;
    }
    const kind = sensitiveKind(p);
    // A hard link in the data or temp folder: its other name may be a key or a shell profile (reads and writes).
    {
      const why = hardLinkRefusal(p);
      if (why) return why;
    }
    // Writes are judged by where they land: the real path (symlinks followed as far as the path exists), not
    // the path as written, so a link planted in the data folder can't carry a write to ~/.ssh or ~/.zshrc.
    // A write whose real path is a key place though the path as written names none came through a link.
    const rp = realPath(p);
    const viaLink = WRITE_TOOLS.has(tool) && !secretPlace(p);
    // Keys, credentials, shell histories and browser profiles: never read, run or not (floorboss reads
    // untrusted text, and text it read can outlast its run); never written while floorboss runs, never
    // written through a link, and key folders (.ssh, .aws, .gnupg…) never written at all.
    if (kind === 'secret' && (READ_TOOLS.has(tool) || mine || viaLink || SECRET_NAME.test(p) || SECRET_NAME.test(rp)))
      return `${p} holds keys, credentials or private history, and floorboss (installed in this Claude Code) doesn't let Claude ${READ_TOOLS.has(tool) ? 'read' : 'write'} there. If you, the user, need Claude to, turn the floorboss plugin off for that session.`;
    if (READ_TOOLS.has(tool)) {
      // A search over a folder that holds them (the home folder, or above it) while floorboss runs.
      if (searches && mine && inside(homedir(), p))
        return `a search over ${p} would reach keys and credentials, and a floorboss run is under way in this session: search inside a project folder instead.${lockNote(run)}`;
      // Claude and shell configuration: not while floorboss runs in this session. Claude's own session files
      // (projects, worktrees, plans) and the agents, skills and commands floorboss's scan reads stay readable.
      if (kind === 'config' && mine && !/\/\.claude\/(agents|skills|commands|plugins|projects|worktrees|plans|todos)(\/|$)/.test(p))
        return `${p} is configuration, and a floorboss run is under way: Claude doesn't read it then.${lockNote(run)}`;
      continue;
    }
    // A path written inside the data folder that really lands outside it (a link in the data folder) is
    // refused, run or not: the commands pre-approve writes there by the path as written.
    if ((inside(p, home()) || inside(p, realPath(home()))) && !inside(rp, realPath(home())))
      return `${p} is inside floorboss's data folder as written but really leads to ${rp}, outside it: floorboss doesn't let Claude write through a link there.`;
    // A link on the way that real() can't see through: one whose target isn't there yet (a write creates it).
    {
      const why = linkRefusal(p);
      if (why) return why;
    }
    if (recordFile(p))
      return `${p} is one of floorboss's own records, which only its scripts write (an edited record could make a send look approved). Use the floorboss command that changes it.`;
    // Where the write really lands: through every link on the way, one whose target isn't there yet included.
    const landsIn = (x) => inside(x, realPath(home())) || [tmpdir(), '/tmp', '/private/tmp'].some((r) => existsSync(r) && inside(x, realPath(r)));
    let lands = null;
    try {
      lands = followed(p).to;
    } catch {
      lands = null;
    }
    if (mine && (!landsIn(realPath(p)) || !lands || !landsIn(lands)))
      return `${p} is outside floorboss's data folder and the temp folder${lands && lands !== resolve(p) ? ` (it leads to ${lands})` : ''}, and a floorboss run is under way: Claude writes nowhere else then.${lockNote(run)}`;
  }
  // After the path checks, so a search inside a key folder says so first.
  if (tool === 'Grep') {
    const why = grepContentRefusal(input, mine);
    if (why) return why;
  }
  // A search (Grep or Glob) with no path runs over the working folder: while floorboss runs, not when that is the
  // home folder or a folder above it.
  if (searches && mine && !pathsOf(tool, input).length && inside(homedir(), process.cwd()))
    return `a search with no folder named runs over the home folder here, which holds keys and credentials, and a floorboss run is under way: name a project folder.${lockNote(run)}`;
  return null;
}

// Claude Code's own web tools (WebFetch, WebSearch) during a floorboss run: a link or a search query can carry
// what Claude read out of the session (an attendee list, a CRM export), so while a run is under way neither
// takes a long or multi-line address or query, and WebFetch opens only the sites floorboss has a reason to
// (hostAllowed: LinkedIn profiles, the event apps it knows, CRM web apps and the event sites the user named).
// The attendee-researcher agent reads the open web for its briefs: it has no file tools, so it holds only the
// brief it was given, and it keeps any host within the same length limit. Outside a run both are let through.
export const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
// The tools the main PreToolUse hooks check, and the ones that only plan, ask or keep a list (the catch-all leaves
// both alone).
export const CHECKED_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Monitor',
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch'
]);
export const QUIET_TOOLS = new Set([
  'TodoWrite',
  'TodoRead',
  'AskUserQuestion',
  'ToolSearch',
  'ExitPlanMode',
  'EnterPlanMode',
  'LS',
  'NotebookRead',
  'BashOutput',
  'KillShell',
  'KillBash',
  'TaskOutput',
  'TaskStop'
]);
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

// Whether a session's transcript (Claude Code's own file, under ~/.claude/projects) shows a floorboss script run:
// read up to its first and last 8 MB.
export function transcriptRanFloorboss(path) {
  try {
    const p = String(path || '');
    if (!/\.jsonl$/.test(p) || !existsSync(p)) return false;
    const size = statSync(p).size;
    const fd = openSync(p, 'r');
    try {
      const part = (start, len) => {
        const b = Buffer.alloc(len);
        readSync(fd, b, 0, len, start);
        return b.toString('utf8');
      };
      const cap = 8 * 1024 * 1024;
      const text = size <= 2 * cap ? part(0, size) : part(0, cap) + part(size - cap, cap);
      return SCRIPT_CALL.test(text);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// A session whose transcript holds a floorboss run it didn't stamp itself: a fork (a new id, with the history
// copied in after the session starts). Read on each call, only the part written since the last read (kept in
// transcript-scan.json), so a long session costs nothing new. True when the run's limits now apply.
export function inheritedRun(session, path) {
  try {
    const p = String(path || '');
    if (!session || !/\.jsonl$/.test(p) || !existsSync(p)) return false;
    const statePath = join(home(), 'transcript-scan.json');
    const state = readJsonStrict(statePath, {}) || {};
    // Found once: the run's limits hold (the lock is stamped before this is written, so a guard reading it can rely on it).
    if (state[session]?.path === p && state[session].found) {
      stampRun({ session, transcript: p });
      return true;
    }
    const prev = state[session]?.path === p ? Number(state[session].offset) || 0 : 0;
    const size = statSync(p).size;
    if (size <= prev) return false;
    // The whole new part is read before this call is judged (in 32 MB windows that overlap a little), within a few
    // seconds: a call is never judged on half a transcript. One too big to read in time, while a run is live
    // anywhere, counts as having run floorboss (the limits hold rather than not).
    const t0 = Date.now();
    let start = Math.max(0, prev - 400);
    let found = false;
    const fd = openSync(p, 'r');
    try {
      while (start < size && !found && Date.now() - t0 < 4000) {
        const len = Math.min(size - start, 32 * 1024 * 1024);
        const b = Buffer.alloc(len);
        readSync(fd, b, 0, len, start);
        found = SCRIPT_CALL.test(b.toString('utf8'));
        start = start + len >= size ? size : start + len - 400;
      }
    } finally {
      closeSync(fd);
    }
    if (!found && start < size && readRunAnySession(Date.now()).active) found = true;
    const nowMs = Date.now();
    const kept = Object.fromEntries(Object.entries(state).filter(([, v]) => v && nowMs - Date.parse(v.at) < 14 * 864e5));
    // Stamped first, then recorded: two guards run for one call (the catch-all and the tool's own), and the one
    // that reads the record after the other wrote it must find the lock already there.
    if (found) stampRun({ session, transcript: p });
    kept[session] = { path: p, offset: start, at: new Date(nowMs).toISOString(), ...(found ? { found: true } : {}) };
    writeText(statePath, JSON.stringify(kept));
    return found;
  } catch {
    return false;
  }
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

// A Bash call that runs one of floorboss's own scripts: the run lock is tied to this session from now on.
const SCRIPT_CALL =
  /(skills\/(flow|event-context|slot-finder|crm-triage|event-outreach|connectors|attendee-research)\/scripts\/cli\.mjs|examples\/mock-event\/load\.mjs)(?:["']?\s+([a-z][\w-]*))?/;
export function floorbossScriptCall(command) {
  // The script is the word after node, read as the shell reads it (bashRefusal holds a script call to that form),
  // so quotes in its path, or a script's name further along the command, can't make it look like another one.
  const words = shellWords(command);
  // The plain text must name a script too: that is what holds the command to bashRefusal's rules, so a name split
  // by quotes ("con""nectors") is no script call, and in a held session is refused as any other command.
  const m = words[0] === 'node' && SCRIPT_CALL.test(String(command || '')) ? SCRIPT_CALL.exec(words[1] ?? '') : null;
  return m ? { sub: words[2] ?? null, skill: m[2] || null } : null;
}
// A command's words exactly as the shell reads them: "save-recipe" and sa''ve-recipe are both save-recipe, and a
// backslash in double quotes stands only before $ ` " \ or a line break (which it removes).
function shellWords(command) {
  const words = [];
  let word = null,
    q = null;
  const cmd = String(command || '');
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else word += ch;
    } else if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && cmd[i + 1] === '\n') i++;
      else if (ch === '\\' && '$`"\\'.includes(cmd[i + 1] ?? ' ')) word += cmd[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === '\\') {
      if (cmd[i + 1] === '\n') i++;
      else word = (word ?? '') + (cmd[++i] ?? '');
    } else word = (word ?? '') + ch;
  }
  if (word !== null) words.push(word);
  return words;
}

// Saving or forgetting a connection in the session that ran floorboss. Setup does this mid-run, so it can't simply
// be refused; but a saved read recipe makes its server "given" and lifts the run's limits on what its calls carry,
// and the files behind it are ones the session writes. A subagent never does it. A connection on a server setup
// didn't find, or one that moves a saved connection to another server, is the user's to allow. The guard notes
// the whole command and the recipe it looked at, for any session, once it has decided, and the script runs only that.
function connectorChange(command, sub, { held, subagent, config }) {
  const words = shellWords(command);
  const flag = (k) => {
    const i = words.lastIndexOf(k);
    return i >= 0 ? words[i + 1] : undefined;
  };
  const task = String(flag('--task') ?? '');
  const note = (server, tool) => writeText(join(home(), 'recipe-seen.json'), JSON.stringify({ argv: words.slice(2), server, tool, at: new Date().toISOString() }));
  if (held && subagent) return { refuse: "a subagent doesn't change floorboss's connections." };
  if (held && !task) return { refuse: 'this names no connection: pass --task with the task itself.' };
  const saved = config?.connectors?.[task];
  if (sub === 'forget') {
    note();
    return held ? { ask: `floorboss: forget your ${promptLine(task)} connection${saved?.server ? ` (${promptLine(saved.server)}/${promptLine(saved.tool)})` : ''}?\n\nAllow only if you asked for this.` } : {};
  }
  let recipe;
  try {
    recipe = JSON.parse(readChecked(allowedPath(flag('--recipe-file'))));
  } catch {
    return held ? { refuse: "its guard couldn't read that recipe file, so it can't check which connection this saves." } : {};
  }
  if (typeof recipe?.server !== 'string' || typeof recipe?.tool !== 'string') {
    if (held) return { refuse: "that recipe's server and tool aren't plain names." };
    note();
    return {};
  }
  const { server, tool } = recipe;
  if (!held) {
    note(server, tool);
    return {};
  }
  const moved = saved?.server && !sameServer(saved.server, server);
  const named = /^mcp__(.+?)__/.exec(tool);
  const silent = foundServer(server) && !moved && !bareToolName(tool).includes('__') && (!named || sameServer(named[1], server));
  note(server, tool);
  if (silent) return {};
  return {
    ask: `floorboss: connect ${promptLine(task)} to ${promptLine(server)}/${promptLine(tool)}?${moved ? ` This replaces ${promptLine(saved.server)}/${promptLine(saved.tool)}.` : " Setup didn't find this as a connector of that name."} Once saved, floorboss's run can call it with what the session has read.\n\nAllow only if you're setting this connection up.`
  };
}

// In the session that ran floorboss, a pending test passes only on the server it is a test of: the CRM for a task
// or a contact, a mailbox or chat tool floorboss knows for the others. Otherwise it would take a call on any
// connected server past the run's limits, under a prompt that names it a test.
function testOnItsServer(pending, config) {
  const inv = readJsonStrict(join(home(), 'inventory.json'), {});
  const server = String(pending?.server ?? '');
  // An inventory from before setup_servers existed counts what it had found, as foundServer does.
  const atSetup = !Array.isArray(inv?.setup_servers) || inv.setup_servers.some((x) => sameServer(String(x), server));
  const foundAs = (kind) => atSetup && (inv?.found?.[kind] || []).some((x) => String(x).startsWith('mcp:') && sameServer(String(x).slice(4), server));
  const saved = (...tasks) => tasks.some((t) => config.connectors?.[t]?.server && sameServer(config.connectors[t].server, server));
  if (['crm.create_task', 'crm.create_contact'].includes(pending?.task)) return config.connectors?.['crm.lookup']?.server ? saved('crm.lookup') : foundAs('crm');
  if (['stage_draft', 'email.send'].includes(pending?.task)) return foundAs('email') || saved('stage_draft', 'email.send', 'email.history', 'email.messages', 'email.thread_has_reply');
  if (pending?.task === 'chat.send') return foundAs('chat') || saved('chat.send');
  return false;
}

// A Bash call that runs one of floorboss's scripts is held to an allowlist: outside quotes only letters,
// digits, spaces and _ . / : = @ % + , -, and plain '…' or "…" quoting. Inside double quotes no "$" or
// backtick; inside single quotes anything. The one variable allowed is ${CLAUDE_PLUGIN_ROOT}, as the commands
// write it. The commands pre-approve floorboss's scripts by their prefix, and Claude Code's docs don't say how
// a substitution inside an approved prefix is treated: "cli.mjs next --event $(cat ~/.ssh/id_rsa)" could run
// unasked. A list of what to refuse always missed one (bash's $'…' quoting, zsh's =(…) and glob qualifiers),
// so everything the shell could work out is refused, said plainly for the common ones. Every other Bash
// command is left alone.
const PLUGIN_SCRIPT = new RegExp(
  `(${resolve(process.env.CLAUDE_PLUGIN_ROOT || new URL('..', import.meta.url).pathname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|\\$\\{?CLAUDE_PLUGIN_ROOT\\}?)[^\\s'"]*/scripts/[\\w.-]+\\.mjs`
);
const PLAIN_CHAR = /[A-Za-z0-9_./:=@%+,-]/;
const ROOT_VAR = /^\$(?:\{CLAUDE_PLUGIN_ROOT\}|CLAUDE_PLUGIN_ROOT(?![\w]))/;
export function bashRefusal(command) {
  const cmd = String(command || '');
  // A node command that names the plugin folder at all is held to the same rules, so a path spelled another way
  // ("scripts/./cli.mjs") is not let past as a command that isn't floorboss's.
  const namesPlugin = /^node\s/.test(cmd.trimStart()) && (cmd.includes('CLAUDE_PLUGIN_ROOT') || cmd.includes(PLUGIN_ROOT));
  if (!PLUGIN_SCRIPT.test(cmd) && !SCRIPT_CALL.test(cmd) && !namesPlugin) return null;
  const subst = (what) =>
    `this runs a floorboss script with ${what} in the command. floorboss's commands take values from files instead: write the value to a file and pass it with --value-file (or the command's own --file flag).`;
  const joined = (op) =>
    `this runs a floorboss script with ${op} after it, which starts another command. Run floorboss's script as a command of its own, with nothing before or after it.`;
  const plain = (what) =>
    `this runs a floorboss script with ${what}, which the shell could read as more than a plain value. Pass floorboss's scripts plain words, or put a value in single quotes; anything longer goes in a file, passed with --value-file (or the command's own --file flag).`;
  // The command starts with node itself: a setting before it (NODE_OPTIONS=…, PATH=…) or a wrapper
  // (env, exec, nice) could load other code into the script or run a different node.
  if (!/^node\s/.test(cmd.trimStart()))
    return `this runs a floorboss script with something before "node" (a setting like NODE_OPTIONS=, or another command). Run floorboss's script as "node" followed by the script, with nothing before it.`;
  // zsh expands =name to a command's path, and an empty pair of quotes before it doesn't stop that.
  if (/(^|\s)(''|"")+=/.test(cmd)) return plain('an equals sign after empty quotes');
  let q = null,
    wordStart = true;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i],
      next = cmd[i + 1];
    if (q === "'") {
      if (ch === "'") q = null;
      continue;
    }
    if (ch === '$') {
      // Only as the start of the script's own path: anywhere else the guard would read a different command from
      // the one the shell runs.
      const m = /^\s*node\s+["']?$/.test(cmd.slice(0, i)) ? ROOT_VAR.exec(cmd.slice(i)) : null;
      if (m) {
        i += m[0].length - 1;
        wordStart = false;
        continue;
      }
      if (next === '(') return subst('"$(…)" (command substitution)');
      return subst(next === "'" ? `"$'…'" (quoting the shell decodes)` : `"$" (a variable the shell fills in)`);
    }
    if (ch === '`') return subst('a backtick (command substitution)');
    if (q === '"') {
      if (ch === '"') q = null;
      // An escaped character inside double quotes is that character ("\$" is a dollar sign, not a variable).
      else if (ch === '\\') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      wordStart = false;
      continue;
    }
    if (ch === ' ') {
      wordStart = true;
      continue;
    }
    if ((ch === '<' || ch === '>') && next === '(') return subst(`"${ch}(…)" (process substitution)`);
    if (ch === '>') return subst(`an output redirect ("${cmd[i - 1] === '2' ? '2' : ''}>${next === '>' ? '>' : ''}")`);
    // A second command after the script (";", "&&", "||", "|", "&" or a new line, outside quotes): the
    // guard doesn't rely on Claude Code's own handling of operators after an approved prefix.
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r')
      return joined(ch === '\n' || ch === '\r' ? 'a new line' : `"${ch}${next === ch && ch !== ';' ? ch : ''}"`);
    if (ch === '<') return plain('an input redirect ("<") outside quotes');
    // zsh reads a word that starts with "=" as a command's path ("=(…)" runs a command into a temp file).
    if (ch === '=' && wordStart) return plain('a word starting with "=" outside quotes');
    if (PLAIN_CHAR.test(ch)) {
      wordStart = false;
      continue;
    }
    return plain(ch === '\\' ? 'a backslash outside quotes' : ch === '\t' ? 'a tab outside quotes' : `"${ch}" outside quotes`);
  }
  if (q) return plain(`a ${q === '"' ? 'double' : 'single'} quote that is never closed`);
  return scriptWordRefusal(cmd);
}

// The first word after "node" is floorboss's own script, and nothing else: no node option before it (--import,
// -r, -e, --env-file, --inspect load or run other code), no other script with floorboss's path as its argument,
// and no "." or ".." segment in it ("cli.mjs/../../x.mjs" is resolved by its text and ran another file). It names a
// script under the plugin root, by its text and by its real path.
const SCRIPT_REL = /^(?:skills\/[a-z][a-z-]*\/scripts\/[\w-]+\.mjs|examples\/mock-event\/load\.mjs)$/;
function scriptWordRefusal(cmd) {
  const rest = cmd.trimStart().slice(4).replace(/^ +/, '');
  // The word, as the shell reads it (the loop above allowed only plain characters and plain quotes).
  let word = '',
    i = 0,
    q = null;
  for (; i < rest.length; i++) {
    const ch = rest[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else word += ch;
      continue;
    }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\') word += rest[++i] ?? '';
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (ch === ' ') break;
    word += ch;
  }
  const bad = `this runs node with something other than floorboss's own script as its first word ("${word.slice(0, 80)}"). Run "node" followed directly by the script under the plugin folder, with no node option before it and no "." or ".." in its path.`;
  if (!word || word.startsWith('-')) return bad;
  // A $ the shell won't expand (single quotes, \$) is a folder of that name, not the plugin.
  const m = /^"?\$/.test(rest) ? ROOT_VAR.exec(word) : null;
  const given = m ? PLUGIN_ROOT + word.slice(m[0].length) : word;
  if (given.includes('$') || given.split('/').some((x) => x === '..' || x === '.')) return bad;
  // A relative path names the script in the folder the command runs in: it counts only if that is the plugin's.
  const path = (given.startsWith('/') ? given : `${process.cwd()}/${given}`).replace(/\/{2,}/g, '/');
  if (!path.startsWith(PLUGIN_ROOT + '/') || !SCRIPT_REL.test(path.slice(PLUGIN_ROOT.length + 1))) return bad;
  const rp = realPath(path),
    rr = realPath(PLUGIN_ROOT);
  if (!rp.startsWith(rr + sep)) return bad;
  return null;
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

// A stage batch: the stage-list.json floorboss wrote, by its bytes.
const stageBatch = (evDir) =>
  createHash('sha256')
    .update(readFileSync(join(evDir, 'stage-list.json')))
    .digest('hex')
    .slice(0, 24);

// PostToolUse: the call ran, so the user said yes to any prompt it had (a call declined at the prompt never
// runs and never gets here). Only now is the ask recorded: a lookup counted against its window, and a staged
// draft's batch confirmed so the rest of it goes without asking. The PreToolUse check never reads a file it
// wrote itself: it reads only what this writes. Returns what it recorded.
export function afterCall(input, nowMs = clockNow()) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(input?.tool_name || ''));
  if (!m) return {};
  const config = readJsonStrict(join(home(), 'config.json'), {});
  const out = {};
  // A browser window's first call ran after the user allowed it: the window is allowed until it closes.
  const wp = join(home(), 'window-pending.json');
  const wpend = readJsonStrict(wp, null);
  if (wpend && isBrowser(m[1], m[2])) {
    const bs = openWindow(nowMs);
    const cl = bs ? null : openLogWindow(nowMs);
    const now = bs ? windowKey('send', bs) : cl ? windowKey('log', cl) : null;
    if (now && wpend.key === now && recent(wpend.at, nowMs, 10 * 60000) && sameCall(wpend, input)) {
      writeText(join(home(), 'window-asked.json'), JSON.stringify({ key: now, at: new Date(nowMs).toISOString() }));
      out.window_allowed = now;
    }
    try {
      unlinkSync(wp);
    } catch {
      /* gone */
    }
  }
  const r = config.connectors?.['enrich.person'];
  if (r && ((bareToolName(r.tool) === m[2] && (!r.server || sameServer(m[1], r.server))) || enrichServerTool(config, m[1], m[2]))) {
    const p = join(home(), 'enrich-window.json');
    const w = readJsonStrict(p, null);
    // One pre hook, at most one post: each post uses its own call's note (by tool_use_id; without one, the
    // oldest note with no id), and the note goes. A post run again, or one for a call an old window let through,
    // counts nothing. Under the lock, so posts at once each add their one.
    const count = () => {
      const now = readJsonStrict(p, null);
      if (!now || now.closed || now.until !== w.until) return;
      const id = String(input?.tool_use_id || '');
      const notes = enrichNotes(now.until, nowMs);
      const note = id ? notes.find((x) => x.file === join(enrichPendingDir(), callNote(id))) : notes.find((x) => !x.call);
      if (!note) return;
      // Claimed by renaming it (only one post can), counted, then removed; if the count can't be written, the note
      // goes back for the retry.
      const claimed = `${note.file}.counting`;
      try {
        renameSync(note.file, claimed);
      } catch {
        return;
      }
      try {
        writeText(p, JSON.stringify({ ...now, used: windowUsed(now) + 1 }));
      } catch (e) {
        renameSync(claimed, note.file);
        throw e;
      }
      unlinkSync(claimed);
      out.counted = true;
    };
    // A lookup that ran is counted even when the lock can't be had twice over (a stuck hook holding it): counted
    // without the lock, two posts at once could still make one count, but none is dropped outright.
    if (w && !w.closed)
      try {
        withLock('enrich', count);
      } catch {
        try {
          withLock('enrich', count);
        } catch {
          count();
        }
      }
  }
  // A CRM task the guard let through and that ran: marked, so a receipt for it (tasks-created) is one floorboss can
  // trust. A receipt for a task with no mark (declined, never made) is refused.
  // The task is the one the pre hook matched for this call (its note, by tool_use_id, up to a day old); without an
  // id, the listed task the call matches now.
  if (config.connectors?.['crm.create_task']) {
    let made = null;
    const id = String(input?.tool_use_id || '');
    // Notes over a day old (a task declined at its prompt) go.
    try {
      for (const f of readdirSync(join(home(), 'task-pending')).filter((f) => /^[0-9a-f]{32}$/.test(f)))
        try {
          if (!recent(JSON.parse(readFileSync(join(home(), 'task-pending', f), 'utf8')).at, nowMs, 864e5)) unlinkSync(join(home(), 'task-pending', f));
        } catch {
          try {
            unlinkSync(join(home(), 'task-pending', f));
          } catch {
            /* gone */
          }
        }
    } catch {
      /* none */
    }
    if (id) {
      const np = join(home(), 'task-pending', callNote(id));
      const note = readJsonStrict(np, null);
      if (note?.key && /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(note.event || '')) && recent(note.at, nowMs, 864e5))
        made = { key: note.key, _event: note.event };
      try {
        unlinkSync(np);
      } catch {
        /* none */
      }
    } else {
      const madeTasks = [];
      if (!check(input, { config, taskItems: listed('task-list.json'), tasks: madeTasks }) && madeTasks[0]?.key && madeTasks[0]._event) made = madeTasks[0];
    }
    if (made) {
      const rdir = join(home(), 'events', made._event, 'released');
      mkdirSync(rdir, { recursive: true, mode: 0o700 });
      try {
        markOnce(join(rdir, `task-${taskMark(made.key)}`), nowMs);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      out.task_made = made.key;
    }
  }
  const staged = [];
  if (config.connectors?.stage_draft && !check(input, { config, stageItems: listed('stage-list.json', nowMs), staged }) && staged[0]) {
    const evDir = join(home(), 'events', staged[0]._event);
    const batch = stageBatch(evDir);
    const sp = join(evDir, 'stage-pending.json');
    const pending = readJsonStrict(sp, null);
    // The batch the prompt was about, still the list floorboss wrote: a list replaced since is a new batch.
    // As with a lookup, the note is used once and only while it is under 10 minutes old.
    if (pending?.batch === batch && recent(pending.at, nowMs, 10 * 60000) && sameCall(pending, input)) {
      writeText(join(evDir, 'stage-asked.json'), JSON.stringify({ batch, first: pending.first, at: new Date(nowMs).toISOString() }));
      out.stage_confirmed = batch;
    }
    // A draft of a confirmed batch went in: it counts as that message's one for the batch.
    const asked = readJsonStrict(join(evDir, 'stage-asked.json'), null);
    if (asked?.batch === batch) {
      const it = staged[0];
      const rdir = join(evDir, 'released');
      mkdirSync(rdir, { recursive: true, mode: 0o700 });
      try {
        markOnce(join(rdir, `stage-${it.id}-${it.touch ?? 1}-${batch}`), nowMs);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    if (pending)
      try {
        unlinkSync(sp);
      } catch {
        /* gone */
      }
  }
  return out;
}

// A hook input from inside a subagent: an agent_id that is there and not blank, of any type.
export const isSubagent = (input) => input?.agent_id != null && !!String(input.agent_id).trim();

// Well inside the hook timeout in hooks.json (30 seconds), so a slow async check ends blocked rather than timed out.
// Synchronous work that hangs can't reach this timer; that case relies on onFailure: "block" in hooks.json
// (Claude Code 2.1.295 or later; older versions let a timed-out call through).
export const GUARD_DEADLINE_MS = 20000;
const squash = (x) =>
  String(x ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
// Keys pressed in a browser window: plain keys, and Enter with a modifier (a send shortcut). No paste or other
// shortcut: a paste would put the clipboard in the page, whatever it holds.
const KEY_OK =
  /^((cmd|ctrl|control|meta|command)\+)?(enter|return)$|^(enter|return|tab|escape|esc|backspace|delete|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|space)$/i;

if (isMain(import.meta.url)) {
  // A check that hangs while waiting blocks the call before Claude Code's own hook timeout (hooks.json) would.
  setTimeout(() => {
    process.stderr.write(
      'floorboss blocked this call: its guard took too long to check it. Try again; if it keeps happening, this is for you, the user, to look at.\n'
    );
    process.exit(2);
  }, GUARD_DEADLINE_MS).unref();
  let raw = '';
  process.stdin.on('data', (d) => {
    raw += d;
  });
  process.stdin.on('end', () => {
    let input = {};
    // A call it can't read is a call it can't check: blocked (after a call has run, nothing is blocked).
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      if (process.argv[2] === 'post') process.exit(0);
      process.stderr.write("floorboss blocked this call: its guard couldn't read it. This is for you, the user, to look at.\n");
      process.exit(2);
    }
    const toolName = String(input?.tool_name || '');
    const session = typeof input?.session_id === 'string' ? input.session_id : null;
    // Inside a subagent (agent_id set), held to any live run lock: the docs don't say its session_id is the parent's.
    // Any agent_id that isn't empty counts, whatever its type (a number or an object is not the main session).
    const subagent = isSubagent(input);
    // PostToolUse ("post"): records what a call that ran had asked about; never blocks anything.
    if (process.argv[2] === 'post' || input?.hook_event_name === 'PostToolUse') {
      // A web search while floorboss runs (the researcher's, usually): the hosts it turned up are the ones the
      // researcher may then open.
      if (toolName === 'WebSearch') {
        try {
          if (readRunAnySession(Date.now()).active)
            recordSearchHosts(input.tool_response ?? input.tool_output, Date.now(), String(input.tool_input?.query ?? ''));
        } catch {
          /* not recorded: those pages stay closed */
        }
        process.exit(0);
      }
      try {
        if (!subagent) afterCall(input);
      } catch {
        /* not recorded: the next call asks again */
      }
      process.exit(0);
    }
    // A forked session carries a run it never stamped: found in its transcript before its first call is judged.
    if (process.argv[2] !== 'start' && input?.hook_event_name !== 'SessionEnd' && !subagent && session && !readRun(Date.now(), session).session)
      inheritedRun(session, input.transcript_path);
    // SessionStart: a session resumed (or compacted) that ran floorboss before still holds that run's text in its
    // transcript, so the run's limits come back with it.
    if (input?.hook_event_name === 'SessionStart') {
      try {
        // Resumed, compacted or forked (a fork has a new id): known by its id or transcript, or by a floorboss script
        // call in the transcript it carries over.
        if (
          ['resume', 'compact', 'fork'].includes(String(input.source || '')) &&
          (ranBefore([session, input.transcript_path]) || transcriptRanFloorboss(input.transcript_path))
        )
          stampRun({ session, transcript: input.transcript_path });
      } catch {
        /* best effort */
      }
      process.exit(0);
    }
    // The catch-all hook ("other"): the tools the two hooks above already check are left to them; any other tool
    // in the session that ran floorboss (or a subagent while a run is live) is refused unless it's one that only
    // plans, asks or keeps a to-do list. A new tool (publishing a page, a scheduled or remote agent, a message to
    // another session) can't carry the run's text out before floorboss knows what it does.
    if (process.argv[2] === 'other') {
      if (/^mcp__/.test(toolName) || CHECKED_TOOLS.has(toolName)) process.exit(0);
      const otherRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
      if (!(otherRun.active && (otherRun.session || subagent))) process.exit(0);
      if (QUIET_TOOLS.has(toolName)) process.exit(0);
      if (toolName === 'Skill' && /^floorboss:/.test(String(input.tool_input?.skill ?? input.tool_input?.name ?? ''))) process.exit(0);
      process.stderr.write(
        `floorboss blocked this call: this session ran floorboss and read text from your lists, CRM and the web, so ${toolName || 'this tool'} waits until the session ends (floorboss can't check what it sends). Start a new session (or /clear) to use it.\n`
      );
      process.exit(2);
    }
    // SessionEnd: a session that ran floorboss is over, and with it the run's text.
    if (input?.hook_event_name === 'SessionEnd') {
      try {
        endSession(session);
      } catch {
        /* nothing to end */
      }
      process.exit(0);
    }
    // The run lock is stamped in real time (lib/runlock.mjs), so every read of it below uses the real clock, not
    // floorboss's movable one.
    // A subagent started in the session that ran floorboss (or while a run is live) reads what that session
    // read: only floorboss's own agents, and the drafter the user chose, may be started then.
    if (toolName === 'Agent' || toolName === 'Task') {
      const agentRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
      if (agentRun.active && (agentRun.session || subagent)) {
        const type = String(input.tool_input?.subagent_type || '');
        // The drafter counts only as an agent the scan found reading at most (the same rule its setting is
        // saved under): a skill, an "instructions" file or an agent that could send or write starts nothing here.
        let drafter = null;
        try {
          const d = readJsonStrict(join(home(), 'config.json'), {})?.drafter;
          const inv = readJsonStrict(join(home(), 'inventory.json'), {});
          const seen = (inv?.items || []).find((x) => x.type === 'agent' && x.name === d?.invoke);
          drafter = d?.type === 'agent' && seen && ['none', 'reads'].includes(seen.tools_risk) ? d.invoke : null;
        } catch {
          drafter = null;
        }
        // An agent run elsewhere (a cloud environment) is out of this machine's guard: its web and tool limits
        // would not hold there. Only an agent run here (or in a local worktree) starts.
        const isolation = input.tool_input?.isolation;
        if (isolation != null && isolation !== '' && isolation !== 'worktree') {
          process.stderr.write(
            `floorboss blocked this call: while floorboss runs, agents run on this machine, where its checks hold, not with isolation "${String(isolation).slice(0, 20)}".\n`
          );
          process.exit(2);
        }
        // The researcher is the one agent with the open web: its brief is floorboss's own (a company, the people's
        // names and titles), never an email address or a pasted export.
        if (type === 'floorboss:attendee-researcher') {
          const brief = String(input.tool_input?.prompt ?? '');
          if (brief.length > 8000 || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(brief)) {
            process.stderr.write(
              "floorboss blocked this call: the researcher's brief is floorboss's own input for the step (a company, people's names and titles), never an email address or more than a few thousand characters, since the researcher reads and fetches on the open web.\n"
            );
            process.exit(2);
          }
        }
        if (!(type.startsWith('floorboss:') || (drafter && type === drafter))) {
          process.stderr.write(
            `floorboss blocked this call: this session ran floorboss, so the only agents it starts are floorboss's own and the drafter you chose${drafter ? ` (${drafter})` : ''}, not "${type || 'a general agent'}". Start a new session (or /clear) for other agents.\n`
          );
          process.exit(2);
        }
      }
      process.exit(0);
    }
    // Other tools that run shell commands (PowerShell on Windows, a background Monitor): none runs a floorboss
    // script, so in the session that ran floorboss (or a subagent while a run is live) they're refused like any
    // other shell command; elsewhere they're left to Claude Code's own prompt.
    if (toolName === 'PowerShell' || toolName === 'Monitor') {
      const shellRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
      if (shellRun.active && (shellRun.session || subagent)) {
        process.stderr.write(
          `floorboss blocked this call: this session ran floorboss and read text from your lists, CRM and the web, so it can't run ${toolName} commands until the session ends. Start a new session (or /clear) for other commands.\n`
        );
        process.exit(2);
      }
      process.exit(0);
    }
    // Bash: a floorboss script with anything but plain words and quotes is refused (bashRefusal). In the session
    // that ran floorboss, or a subagent while a run is live, so is any command that isn't a floorboss script call
    // (floorbossScriptCall: a skill's cli.mjs, or the mock event's load.mjs). A script call other than run-end or
    // record, from a hook input with a session id, ties the run lock to this session.
    if (toolName === 'Bash') {
      let why = null;
      try {
        why = bashRefusal(input.tool_input?.command);
      } catch (e) {
        why = `its guard couldn't check this command (${String(e.message).slice(0, 80)}).`;
      }
      if (why) {
        process.stderr.write(`floorboss blocked this call: ${why}\n`);
        process.exit(2);
      }
      let call = null;
      try {
        call = floorbossScriptCall(input.tool_input?.command);
      } catch {
        call = null;
      }
      // The session that ran floorboss (and any subagent while a run is live) has read text from lists, CRM
      // notes, pages and replies: there, a shell command other than floorboss's own scripts could send that text
      // anywhere, or rewrite floorboss's records. Refused until the session ends (/clear or a new session).
      if (!call) {
        const bashRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        if (bashRun.active && (bashRun.session || subagent)) {
          process.stderr.write(
            "floorboss blocked this call: this session ran floorboss and read text from your lists, CRM and the web, so its shell commands are limited to floorboss's own scripts until the session ends. Start a new session (or /clear) for other commands.\n"
          );
          process.exit(2);
        }
      }
      if (call?.skill === 'connectors' && ['save-recipe', 'forget'].includes(call.sub)) {
        // A throw here is a refusal: only exit 2 stops the call.
        let change;
        try {
          const connRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
          const held = !!(connRun.active && (connRun.session || subagent));
          change = connectorChange(input.tool_input?.command, call.sub, { held, subagent, config: readJsonStrict(join(home(), 'config.json'), {}) });
        } catch (e) {
          change = { refuse: `its guard couldn't check this connection change (${String(e?.message).slice(0, 80)}).` };
        }
        if (change.refuse) {
          process.stderr.write(`floorboss blocked this call: ${change.refuse}\n`);
          process.exit(2);
        }
        if (change.ask) ask(change.ask);
      }
      try {
        if (call && session && !['run-end', 'record'].includes(call.sub)) stampRun({ session, transcript: input.transcript_path });
      } catch {
        /* best effort */
      }
      allow();
    }
    try {
      if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
        const fileRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        const why = fileRefusal(toolName, input.tool_input, fileRun);
        if (why) {
          process.stderr.write(`floorboss blocked this call: ${why}\n`);
          process.exit(2);
        }
        // The session that ran floorboss is still at work: its limits hold SESSION_LOCK_HOURS from now.
        if (fileRun.session) touchSession(session);
        process.exit(0);
      }
      if (WEB_TOOLS.has(toolName)) {
        const webRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        const why = webRun.active
          ? webRefusal(
              toolName,
              input.tool_input,
              webRun,
              knownEventSites().hosts,
              subagent && isResearcher(input) ? { researcher: true, seen: seenHosts(), companies: companyHosts() } : {}
            )
          : null;
        if (why) {
          process.stderr.write(`floorboss blocked this call: ${why}\n`);
          process.exit(2);
        }
        process.exit(0);
      }
      if (!/^mcp__/.test(toolName)) process.exit(0);
      const nowMs = clockNow();
      const run = subagent ? { ...readRunAnySession(Date.now()), subagent: true } : readRun(Date.now(), session);
      const config = readJsonStrict(join(home(), 'config.json'), {});
      const server = /^mcp__(.+?)__/.exec(input.tool_name)[1];
      const toolPart = String(input.tool_name).replace(/^mcp__.+?__/, '');
      const browserCall = isBrowser(server, toolPart);
      const pendingPath = join(home(), 'test-pending.json');
      if (!subagent && existsSync(pendingPath)) {
        const pending = readJsonStrict(pendingPath, null);
        const offServer = !!(run.active && run.session && pending && !testOnItsServer(pending, config));
        // The first new contact passes only while that person is still on the list to add, as listed: once their
        // record is saved they're off it, so a test pass left over from setup can't create them again.
        const firstContact = pending?.task === 'crm.create_contact' ? testContactItem(input.tool_input, pending, listed('contact-list.json'), nowMs) : null;
        if (!offServer && testPasses(input, pending, nowMs) && (pending.task !== 'crm.create_contact' || firstContact)) {
          unlinkSync(pendingPath);
          // The first new contact is a listed person: marked let through, as every later one is, so a lost answer
          // never leads to creating them twice.
          if (pending.task === 'crm.create_contact')
            for (const x of listed('contact-list.json').filter((x) => fold(x.email) === fold(pending.to))) {
              const mdir = join(home(), 'events', x._event, 'released');
              mkdirSync(mdir, { recursive: true, mode: 0o700 });
              try {
                markOnce(join(mdir, `crm-${promptId(x.id)}`), nowMs);
              } catch (e) {
                if (e.code !== 'EEXIST') throw e;
                process.stderr.write(
                  `floorboss blocked this call: ${promptPerson(x.name, x.id, x.email)} was already let through to your CRM once: run flow next, which looks them up first.\n`
                );
                process.exit(2);
              }
            }
          // A test call is a real write, and the file that allows it is one a session can write: the user is
          // asked every time, and the prompt shows what goes where.
          const args = leaves(input.tool_input || {})
            .map(([p, v]) => `${p}: ${String(v ?? '').slice(0, 300)}`)
            .join('\n')
            .slice(0, 1500);
          const what =
            {
              'email.send': 'TEST email',
              'chat.send': 'TEST chat message',
              stage_draft: 'TEST draft in your mailbox',
              'crm.create_task': 'TEST task in your CRM',
              'crm.create_contact': 'first new contact in your CRM'
            }[pending.task] || `TEST ${pending.task}`;
          ask(
            pending.task === 'crm.create_contact'
              ? `floorboss: the ${what}, for ${promptAddr(pending.to)}, via ${pending.server}/${pending.tool}, with:\n${args}\n\nAllow only if this is a person you agreed to add to your CRM.`
              : `floorboss: a ${what}${pending.to ? ` to ${pending.to}` : ''} via ${pending.server}/${pending.tool}, with:\n${args}\n\nAllow only if ${pending.to ? 'that is your own address or number and ' : ''}this is the test you agreed to.`
          );
          allow();
        }
      }
      // A subagent never gets a send, a task, a staged draft, a test call or a window (browser send, CRM log,
      // lookups): the user approves those in the main conversation, never inside an Agent call.
      const sendItems = subagent ? [] : listedSends();
      const browserSend = subagent ? null : openWindow(nowMs);
      const crmLog = browserSend || subagent ? null : openLogWindow(nowMs);
      const { hosts, pages } = knownEventSites();
      const asks = [];
      const sent = [];
      const enrichPath = join(home(), 'enrich-window.json');
      const enrichWindow = !subagent && existsSync(enrichPath) ? readJsonStrict(enrichPath, null) : null;
      const enrichUsed = [];
      const tasks = [],
        contacts = [],
        staged = [];
      const why0 = check(input, {
        config,
        stageItems: subagent ? [] : listed('stage-list.json', nowMs),
        taskItems: subagent ? [] : listed('task-list.json'),
        contactItems: subagent ? [] : listed('contact-list.json'),
        sendItems,
        active: run,
        browserSend,
        crmLog,
        sent,
        enrichWindow,
        enrichUsed,
        hosts,
        pages,
        asks,
        tasks,
        contacts,
        staged
      });
      const why =
        why0 && subagent
          ? `${why0} (This call comes from a subagent: floorboss lets sends, tasks, drafts, lookups and browser windows happen only in the main conversation, where you approve them.)`
          : why0;
      if (why) {
        const vals = leaves(input.tool_input || {}).map(([, v]) => String(v ?? '').trim());
        const near = refusedSends.find((r) => vals.includes(r.to.trim()) && vals.includes(r.body.trim()));
        process.stderr.write(`floorboss blocked this call: ${near ? `the message to ${promptPerson(near.name, near.id)} can't go now: ${near.why}` : why}\n`);
        process.exit(2);
      }
      for (const a of asks) ask(a);
      // A CRM task: the user sees it whole, as with a send. The task it matched is noted for this call, so the
      // post hook marks that one (an approval given late, or the same text listed at two events, can't move it).
      if (tasks[0]?.key && tasks[0]._event && input.tool_use_id) {
        mkdirSync(join(home(), 'task-pending'), { recursive: true, mode: 0o700 });
        writeText(
          join(home(), 'task-pending', callNote(input.tool_use_id)),
          JSON.stringify({ key: tasks[0].key, event: tasks[0]._event, at: new Date(nowMs).toISOString() })
        );
      }
      for (const t of tasks)
        ask(
          `floorboss: create a task in your CRM via ${t.server}/${t.tool}${t.name ? `, about ${promptPerson(t.name, t.id)}` : ''}.\n\nThe task as floorboss listed it:\nTitle: ${promptLine(t.title)}\nContact: ${t.contact ? promptAddr(t.contact) : 'none'}\nDue: ${t.due || 'none'}\n\n${fullText(null, t.body)}\n\nAllow only if this is a task you want in your CRM.`
        );
      // A new CRM record: who goes in, field by field.
      // Each person is let through once: an exclusive marker per person (created or refused, never both), so a
      // create whose answer was lost isn't made twice; floorboss looks them up instead (contact-list's "released").
      for (const x of contacts) {
        const mdir = join(home(), 'events', x._event, 'released');
        mkdirSync(mdir, { recursive: true, mode: 0o700 });
        try {
          markOnce(join(mdir, `crm-${promptId(x.id)}`), nowMs);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          process.stderr.write(
            `floorboss blocked this call: ${promptPerson(x.name, x.id, x.email)} was already let through to your CRM once (the record may be there): run flow next: it looks them up by email before anything is created again.\n`
          );
          process.exit(2);
        }
      }
      for (const x of contacts)
        ask(
          `floorboss: add ${promptPerson(x.name, x.id, x.email)} to your CRM as a new contact via ${x.server}/${x.tool}, so their replies are filed on a record floorboss can read.\n\nName: ${promptLine(x.name)}\nEmail: ${promptAddr(x.email)}\nCompany: ${promptLine(x.company || 'none')}\nTitle: ${promptLine(x.title || 'none')}\n\nThe call, as it goes:\n${x.args.map(promptLine).join('\n').slice(0, 1200)}\n\nNothing is sent. Allow only if you want this person in your CRM.`
        );
      // Staged drafts: once per batch (one stage-list.json, as floorboss wrote it), with everyone in it. The
      // marker (stage-asked.json, a record Claude's Write can't touch) is written only by the PostToolUse hook,
      // once a draft of the batch went in after this prompt: until then every draft asks, so a "no" stops the
      // rest. This hook writes only stage-pending.json (the batch it asked about), which only that hook reads.
      for (const it of staged.slice(0, 1)) {
        const evDir = join(home(), 'events', it._event);
        const batch = stageBatch(evDir);
        const marker = readJsonStrict(join(evDir, 'stage-asked.json'), null);
        const key = `${fold(it.to)}|${it.id}|${it.touch ?? 1}`;
        // The batch's yes covers each draft once: a draft that already went in (the PostToolUse hook marks it once the
        // call ran) waits for its receipt. A call that failed or was declined marks nothing, so it can be tried again.
        if (marker?.batch === batch) {
          if (existsSync(join(evDir, 'released', `stage-${it.id}-${it.touch ?? 1}-${batch}`))) {
            process.stderr.write(
              `floorboss blocked this call: the draft to ${promptPerson(nameOfStaged(evDir, it), it.id)} already went into your drafts in this batch. If it's there, save its receipt (outreach staged); if it isn't, run stage-list again.\n`
            );
            process.exit(2);
          }
          continue;
        }
        const all = listed('stage-list.json', nowMs).filter((x) => x._event === it._event && !x._why);
        const nameOf = (x) => x.name || personName(evDir, x.id);
        const who = all
          .map((x) => `- ${promptPerson(nameOf(x), x.id, x.to)}`)
          .join('\n')
          .slice(0, 1500);
        const entries = eventRecord(evDir).entries;
        const history = all.flatMap((x) => holdHistory(entries, x.id, nameOf(x)));
        ask(
          `floorboss: put ${all.length} approved draft${all.length === 1 ? '' : 's'} in your mailbox's drafts folder via ${it.server}/${it.tool}. Nothing is sent: they wait there for you. This one is to ${promptPerson(nameOf(it), it.id, it.to)}. The batch:\n${who}\n\n${history.length ? `Held before:\n${history.join('\n')}\n\n` : ''}Allowing this lets the rest of this batch go into your drafts without asking again. If you decline, nothing is staged and floorboss asks again at the next draft.`
        );
        writeText(join(evDir, 'stage-pending.json'), JSON.stringify({ batch, first: key, at: new Date(nowMs).toISOString(), ...callId(input) }));
      }
      // A lookup let through: counted by the PostToolUse hook once it ran, against this window only (the
      // window's end, noted here, must still be the one in enrich-window.json then).
      // Each lookup let through leaves its own note (several at once are several), used by its own post. The
      // count is checked again under the lock as the note is written, so lookups started at once can't each see
      // the last free one.
      if (enrichUsed.length && enrichWindow) {
        const call = String(input?.tool_use_id || '');
        const over = withLock('enrich', () => {
          const w = readJsonStrict(join(home(), 'enrich-window.json'), null);
          if (!w || w.until !== enrichWindow.until) return 'the lookup window changed while this lookup was checked; run it again.';
          const notes = enrichNotes(w.until, nowMs);
          const used = windowUsed(w);
          // (A note this same call left already, from a pre hook run again, isn't another lookup.)
          const others = notes.filter((x) => !(call && x.call === call)).length;
          if (used + others >= windowAllowed(w)) return lookupsGone(windowAllowed(w), used, others);
          mkdirSync(enrichPendingDir(), { recursive: true, mode: 0o700 });
          writeText(
            join(enrichPendingDir(), callNote(call || `${input?.session_id || ''}:${nowMs}:${randomBytes(8).toString('hex')}`)),
            JSON.stringify({ until: w.until, at: new Date(nowMs).toISOString(), call })
          );
          return null;
        });
        if (over) {
          process.stderr.write(`floorboss blocked this call: ${over}\n`);
          process.exit(2);
        }
      }
      const meta = /^(action|coordinate|url|selector|ref|tabid|tab_id|element|uid|index|tab|start_coordinate)$/i;
      const action = String(input.tool_input?.action || '');
      const bt = bareBrowserTool(toolPart);
      const pressing = ['key', 'press_key', 'keyboard_press'].includes(bt) || action === 'key';
      const typing =
        !pressing &&
        (['type', 'fill', 'fill_form', 'form_input', 'keyboard_type', 'insert_text'].includes(bt) || action === 'type' || (!!crmLog && bt === 'select_option'));
      // What a call types: its value or text fields (Playwright's fill_form also names each field and its
      // type), else every value but the ones that only point at an element.
      const typed = () => {
        const all = leaves(input.tool_input || {}).map(([k, v]) => [k.split('.').pop().replace(/\[\]$/, ''), String(v ?? '')]);
        const vals = all.filter(([k]) => /^(value|values|text)$/i.test(k));
        return (vals.length ? vals : all.filter(([k]) => !meta.test(k))).map(([, v]) => v).filter((v) => v.trim());
      };
      const isUrlText = (t) => looksLikeUrl(t) || (!!readUrl(t)?.host && !/\s/.test(t.trim()));
      // A window lifts the run's "the browser only reads" rule for 20 minutes, and it opens on words the session
      // wrote. So its first browser call asks the user, naming what the window lets the browser do; the PostToolUse
      // hook marks the window as allowed only once that call ran. Until then every call in it asks.
      const win = browserSend ? { kind: 'send', w: browserSend } : crmLog ? { kind: 'log', w: crmLog } : null;
      if (win && browserCall) {
        const key = windowKey(win.kind, win.w);
        const marker = readJsonStrict(join(home(), 'window-asked.json'), null);
        if (marker?.key !== key) {
          const what =
            win.kind === 'send'
              ? `send your approved notes in the event app or LinkedIn (${(win.w.ids || []).length || 'the listed'} people)`
              : `log your sent messages in your CRM's web app (${logItems(win.w.event).length} listed)`;
          ask(
            `floorboss: open a browser window until ${String(win.w.until).slice(11, 16)} UTC to ${what} for ${promptLine(win.w.event)}. In it the browser may click and type the listed people's details without asking again; each message's text still asks.\n\nAllow only if you asked floorboss to do this now.`
          );
          writeText(join(home(), 'window-pending.json'), JSON.stringify({ key, at: new Date(nowMs).toISOString(), ...callId(input) }));
        }
      }
      // In either browser window, only the keys KEY_OK allows (no paste; the one
      // shortcut is a modifier with Enter).
      if ((browserSend || crmLog) && browserCall && pressing) {
        const keys = typed().join(' ').split(/\s+/).filter(Boolean);
        if (keys.some((k) => !KEY_OK.test(k))) {
          process.stderr.write(
            `floorboss blocked this call: in the browser window only plain keys are pressed (Enter, Tab, arrows), not ${JSON.stringify(keys.join(' ').slice(0, 40))}.\n`
          );
          process.exit(2);
        }
      }
      // Inside the CRM log window, as strict as the send window: every value typed is a listed item's own
      // (its message, or its person's name, company, email, profile link, title, date or fill values), and
      // before a message's text goes into the page the user is asked, with the whole text.
      if (crmLog && browserCall && typing) {
        const texts = typed();
        const items = logItems(crmLog.event);
        const r = logTyping(texts, items, hosts);
        if (r.why) {
          process.stderr.write(`floorboss blocked this call: ${r.why}\n`);
          process.exit(2);
        }
        if (r.bodies.length) {
          const [hit] = r.bodies[0];
          const vouch = r.bodies.every(([it]) => it._approved)
            ? 'This is the text you approved.'
            : hit.received
              ? 'This is a reply floorboss read on the page, not a message of yours: check it is what they wrote.'
              : "floorboss can't match this text to a draft you approved (it was reported as sent, or the list was changed): check it is what you sent.";
          ask(
            `floorboss: the browser is about to type this into your CRM as a logged activity on the record of ${promptPerson(hit.name, hit.id, hit.to)}${/^\d{4}-\d{2}-\d{2}$/.test(String(hit.sent_on || '')) ? ` (${hit.sent_on})` : ''}. ${vouch}\n\n${r.bodies.every(([it]) => it._approved) ? 'The text you approved:' : 'The text it is typing:'}\n${fullText(null, r.bodies.map(([, t]) => t).join('\n\n'))}\n\nAllow only if this page is that person's record and this is the message to log.`
          );
        }
      }
      // Inside a browser send window: what is typed must be a listed note, exactly (whitespace and case aside),
      // and the user is asked, with the text actually typed; or a listed person's name or company (a search
      // box). Anything else is refused: the window is for the listed notes only.
      if (browserSend && browserCall && typing) {
        const texts = typed();
        const items = browserItems(browserSend.event);
        // Every value is checked before anything is asked; a typed link is text like any other (refused).
        const hits = [];
        for (const t of texts) {
          const hit = !isUrlText(t) && items.find((it) => squash(t) === squash(it.body));
          if (hit) {
            hits.push([hit, t]);
            continue;
          }
          if (!isUrlText(t) && items.some((it) => [it.name, it.company].some((x) => x && squash(t) === squash(x)))) continue;
          process.stderr.write(
            `floorboss blocked this call: the browser send window is for the listed notes only, typed exactly as listed (or a listed person's name, to find them), and ${JSON.stringify(t.slice(0, 80))} isn't one of them.\n`
          );
          process.exit(2);
        }
        if (hits.length) {
          const [hit] = hits[0];
          ask(
            `floorboss: the browser is about to send the ${hit.touch > 1 ? `follow-up ${hit.touch - 1}` : 'note'} to ${promptPerson(hit.name, hit.id, hit.to)}.\n\nThe text you approved, as it is typed:\n${fullText(null, texts.join('\n\n'))}\n\nAllow only if this page is that person's and this is the approved note.`
          );
        }
      }
      // Each approved send goes once: an exclusive marker per message (created or refused, never both), then
      // the release in the event's log before the call runs. Two calls at once can't both get through.
      for (const it of sent) {
        const evDir = join(home(), 'events', it._event);
        const resets = eventRecord(evDir).entries.filter(
          (e) => e.id === it.id && e.touch === it.touch && ['release_cleared', 'bounced'].includes(e.type)
        ).length;
        const mdir = join(evDir, 'released');
        mkdirSync(mdir, { recursive: true, mode: 0o700 });
        try {
          closeSync(openSync(join(mdir, `${it.id}-${it.touch}-${resets}`), 'wx', 0o600));
        } catch (e) {
          if (e.code === 'EEXIST') {
            process.stderr.write(
              `floorboss blocked this call: the message to ${promptPerson(it.name, it.id)} was already let through once (it may have gone): check, then record it, or resend with the user's words.\n`
            );
            process.exit(2);
          }
          throw e;
        }
        // appendLine: starts on a fresh line after a torn one and syncs, so a release is never glued onto a broken line.
        // If the release can't be written, the marker goes too: the call is blocked, and nothing is held as sent.
        try {
          appendLine(
            join(evDir, 'ledger.jsonl'),
            `${JSON.stringify({ at: new Date(nowMs).toISOString(), type: 'send_released', who: 'guard', id: it.id, touch: it.touch, hash: it.hash || null, via: it.via, to: it.to })}\n`
          );
        } catch (e) {
          try {
            unlinkSync(join(mdir, `${it.id}-${it.touch}-${resets}`));
          } catch {
            /* gone */
          }
          throw e;
        }
      }
      // The one check floorboss's files can't fake: Claude Code asks the user before every send, even when the
      // tool is set to "always allow". Every file the checks above read is one a session could write, so the
      // record catches mistakes and drift, and the person at the prompt is the boundary. No send skips it.
      const it = sent[0];
      if (it) {
        // The address shown is the one the call carries, not the list's: what the user allows is what goes.
        const callTo = recipientShown(input.tool_input || {}, config.connectors?.[it.via], it.to);
        // A follow-up says when that person's replies were last checked, so a reply that came in since can be
        // caught at the click: floorboss can't close that gap itself.
        let checked = '';
        if (it.touch > 1) {
          let settings = {};
          try {
            settings = { ...loadEvent(it._event).settings, connectors: config.connectors || {} };
          } catch {
            /* the prompt still goes */
          }
          const at = lastReplyCheck(eventRecord(join(home(), 'events', it._event)).entries, it.id, it.via, readersOf(settings));
          if (at) checked = ` Their replies were checked ${Math.max(0, Math.round((nowMs - at) / 1000))} seconds ago; if anything came in since, decline.`;
        }
        const name = it.name || personName(join(home(), 'events', it._event), it.id);
        const history = holdHistory(eventRecord(join(home(), 'events', it._event)).entries, it.id, name);
        const held = history.length ? ` Held before: ${history.join(' ')}` : '';
        // A message floorboss already let through once (then cleared to go again, on words the session wrote) says
        // so: the user is the one who can tell whether the first one went.
        const evEntries = eventRecord(join(home(), 'events', it._event)).entries;
        const mine = (e) => e.id === it.id && e.touch === it.touch;
        const releases = evEntries.filter((e) => mine(e) && e.type === 'send_released');
        const cleared = evEntries.filter((e) => mine(e) && ['release_cleared', 'bounced'].includes(e.type)).pop();
        const again =
          releases.length > 1
            ? ` floorboss already let this message through ${releases.length - 1 === 1 ? 'once' : `${releases.length - 1} times`}${releases[releases.length - 2].to && fold(releases[releases.length - 2].to) !== fold(it.to) ? ` (to ${promptAddr(releases[releases.length - 2].to)})` : ''} (last at ${String(
                releases[releases.length - 2].at
              )
                .slice(0, 16)
                .replace(
                  'T',
                  ' '
                )} UTC); it was cleared to go again${cleared?.type === 'bounced' ? ' because it bounced' : cleared?.said ? ` because: ${promptLine(String(cleared.said).slice(0, 200))}` : ''}. If the first one may have gone, decline.`
            : '';
        ask(
          `floorboss: send ${it.touch > 1 ? `follow-up ${it.touch - 1}` : it.touch === 0 ? 'the meeting confirmation' : 'the first message'} to ${promptPerson(name, it.id, callTo)} via ${it.via}.${again}${checked}${held}\n\nThe text you approved, as it goes:\n${fullText(it.subject, it.body)}\n\nAllow only if this is the approved message to the right person.`
        );
      }
      // An allowed call to a connector floorboss was given keeps its run open, so a long research step can't
      // outlast the lock. Blocked calls and calls to other servers don't touch it.
      if (run.active && givenServer(server, config, run)) stampRun({ session });
      allow();
    } catch (e) {
      process.stderr.write(
        `floorboss blocked this call: its guard couldn't check it (${String(e.message).slice(0, 120)}). This is for you, the user, to look at (the file it names, or the run lock at ${lockPath()}); Claude must not edit or delete floorboss's files to get past it.\n`
      );
      process.exit(2);
    }
  });
}
