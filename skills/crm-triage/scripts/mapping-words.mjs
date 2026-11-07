// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A column-mapping correction said in words ("Lifecycle is the status column. Customer means customer, Open Deal
// is warm. And there's no opt-out column."), read clause by clause into the same changes a corrected JSON makes.
// Every clause is either read or named back as not read: a sentence half understood is never confirmed.
import { FIELDS } from './sources.mjs';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
// "the status column", "an opt-out field": the words that name a field, without the frame around them.
const bare = (s) =>
  String(s || '')
    .trim()
    .replace(/^(?:the|a|an|our|my)\s+/i, '')
    .replace(/\s+(?:column|field|col)s?$/i, '')
    .replace(/[\s"'`]+$|^[\s"'`]+/g, '')
    .trim();

// What a column is, in the words people use for it. A field the file's kind doesn't have is not read.
const FIELD_WORDS = [
  [/^(status|stage|lifecycle|lifecycle stage|life cycle|pipeline stage|lead status|lead stage|label|labels)$/, 'status'],
  [/^(second status|other status|status 2|status two)$/, 'status_2'],
  [/^(owner|contact owner|account owner|deal owner|record owner|who owns (it|them|the record))$/, 'owner'],
  [/^(company|company name|account|account name|organi[sz]ation|employer)$/, 'company'],
  [/^(name|full name|contact name|person|contact)$/, 'name'],
  [/^(first name|given name|first)$/, 'first_name'],
  [/^(last name|surname|family name)$/, 'last_name'],
  [/^(e-?mail|e-?mail address|work e-?mail)$/, 'email'],
  [/^(title|job title|role|position)$/, 'title'],
  [/^(notes?|comments?|remarks|description)$/, 'notes'],
  [/^(opt[- ]?outs?|opted[- ]?out|unsubscribed?|unsubscribes|do[- ]not[- ](contact|e-?mail))$/, 'opted_out', 'optout'],
  [/^(consent|opt[- ]?ins?|opted[- ]?in|marketing consent)$/, 'opted_out', 'consent'],
  [/^(linkedin|linkedin url|linkedin profile|profile|profile url)$/, 'profile_url'],
  [/^(phone|phone number|mobile)$/, 'phone'],
  [/^(last contact|last contacted|last contact date|last activity|last activity date)$/, 'last_contact'],
  [/^(deal|deal name|deal title|opportunity)$/, 'deal'],
  [/^(deal stage|deal status|opportunity stage|won or lost|won\/lost)$/, 'deal_stage'],
  [/^(id|crm id|record id|contact id)$/, 'crm_id'],
  [/^(company size|size|employees|headcount)$/, 'company_size'],
  [/^(close date|won date|customer since)$/, 'won_at'],
  [/^(location|country|city)$/, 'location'],
  [/^(badge type|attendee type|ticket type|type)$/, 'attendee_type'],
  [/^(nothing|nothing for me|not needed|not used|unused|irrelevant|ignored?|to be ignored|nothing useful)$/, 'ignore']
];
// What a status value means, in the user's words.
const MEANING_WORDS = [
  // A partner the user names is theirs, like a customer ("Partner - active is a live partner"); a coworker is said so.
  [
    /^(customers?|clients?|won|closed won|paying|paying customers?|(?:(?:live|active|current|our|my) )?(?:channel |referral |reseller )?partners?|resellers?|(?:a )?partner(?:ship)? of (?:ours|mine))$/,
    'customer'
  ],
  [/^(warm|a warm note|warm notes?|in touch|open|open deal|active|hot|known|someone i know|people i know)$/, 'warm'],
  [/^(hold|on hold|held|wait|pause|paused|not now|leave (them|it) alone|leave alone|do ?n[o']?t (reach|contact|write to) (them|out)?)$/, 'hold'],
  [/^(lost|closed lost|dead|lost deals?)$/, 'lost'],
  [/^(opted[- ]?out|opt[- ]?out|do[- ]not[- ]contact|never contact|unsubscribed|dnc|stop|never write)$/, 'do_not_contact'],
  [/^(colleague|coworker|co-worker|coordinate|a colleague'?s?|a coworker'?s?|ask (my )?(colleague|coworker))$/, 'coordinate'],
  [/^(ignore|ignored|nothing|nothing special|cold|stranger|strangers|new|prospects?|leads?|normal|reach|reach out|fine to reach|reachable)$/, 'ignore']
];
const fieldOf = (s) => {
  const t = bare(s).toLowerCase().replace(/\s+/g, ' ');
  for (const [re, f, sense] of FIELD_WORDS) if (re.test(t)) return { field: f, ...(sense ? { sense } : {}) };
  return null;
};
const meaningOf = (s) => {
  const t = bare(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
  for (const [re, mean] of MEANING_WORDS) if (re.test(t)) return mean;
  return null;
};
// "There's no opt-out column", "no opt-outs", "we never added an unsubscribe field": the whole clause says it, so
// "no, Lifecycle is the status column" or "no opt-out problems" never reads as a CRM without opt-outs.
const OPTOUT_WORD = String.raw`(?:opt[- ]?outs?|opted[- ]?out|unsubscribes?|unsubscribed)(?:\s+(?:columns?|fields?|col|flags?))?`;
const OPTOUT_TAIL = String.raw`(?:\s+(?:in (?:it|there|this|the (?:file|export|crm|sheet)|our (?:file|export|crm|sheet))|at all))?\W*$`;
const NO_LEAD = String.raw`(?:(?:(?:there(?:'s| is| are)|we(?:'ve| have)(?: got)?|it(?:'s got| has)|i have)\s+)?(?:no|not an?)|without an?|(?:there (?:isn'?t|is not|aren'?t|are not)|we (?:don'?t|do not) have|it (?:doesn'?t|does not) have|we never (?:added|had)|it never had)(?:\s+an?|\s+any)?)`;
export const NO_OPTOUT = new RegExp(String.raw`^${NO_LEAD}\s+${OPTOUT_WORD}${OPTOUT_TAIL}`, 'i');
// "No", "nope", "not right": the mapping isn't right, which says nothing about what to change.
const SAID_NO = /^(?:no|nope|nah|not right|not quite|wrong|that'?s wrong|that'?s not right|incorrect)\W*$/i;
// An answer cut into clauses, at sentence ends and commas, without its "and"/"also" lead-ins.
export const clausesOf = (text) =>
  String(text || '')
    .split(/[.;\n]+|,\s*/)
    .map((x) =>
      x
        .trim()
        .replace(/^(?:and|also|then|plus|but|so|oh and|and also)\s+/i, '')
        .replace(/\s+(?:too|please|as well)$/i, '')
        .trim()
    )
    .filter(Boolean);
// A whole answer (the CRM export's, said with its path) says there's no opt-out column: one clause says only
// that, and no other clause names an opt-out column ("Unsubscribed is the opt-out column").
export const saysNoOptOut = (text) => {
  const cls = clausesOf(text);
  return (
    cls.some((cl) => NO_OPTOUT.test(cl)) &&
    !cls.some((cl) => !NO_OPTOUT.test(cl) && /opt[- ]?(?:out|in)|unsubscri|do[- ]not[- ](?:contact|e-?mail)|consent/i.test(cl))
  );
};
const FILLER =
  /^(ok|okay|yes|yep|yeah|right|correct|fine|looks (right|good|fine|ok)|the rest (is|looks) (right|fine|ok|good)|otherwise (it'?s |it looks )?(fine|ok|right|good)|everything else is (fine|right|ok|good)|that'?s it|thanks?( you)?)$/i;
const VERB = /^(.+?)\s+(?:column\s+)?(?:is|means|=|->|→|should be|should mean|counts as|maps to|is read as|stands for|is for|holds)\s+(.+)$/i;
const IGNORE = /^(?:ignore|skip|drop|leave out|don'?t read|do not read)\s+(.+)$/i;
const NOT_NEEDED = /^(.+?)\s+(?:is ?n[o']?t|is not|isn'?t)\s+(?:needed|used|important|relevant|useful)$/i;

// text: the user's words; m: the mapping as it stands (its headers and columns); valuesOf(header): every value
// that column holds in the file. Returns what was read, as changes, with each clause read or not.
export function readMappingWords(text, m, valuesOf) {
  const headers = m.headers || Object.keys(m.columns || {});
  const allowed = FIELDS[m.kind] || [];
  const headerOf = (s) => {
    const n = norm(bare(s));
    return n ? headers.find((h) => norm(h) === n) || headers.find((h) => norm(h) === norm(s)) || null : null;
  };
  const columns = {},
    status = {},
    ignore = [];
  const read = [],
    unread = [],
    conflicts = [];
  // What each clause said about a column or a status value: a second clause that says something else about the
  // same one is a contradiction, never the last word.
  const saidOf = new Map();
  const say = (key, what, cl, label) => {
    const before = saidOf.get(key);
    if (!before) saidOf.set(key, { what, cl });
    else if (before.what !== what) {
      if (!before.conflict) conflicts.push(`"${before.cl.slice(0, 80)}" and "${cl.slice(0, 80)}" say two things about ${label}.`);
      before.conflict = true;
    }
  };
  let optOutNone = false,
    saidNo = false,
    last = null,
    lastWasIgnore = false;
  const clauses = clausesOf(text);
  const pending = [];
  // Columns first, so a value is read against the column the same answer makes the status column.
  for (const cl of clauses) {
    if (FILLER.test(cl)) continue;
    // "No, Lifecycle is the status column": the no leads the corrections; a no with none after it is refused.
    if (SAID_NO.test(cl)) {
      saidNo = true;
      continue;
    }
    if (NO_OPTOUT.test(cl)) {
      optOutNone = true;
      read.push('there is no opt-out column');
      lastWasIgnore = false;
      continue;
    }
    const ig = IGNORE.exec(cl) || NOT_NEEDED.exec(cl);
    if (ig) {
      const parts = ig[1].split(/\s+and\s+|\s*&\s*/).map((x) => x.trim());
      const hs = parts.map((p) => (/^(it|that|this|them|those)$/i.test(p) ? last : headerOf(p)));
      if (hs.every(Boolean)) {
        for (const h of hs) {
          say(`col:${h}`, 'ignore', cl, `"${h}"`);
          ignore.push(h);
          read.push(`"${h}" is not read`);
          last = h;
        }
        lastWasIgnore = true;
        continue;
      }
    }
    // "ignore Badge Type, Comments": a bare column name right after an ignore is ignored too.
    if (lastWasIgnore && headerOf(cl)) {
      const h = headerOf(cl);
      say(`col:${h}`, 'ignore', cl, `"${h}"`);
      ignore.push(h);
      read.push(`"${h}" is not read`);
      last = h;
      continue;
    }
    lastWasIgnore = false;
    const v = VERB.exec(cl);
    if (v) {
      const [left, right] = [v[1], v[2]];
      const asCol = (h, f) => {
        if (!h || !f || (f.field !== 'ignore' && !allowed.includes(f.field))) return false;
        say(`col:${h}`, f.field === 'ignore' ? 'ignore' : `${f.field}/${f.sense || ''}`, cl, `"${h}"`);
        if (f.field === 'ignore') {
          ignore.push(h);
          read.push(`"${h}" is not read`);
        } else {
          columns[h] = { field: f.field, ...(f.sense ? { sense: f.sense } : {}) };
          read.push(
            `"${h}" is the ${f.field.replace(/_/g, ' ')} column${f.sense === 'consent' ? ' (yes means they agreed to be contacted)' : f.field === 'opted_out' ? ' (yes means they opted out)' : ''}`
          );
        }
        last = h;
        return true;
      };
      // "<Header> is the <field> column", then "the <field> column is <Header>".
      if (asCol(headerOf(left), fieldOf(right))) continue;
      if (/\b(column|field)\b/i.test(left) && asCol(headerOf(right), fieldOf(left))) continue;
      if (!/\b(column|field)\b/i.test(right) && meaningOf(right)) {
        pending.push({ cl, value: left, meaning: meaningOf(right) });
        continue;
      }
    }
    unread.push(cl);
  }
  // The status columns once this answer is applied, and every value they hold.
  const statusCols = headers.filter((h) => {
    const f = (columns[h] || (ignore.includes(h) ? { field: 'ignore' } : m.columns?.[h]) || {}).field;
    return f === 'status' || f === 'status_2';
  });
  const values = [...new Set(statusCols.flatMap((h) => valuesOf(h)))];
  for (const p of pending) {
    const n = norm(bare(p.value));
    const hit = values.find((x) => norm(x) === n);
    if (!hit) {
      unread.push(p.cl);
      continue;
    }
    say(`value:${hit}`, p.meaning, p.cl, `"${hit}"`);
    status[hit] = p.meaning;
    read.push(`"${hit}" means ${p.meaning.replace(/_/g, ' ')}`);
  }
  // "Unsub is the opt-out column" and "there's no opt-out column" in one answer: neither is taken.
  const named = Object.entries(columns)
    .filter(([, col]) => col.field === 'opted_out')
    .map(([h]) => h);
  if (optOutNone && named.length) {
    unread.push(`there's no opt-out column, yet ${named[0]} is named as the opt-out column`);
    optOutNone = false;
  }
  // A contradicted column or value is taken from neither clause.
  for (const [key, x] of saidOf)
    if (x.conflict) {
      const [kind, k] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (kind === 'col') {
        delete columns[k];
        for (let i = ignore.indexOf(k); i >= 0; i = ignore.indexOf(k)) ignore.splice(i, 1);
      } else delete status[k];
    }
  return {
    columns,
    status,
    ignore: [...new Set(ignore)],
    opt_out_none: optOutNone,
    said_no: saidNo,
    conflicts,
    status_columns: statusCols,
    status_values: values,
    read,
    unread
  };
}
