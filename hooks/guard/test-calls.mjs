// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Setup's test calls: the one test draft, task or contact a connection is tried with before its recipe is saved.
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../../lib/paths.mjs';
import { sameServer } from '../../lib/security.mjs';
import { bareToolName, screenTool, TEST_TASK } from '../../skills/connectors/scripts/tasks.mjs';
import { screenArgs } from '../../skills/connectors/scripts/tasks.mjs';
import { writeSync } from 'node:fs';
import { leaves, recent, fold, readJsonStrict } from './shared.mjs';
import { personName } from './prompts.mjs';
import { setupKinds } from './connectors.mjs';

// Setup's test draft or test task (connectors test-allow): one call, this server and tool, 15 minutes, and a
// test draft goes only to the address named.
// A once-only marker: created or refused, never both. It holds floorboss's clock time, so the record can tell an
// answer given after it from one given before.
export const nameOfStaged = (evDir, it) => it.name || personName(evDir, it.id);
export function markOnce(path, nowMs) {
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

// In the session that ran floorboss, a pending test passes only on the server it is a test of: the CRM for a task
// or a contact, a mailbox or chat tool floorboss knows for the others. Otherwise it would take a call on any
// connected server past the run's limits, under a prompt that names it a test.
export function testOnItsServer(pending, config) {
  const inv = readJsonStrict(join(home(), 'inventory.json'), {});
  const server = String(pending?.server ?? '');
  // An inventory from before setup_servers existed counts what it had found, as foundServer does.
  const atSetup = !Array.isArray(inv?.setup_servers) || inv.setup_servers.some((x) => sameServer(String(x), server));
  const foundAs = (kind) => atSetup && (setupKinds(inv)[kind] || []).some((x) => String(x).startsWith('mcp:') && sameServer(String(x).slice(4), server));
  const saved = (...tasks) => tasks.some((t) => config.connectors?.[t]?.server && sameServer(config.connectors[t].server, server));
  if (['crm.create_task', 'crm.create_contact'].includes(pending?.task)) return config.connectors?.['crm.lookup']?.server ? saved('crm.lookup') : foundAs('crm');
  if (['stage_draft', 'email.send'].includes(pending?.task)) return foundAs('email') || saved('stage_draft', 'email.send', 'email.history', 'email.messages');
  if (pending?.task === 'chat.send') return foundAs('chat') || saved('chat.send');
  return false;
}
