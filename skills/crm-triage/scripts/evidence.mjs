// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Everything known about one contact, gathered in one place before anyone decides: CRM rows that may be
// them, account rules for their company, the do-not-contact list, the user's own contacts and mailbox,
// earlier events, and the list's own opt-in answer. Each item says where it came from and how sure the
// match is ('exact' or 'fuzzy'); resolve() decides, and fuzzy evidence never decides on its own.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../lib/jsonio.mjs';
import { nowFrom } from '../../../lib/event.mjs';
import { home } from '../../../lib/paths.mjs';
import { readLedger, fold, lastSent } from '../../../lib/ledger.mjs';
import {
  normPersonName,
  nameMatchKey,
  sameName,
  companyKey,
  companyRelated,
  emailDomain,
  emailBase,
  isSharedDomain,
  similarity,
  levenshtein
} from '../../../lib/normalize.mjs';
import { CONSTANTS } from '../../../lib/config.mjs';
import { isActive } from './dnc.mjs';

const profileKey = (url) => {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
};

// Index the CRM rows once per load.
export function indexCrm(rows) {
  const byEmail = new Map(),
    byName = new Map(),
    bySurname = new Map(),
    byProfile = new Map();
  rows.forEach((r, i) => {
    r.row = i;
    r.name_key = r.name ? normPersonName(r.name) : null;
    r.company_key = r.company ? companyKey(r.company) : null;
    if (r.email) (byEmail.get(r.email) || byEmail.set(r.email, []).get(r.email)).push(r);
    const pk = profileKey(r.profile_url);
    if (pk) (byProfile.get(pk) || byProfile.set(pk, []).get(pk)).push(r);
    if (r.name_key) (byName.get(r.name_key) || byName.set(r.name_key, []).get(r.name_key)).push(r);
    const sur = r.name ? nameMatchKey(r.name).split(' ').pop() : null;
    if (sur) (bySurname.get(sur) || bySurname.set(sur, []).get(sur)).push(r);
  });
  return { byEmail, byName, bySurname, byProfile, all: rows };
}

const nearName = (a, b) =>
  a && b && a !== b && Math.abs(a.length - b.length) <= 2 && Math.min(a.length, b.length) >= 6 && a[0] === b[0] && levenshtein(a, b) <= 2;
const KEEP_AWAY = /reject|declin|disqualif|do not|dnc|unsub|opt.?out|lost|never|stop/i;

// CRM rows that may be this person. exact: the same address or profile with a name in common, or the same
// name at a strongly similar company. fuzzy: everything else that could be them.
export function crmMatches(contact, index) {
  if (!index) return [];
  const out = [];
  const seen = new Set();
  const add = (r, sure, says, extra = {}) => {
    if (!seen.has(r.row)) {
      seen.add(r.row);
      out.push({ from: 'crm', row: r.row, record: r, sure, says, ...extra });
    }
  };
  const strong = CONSTANTS.match_strong,
    weak = CONSTANTS.match_weak;
  const nk = normPersonName(contact.name);
  const nameWords = (n) =>
    nameMatchKey(n || '')
      .split(' ')
      .filter(Boolean);
  for (const e of contact.emails || [contact.email])
    for (const r of index.byEmail.get(e) || []) {
      const co = r.company_key && contact.company_key ? similarity(r.company_key, contact.company_key) : 1;
      add(
        r,
        co >= weak || !r.company_key ? 'exact' : 'fuzzy',
        co >= weak || !r.company_key ? `same address ${e}` : `same address ${e}, but the CRM has them at ${r.company}`
      );
    }
  const pk = profileKey(contact.profile_url);
  for (const r of index.byProfile.get(pk) || []) {
    const a = nameWords(contact.name),
      b = nameWords(r.name);
    const nameInCommon = !a.length || !b.length || a.some((w) => b.includes(w)) || sameName(r.name, contact.name, { initials: true });
    add(
      r,
      nameInCommon ? 'exact' : 'fuzzy',
      nameInCommon ? 'same LinkedIn link' : `same LinkedIn link as ${r.name}, but a different name: the wrong link on the list, or the same person?`
    );
  }
  for (const r of index.byName.get(nk) || []) {
    const co = r.company_key && contact.company_key ? similarity(r.company_key, contact.company_key) : null;
    if (co == null) add(r, 'fuzzy', `same name as ${r.name}${r.company ? ` at ${r.company}` : ''}, with no company to compare`);
    else if (co >= strong) add(r, 'exact', `same name at ${r.company}`);
    else if (co >= weak) add(r, 'fuzzy', `same name, company spelled differently (${r.company})`);
    else if (KEEP_AWAY.test(`${r.statuses?.join(' ') || r.status || ''} ${r.stop_note || ''}`) || r.opted_out || r.rejected_at)
      add(r, 'fuzzy', `same name as ${r.name} at ${r.company} (the list says ${contact.company}): moved jobs, or someone else?`);
    // The same full name at an unrelated company: most likely they moved since the CRM row was written. Linked,
    // marked as from an old job (the draft treats the CRM history as possibly out of date).
    else if (nameWords(contact.name).length > 1)
      add(r, 'exact', `same name as ${r.name}, whom the CRM has at ${r.company} (the list says ${contact.company}): the CRM row may be from an old job`, {
        moved: true
      });
  }
  if (contact.company_key) {
    for (const r of index.all)
      if (nearName(nk, r.name_key) && r.company_key && similarity(r.company_key, contact.company_key) >= strong)
        add(r, 'fuzzy', `near name: ${r.name} at ${r.company}`);
    const sur = nameMatchKey(contact.name).split(' ').pop();
    for (const r of index.bySurname.get(sur) || [])
      if (
        r.name_key &&
        r.company_key &&
        related(r.company_key, contact.company_key) &&
        (sameName(r.name, contact.name, { initials: true }) || nameMatchKey(r.name) === nameMatchKey(contact.name))
      )
        add(r, 'fuzzy', `nickname or initial: ${r.name} at ${r.company}`);
  }
  return out;
}

// Accounts: an accounts file (company, owner, status) and companies the CRM implies (a colleague's active
// records, or an account-level hold).
const OK_STATUS = /^(ok|open|fine|allowed|yes|free|unowned|available|go|prospect|target)$/i;
const ACCOUNT_OFF =
  /off.?limits|do not|don'?t|dnc|hold|block|restrict|no contact|exclusive|competitor|legal|litig|embargo|never|banned|sensitive|tender|conflict|churn|at risk|no.?poach|non.?solicit|do not (hire|recruit|approach)/i;
const ACCOUNT_HOLD_STATUS =
  /litig|lawsuit|legal|dispute|tender|rfp|quiet period|embargo|conflict|complian|at risk|churn|competitor|banned|do not contact.*(company|account)|exclusive|no.?poach|non.?solicit/i;
const PLACEHOLDER =
  /^(freelance|freelancer|self employed|self-employed|independent|consultant|consulting|student|retired|stealth|n a|na|none|unknown|tbd|confidential|various|private|personal|own business|open to work)$/i;
export const INACTIVE_OWNER = /deactivated|inactive|former|disabled|left the company|no longer/i;
const col = (headers, re) => headers.find((h) => re.test(h.trim()));

export function readAccounts({ headers, records }) {
  const company =
    col(headers, /^(company|company name|account|account name|organi[sz]ation( name)?|org|customer|name|firma|empresa|soci[eé]t[eé])$/i) ||
    headers.find((h) => !/id$|^id\b|domain|owner|status|created|date/i.test(h)) ||
    headers[0];
  const domain = col(headers, /domain|website|url|web/i);
  const owner = col(headers, /^(owner|account owner|company owner|holder|rep|account manager|am|manager|claimed by|assigned to)( name)?$/i);
  const status = col(headers, /status|type|stage|tier|relationship|lifecycle/i);
  return records
    .map((r) => {
      const label = String(r[company] || '').trim();
      const dom = domain
        ? String(r[domain] || '')
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/[/?#].*$/, '')
            .replace(/^@/, '')
            .trim()
        : '';
      const st = status ? String(r[status] || '').trim() : '';
      const own = owner ? String(r[owner] || '').trim() : '';
      if ((!label && !dom) || label.toLowerCase() === String(company).toLowerCase()) return null;
      return {
        key: label ? companyKey(label) : null,
        label: label || dom,
        domain: dom || null,
        owner: own || null,
        status: st || null,
        off: !own ? !OK_STATUS.test(st) : ACCOUNT_OFF.test(st),
        from: 'accounts list'
      };
    })
    .filter(Boolean);
}

// The owner of an account from the CRM: the owner most of its active records name; a tie goes to the most
// recent last contact. Never "whichever row comes last". Active: a record someone works, prospecting included
// (a one-way status still has an owner working it); a lost deal or a row with no status at all is not.
const worked = (r) =>
  r.owner && !INACTIVE_OWNER.test(r.owner) && !r.meanings?.includes('lost') && !(r.meanings?.includes('ignore') && !String(r.status || '').trim());
// An open or won deal: a customer, a won date or deal, a deal whose stage says won or open, or a two-way stage
// (negotiation, proposal, opportunity).
const isDeal = (r) =>
  !!(r.won_at || r.on_won_deal === true || ['won', 'open'].includes(r.deal_state) || r.meanings?.some((m) => ['customer', 'warm'].includes(m)));
function ownerTally(records, ownerIsUser) {
  const active = records.filter(worked);
  const tally = new Map();
  for (const r of active) {
    const k = r.owner.trim();
    const t = tally.get(k) || { owner: k, n: 0, last: '', deal: null };
    t.n++;
    if ((r.last_contact || '') > t.last) t.last = r.last_contact || '';
    if (!t.deal && isDeal(r)) t.deal = r.status || 'won';
    tally.set(k, t);
  }
  return {
    active,
    owners: [...tally.values()].sort((a, b) => b.n - a.n || (b.last > a.last ? 1 : b.last < a.last ? -1 : 0)).map((t) => ({ ...t, mine: ownerIsUser(t.owner) }))
  };
}
export function accountOwner(records, { ownerIsUser = () => false } = {}) {
  const {
    active,
    owners: [top]
  } = ownerTally(records, ownerIsUser);
  if (!top) return null;
  return { owner: top.owner, records: top.n, of: active.length, mine: top.mine, deal: top.deal };
}

// left: CRM rows of people who are on the list at another company now (they moved): they don't make their old
// company anyone's account (a lead who left isn't "your account" for their old colleagues). An account-level
// hold on such a row still counts.
export function accountsFromCrm(rows, { ownerIsUser = () => false, left = new Set() } = {}) {
  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_key || (r.company ? companyKey(r.company) : null);
    if (!key || PLACEHOLDER.test(key)) continue;
    r.company_key = key;
    (byCompany.get(key) || byCompany.set(key, []).get(key)).push(r);
  }
  const out = [];
  for (const [key, recs] of byCompany) {
    const holdRow = recs.find(
      (r) => (r.meanings || []).some((m) => ['hold', 'do_not_contact'].includes(m)) && r.statuses.some((s) => ACCOUNT_HOLD_STATUS.test(s))
    );
    if (holdRow) {
      out.push({
        key,
        label: holdRow.company,
        domain: Object.keys(Object.fromEntries(recs.map((r) => [emailDomain(r.email), 1]))).find((d) => d && d !== 'undefined' && !isSharedDomain(d)) || null,
        owner: null,
        status: holdRow.statuses.find((s) => ACCOUNT_HOLD_STATUS.test(s)),
        off: true,
        from: 'crm',
        records: recs.length
      });
      continue;
    }
    // The account's email domain: the one most of its records use (never a webmail domain).
    const doms = {};
    for (const r of recs) {
      const d = emailDomain(r.email);
      if (d && !isSharedDomain(d)) doms[d] = (doms[d] || 0) + 1;
    }
    const domain = Object.entries(doms).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    // The owner with the most records first; then every coworker who works a record there, so the user's own
    // records at a company never hide a coworker's open deal there.
    const { active, owners } = ownerTally(
      recs.filter((r) => !left.has(r)),
      ownerIsUser
    );
    // Whose account it is: the user's open or won deal there makes it theirs (a coworker's contacts there are held
    // one by one, by their own records). A coworker's account covers everyone else only when the user has no deal
    // there and either no records or the coworker has a deal (an open negotiation, say). Both with a
    // deal: the coworker's entry stands, so nobody is written to before the user decides.
    const me = owners.find((o) => o.mine);
    // A row with no person on it (no name, no email) is the account's own record: its note is about the company
    // ("trialled our dock scheduler in 2025 at their Leeds DC"), a fact a draft to anyone there may use.
    const accountRow = recs.find((r) => !r.name && !r.email && r.notes);
    const note = accountRow
      ? String(accountRow.notes)
          .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
          .replace(/^\s*account note:\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) || null
      : null;
    const keep = (o, i) => (o.mine ? i === 0 : !me || (!me.deal && !!o.deal) || (!!me.deal && !!o.deal) || (i === 0 && !me.deal));
    // What the coworker's own records there say ("Lost on price March 2026"), for the note on everyone else there.
    const saysOf = (owner) => {
      const r = recs.find((x) => x.owner?.trim() === owner && String(x.notes || '').trim());
      return r
        ? String(r.notes)
            .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160)
        : null;
    };
    owners.forEach((o, i) => {
      if (keep(o, i))
        out.push({
          key,
          label: recs[0].company,
          domain,
          owner: o.owner,
          mine: o.mine,
          status: o.deal || recs.find((r) => r.owner?.trim() === o.owner)?.status || null,
          deal: o.deal,
          off: false,
          from: 'crm',
          records: o.n,
          of: active.length,
          ...(note ? { note } : {}),
          ...(!o.mine && saysOf(o.owner) ? { owner_note: saysOf(o.owner) } : {})
        });
    });
    // Only lost deals there, a coworker's: it is still their account (they know why it was lost), so everyone
    // else there is held for them as an open deal holds them. The lost-deal rule itself holds only the person on
    // that record; the account says the status, so the card can say why.
    // The user's own lost deal there too: the company isn't held for the coworker (the user knows it as well), and
    // the card says both records.
    if (!owners.length) {
      const lostAll = recs.filter((r) => r.owner && !INACTIVE_OWNER.test(r.owner) && !left.has(r) && r.meanings?.includes('lost'));
      const lost = lostAll.filter((r) => !ownerIsUser(r.owner)),
        mineLost = lostAll.filter((r) => ownerIsUser(r.owner));
      const top = [...new Set(lost.map((r) => r.owner.trim()))]
        .map((o) => ({ owner: o, rows: lost.filter((r) => r.owner.trim() === o) }))
        .sort((a, b) => b.rows.length - a.rows.length)[0];
      if (top && mineLost.length)
        out.push({
          key,
          label: recs[0].company,
          domain,
          owner: mineLost[0].owner.trim(),
          mine: true,
          status: `${mineLost[0].status || 'lost'} on your record; ${top.owner}'s record there says "${top.rows[0].status || 'lost'}"`,
          deal: null,
          off: false,
          from: 'crm',
          records: mineLost.length,
          of: lostAll.length,
          ...(note ? { note } : {})
        });
      else if (top) {
        const last =
          top.rows
            .map((r) => r.rejected_at || r.last_contact)
            .filter(Boolean)
            .sort()
            .pop() || null;
        out.push({
          key,
          label: recs[0].company,
          domain,
          owner: top.owner,
          mine: false,
          status: top.rows[0].status || 'lost',
          deal: null,
          lost: { status: top.rows[0].status || 'lost', at: last },
          off: false,
          from: 'crm',
          records: top.rows.length,
          of: top.rows.length,
          ...(note ? { note } : {}),
          ...(saysOf(top.owner) ? { owner_note: saysOf(top.owner) } : {})
        });
      }
    }
  }
  return out;
}

// listKeys: every company key on the list. "NWS" reaches "Northwind" through "Northwind Web Services" (one hop).
// Company comparisons repeat across hundreds of people and accounts: each pair is worked out once.
const relCache = new Map();
const related = (a, b) => {
  if (a === b) return true;
  const k = a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
  let v = relCache.get(k);
  if (v === undefined) {
    v = companyRelated(a, b);
    relCache.set(k, v);
  }
  return v;
};
const viaCache = new Map();
export const relatedVia = (a, b, listKeys = []) => {
  if (!a || !b) return false;
  if (related(a, b)) return true;
  const k = `${a}\u0001${b}\u0001${listKeys.length}`;
  let v = viaCache.get(k);
  if (v === undefined) {
    v = listKeys.some((x) => x !== a && x !== b && related(a, x) && related(x, b));
    viaCache.set(k, v);
  }
  return v;
};

export function accountMatches(contact, accounts, { sharedDomains = [], listKeys = [] } = {}) {
  const dom = emailDomain(contact.email);
  const workDom = dom && !isSharedDomain(dom, sharedDomains) ? dom : null;
  const out = [];
  for (const a of accounts) {
    const exact =
      (a.key && contact.company_key && a.key === contact.company_key) || (a.domain && workDom && (workDom === a.domain || workDom.endsWith(`.${a.domain}`)));
    const fuzzy = !exact && a.key && contact.company_key && relatedVia(a.key, contact.company_key, listKeys);
    if (exact || fuzzy)
      out.push({
        from: a.from,
        account: a,
        sure: exact ? 'exact' : 'fuzzy',
        says: exact ? `at ${a.label}` : `looks like ${a.label} (the list says ${contact.company})`
      });
  }
  return out;
}

// Do-not-contact entries (from dnc.mjs parseDncReport) that cover this contact.
export function dncMatches(contact, entries, { today, listKeys = [] } = {}) {
  const out = [];
  const email = contact.email,
    domain = emailDomain(email);
  const ck = contact.company_key,
    nk = normPersonName(contact.name);
  for (const e of entries.filter((x) => isActive(x, today))) {
    const label = e.label || e.value;
    if (e.type === 'email' && (contact.emails || [email]).some((x) => x && (x === e.value || emailBase(x) === emailBase(e.value))))
      out.push({ from: 'do-not-contact list', sure: 'exact', says: `${e.value} is on the list` });
    else if (e.type === 'domain' && domain && (domain === e.value || domain.endsWith('.' + e.value)))
      out.push({ from: 'do-not-contact list', sure: 'exact', says: `everyone at ${e.value}` });
    else if (e.type === 'company' && ck && (ck === e.value || relatedVia(ck, e.value, listKeys)))
      out.push({
        from: 'do-not-contact list',
        sure: ck === e.value ? 'exact' : 'fuzzy',
        says: ck === e.value ? `everyone at ${label}` : `looks like ${label} (the list says ${contact.company})`
      });
    else if (e.type === 'name' && nk && nk === e.value) out.push({ from: 'do-not-contact list', sure: 'exact', says: `${label} by name` });
    else if (e.type === 'name' && nk && (sameName(contact.name, label) || nameMatchKey(contact.name) === nameMatchKey(label)))
      out.push({ from: 'do-not-contact list', sure: 'fuzzy', says: `looks like ${label} (another spelling or a nickname)` });
  }
  return out;
}

// The user's own contacts (an export) and mailbox history: anyone they already talk to.
export function knownMatches(contact, known) {
  const mine = new Set((contact.emails || [contact.email]).filter(Boolean).map(emailBase));
  const nk = nameMatchKey(contact.name);
  const out = [];
  for (const k of known) {
    const theirs = [k.email, ...(k.emails_seen || [])].filter(Boolean);
    if (theirs.some((e) => mine.has(emailBase(e))))
      out.push({ from: k.source || 'your contacts', sure: 'exact', says: k.says || `in your contacts${k.date ? ` (${k.date})` : ''}`, known: k });
    else if (
      k.name &&
      nk.includes(' ') &&
      nameMatchKey(k.name) === nk &&
      k.company_key &&
      (k.company_key === contact.company_key || companyRelated(k.company_key, contact.company_key))
    )
      out.push({ from: k.source || 'your contacts', sure: 'exact', says: k.says || `in your contacts (${k.name} at ${k.company})`, known: k });
  }
  return out;
}

// People messaged at the user's other events (from their ledgers), with what happened.
// The mock event and the user's real events never see each other: a real person "in touch" at a real event is
// not held in the mock, and a stop at the mock never holds anyone at a real event (mock ledgers are skipped).
export function earlierEvents(currentSlug) {
  const dir = join(home(), 'events');
  if (!existsSync(dir)) return { people: [], skipped: [] };
  if (readJson(join(dir, currentSlug, 'event.json'), null)?.mock === true) return { people: [], skipped: [] };
  const people = [],
    skipped = [];
  for (const slug of readdirSync(dir)) {
    if (slug === currentSlug) continue;
    try {
      const ev = readJson(join(dir, slug, 'event.json'), null);
      if (!ev || ev.mock || !existsSync(join(dir, slug, 'ledger.jsonl'))) continue;
      const { entries, damaged } = readLedger(join(dir, slug, 'ledger.jsonl'));
      const st = fold(entries, damaged);
      for (const [id, p] of Object.entries(st.people)) {
        if (p.merged_into) continue;
        const sent = lastSent(p);
        const approved = Object.values(p.touches).some((t) => t.approved && !t.sent);
        if (!sent && !approved) continue;
        const date = sent ? p.touches[sent].sent.date : String(Object.values(p.touches).find((t) => t.approved)?.approved.at || '').slice(0, 10);
        // A meeting still to come is booked, not met: "(booked 11 Nov)".
        const ahead = p.booked && p.booked_start && Date.parse(p.booked_start) > nowFrom({}).getTime();
        const bookedWord = ahead
          ? `booked ${new Date(p.booked_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: ev.time_zone || 'UTC' })}`
          : 'met';
        people.push({
          name: p.name,
          email: p.email,
          emails_seen: [],
          company: p.company,
          company_key: p.company ? companyKey(p.company) : null,
          date,
          source: `your event ${ev.name}`,
          stopped: p.stopped,
          outcome: p.stopped ? 'said stop' : p.booked ? bookedWord : p.replied ? 'replied' : sent ? 'no reply' : 'approved, maybe sent',
          says: `messaged at ${ev.name} on ${date} (${p.stopped ? 'said stop' : p.booked ? bookedWord : p.replied ? 'replied' : sent ? 'no reply' : 'approved, maybe sent'})`,
          id,
          slug
        });
      }
    } catch (e) {
      skipped.push(`${slug}: ${e.message}`);
    }
  }
  return { people, skipped };
}

const OPT_IN_YES =
  /^(|yes|y|true|1|on|ok|open|open to meetings|opted[- ]?in|opt[- ]?in|double opt[- ]?in|accepts?|accepted|available|enabled|granted|consent given|can email|subscribed|checked|x|✓|✔|☑|ja|oui|sí|si|sim|tak|evet|はい|是|예)$/i;
const OPT_IN_NO =
  /^(no|n|false|0|off|disabled|unchecked|☐|✗|✘|declined?|opted[- ]?out|opt[- ]?out|not open|not available|do not contact|no thanks|no meetings|nein|non|não|nao|nee|nej|ei|nie|hayır|いいえ|否|아니요)$/i;
export function optInAnswer(value) {
  const v = String(value ?? '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .trim();
  return OPT_IN_YES.test(v) ? 'yes' : OPT_IN_NO.test(v) ? 'no' : 'unclear';
}

// Everything about one contact. inputs: { crmIndex, accounts, dnc, known, listKeys, sharedDomains, today, mailbox }.
export function gatherEvidence(contact, inputs) {
  const ev = [];
  for (const m of crmMatches(contact, inputs.crmIndex)) ev.push(m);
  for (const m of accountMatches(contact, inputs.accounts || [], inputs)) ev.push(m);
  for (const m of dncMatches(contact, inputs.dnc || [], inputs)) ev.push(m);
  for (const m of knownMatches(contact, inputs.known || [])) ev.push(m);
  const optIn = optInAnswer(contact.contact_opt_in);
  if (contact.contact_opt_in && optIn !== 'yes')
    ev.push({
      from: 'the event list',
      sure: optIn === 'no' ? 'exact' : 'fuzzy',
      says:
        optIn === 'no'
          ? `said no on the event's opt-in column`
          : `the event list's "open to meetings" answer is "${String(contact.contact_opt_in).slice(0, 40)}", which isn't a clear yes or no`,
      opt_in: optIn
    });
  // A connected CRM that answered for some people only: the rest wait until they're looked up or cleared.
  if (inputs.crm?.not_found && !ev.some((e) => e.record)) {
    const missed = new Set(inputs.crm.not_found.map((q) => String(q).trim().toLowerCase()));
    const asked =
      (contact.email && missed.has(contact.email)) ||
      missed.has(String(contact.name).trim().toLowerCase()) ||
      missed.has(`${contact.name} ${contact.company}`.trim().toLowerCase());
    if (!asked)
      ev.push({
        from: 'crm',
        sure: 'fuzzy',
        says: 'the CRM lookup gave no answer for them: look them up, or say they aren\'t in the CRM ("<id> not-in-crm")',
        unanswered: true
      });
  }
  const mb = inputs.mailbox?.get?.(contact.email);
  if (mb)
    ev.push({
      from: 'your mailbox',
      sure: 'exact',
      says: mb.they_replied
        ? `in your mailbox already${mb.last_at ? ` (last message ${mb.last_at.slice(0, 10)})` : ''}`
        : `you emailed them before${mb.last_at ? ` (${mb.last_at.slice(0, 10)})` : ''} and they didn't reply`,
      mailbox: mb
    });
  return ev;
}
