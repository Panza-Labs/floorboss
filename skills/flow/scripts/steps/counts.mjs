// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// What a question or a step says about the data, counted from the files and the ledger: coworkers' contacts,
// customers, lost deals, earlier research, failed tries at a draft, ratings that still stand.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { readLedger } from '../../../../lib/ledger.mjs';
import { listSources, fingerprint, applyMapping } from '../../../crm-triage/scripts/sources.mjs';
import { readCsv } from '../../../../lib/csv.mjs';
import { companyKey, companyRelated } from '../../../../lib/normalize.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { listEvents } from '../../../../lib/scope.mjs';
import { contextFor } from '../../../../lib/event.mjs';
import { criticFailCount } from '../../../event-outreach/scripts/commands/saved-drafts.mjs';

// Per coworker (every CRM owner but the user): their records in the CRM export, and how many of them are on the
// attendee list (matched by email). Null when there's no CRM file or no confirmed mapping to read it with.
// Companies researched for another event in the last two weeks, said in the research heads-up: "refresh" looks
// them up again, "skip" uses that research.
export function earlierLine(todo) {
  const by = {};
  for (const x of todo.filter((t) => t.researched_earlier)) {
    const k = `${x.researched_earlier.event}|${x.researched_earlier.days_ago}`;
    (by[k] ||= { ...x.researched_earlier, names: [] }).names.push(x.company);
  }
  const ago = (d) => (d === 0 ? 'earlier today' : d === 1 ? 'yesterday' : `${d} days ago`);
  const groups = Object.values(by);
  return groups.length
    ? ` ${groups.map((g) => `${g.names.length === todo.length ? (todo.length === 1 ? 'It was' : 'All of them were') : `${g.names.join(', ')} ${g.names.length === 1 ? 'was' : 'were'}`} researched ${ago(g.days_ago)} for ${g.event}`).join('; ')}: refresh, or skip (and use that research)?`
    : '';
}

// What the tries at one message ran into, counted from the ledger since the user's last word on it ("1 check fail
// and 1 critic fail"), never a bare count of tries. Empty when nothing failed.
export function failCounts(entries, id, touch) {
  let checks = 0;
  for (const x of entries) {
    if (x.id !== id || (x.touch ?? 1) !== touch) continue;
    if (x.type === 'revise' || x.type === 'fresh_attempt') checks = 0;
    if (x.type === 'drafted' && (x.checks || []).length) checks++;
  }
  // Critic fails, never fewer than the hold counts (event-outreach criticFails: a rewrite saved back as the very text
  // that failed is another fail). Each FAIL verdict counts too, except the same text read again with no save between
  // (its hash the last FAIL's): an older verdict line without a hash can't be told apart, so it counts.
  let verdicts = 0,
    lastFail = null;
  for (const x of entries) {
    if (x.id !== id || (x.touch ?? 1) !== touch) continue;
    if (x.type === 'revise' || x.type === 'fresh_attempt') {
      verdicts = 0;
      lastFail = null;
    } else if (x.type === 'drafted') lastFail = null;
    else if (x.type === 'critic' && x.verdict === 'FAIL') {
      if (!(x.hash && lastFail && x.hash === lastFail)) verdicts++;
      lastFail = x.hash || null;
    }
  }
  const critic = Math.max(verdicts, criticFailCount(entries, id, touch));
  return [checks ? plural(checks, 'check fail') : null, critic ? plural(critic, 'critic fail') : null].filter(Boolean).join(' and ');
}

// The name of another (real) event of the user's with a confirmed CRM layout, or null.
export function crmLayoutElsewhere(e) {
  try {
    const root = join(e.paths.dir, '..');
    for (const slug of readdirSync(root)) {
      if (slug === e.event.slug) continue;
      const ev = readJson(join(root, slug, 'event.json'), null);
      if (ev && !ev.mock && listSources(join(root, slug)).some((m) => m.kind === 'crm' && m.confirmed)) return ev.name || slug;
    }
  } catch {
    /* no other events */
  }
  return null;
}

export function coworkerCounts(c) {
  const e = c.event;
  if (!e?.inputs?.crm) return null;
  try {
    const t = readCsv(e.inputs.crm);
    const m = listSources(e.paths.dir).find((x) => x.kind === 'crm' && x.fingerprint === fingerprint(t.headers));
    if (!m) return null;
    const emails = new Set(
      e.inputs.attendees
        ? readCsv(e.inputs.attendees)
            .records.flatMap((r) => Object.values(r))
            .map((v) => String(v).trim().toLowerCase())
            .filter((v) => v.includes('@'))
        : []
    );
    const me = String(c.cfg.crm_user_name || '').toLowerCase();
    const by = {};
    const rows = applyMapping(t.records, m);
    for (const r of rows) {
      if (!r.owner || r.owner.toLowerCase() === me) continue;
      const x = (by[r.owner] ||= { owner: r.owner, records: 0, on_list: 0, through_accounts: 0, companies: new Set(), emails: new Set() });
      x.records++;
      if (r.company) x.companies.add(companyKey(r.company));
      if (r.email) x.emails.add(String(r.email).toLowerCase());
      if (r.email && emails.has(r.email)) x.on_list++;
    }
    // Everyone else on the list at a company where they own records: held through the account too (unless the
    // user said a coworker's records don't cover the rest of the company, crm_accounts "off").
    const am =
      e.inputs.attendees && c.cfg.crm_accounts !== 'off'
        ? (() => {
            const lt = readCsv(e.inputs.attendees);
            const lm = listSources(e.paths.dir).find((x) => x.kind === 'attendees' && x.fingerprint === fingerprint(lt.headers));
            return lm ? applyMapping(lt.records, lm) : [];
          })()
        : [];
    for (const x of Object.values(by))
      x.through_accounts = am.filter(
        (p) => p.company && !(p.email && x.emails.has(String(p.email).toLowerCase())) && [...x.companies].some((k) => companyRelated(companyKey(p.company), k))
      ).length;
    return Object.values(by)
      .map(({ companies, emails: _e, through_accounts, ...x }) => ({ ...x, ...(through_accounts ? { through_accounts } : {}) }))
      .sort((a, b) => b.on_list - a.on_list || b.records - a.records);
  } catch {
    return null;
  }
}

// The people on the attendee list at the user's own customers (a CRM record of theirs, or with no owner, whose
// status means customer), by company, matched by company name. Null when the CRM or the list can't be read yet.
export function customerCounts(c) {
  const e = c.event;
  if (!e?.inputs?.crm || !e.inputs.attendees) return null;
  try {
    const mapped = (file, kind) => {
      const t = readCsv(file);
      const m = listSources(e.paths.dir).find((x) => x.kind === kind && x.fingerprint === fingerprint(t.headers));
      return m ? applyMapping(t.records, m) : null;
    };
    const crm = mapped(e.inputs.crm, 'crm'),
      list = mapped(e.inputs.attendees, 'attendees');
    if (!crm || !list) return null;
    const me = String(c.cfg.crm_user_name || '').toLowerCase();
    const customers = new Map();
    for (const r of crm)
      if (r.company && (!r.owner || r.owner.toLowerCase() === me) && (r.meanings.includes('customer') || r.won_at))
        customers.set(companyKey(r.company), r.company);
    const companies = [...customers]
      .map(([key, company]) => ({ company, names: list.filter((p) => p.name && p.company && companyRelated(companyKey(p.company), key)).map((p) => p.name) }))
      .filter((x) => x.names.length);
    return { people: companies.reduce((n, x) => n + x.names.length, 0), companies };
  } catch {
    return null;
  }
}

// The people on the attendee list with a lost deal or a rejection in the CRM export (matched by email, else by
// name and company), with the latest date that counts for the lost-deals window. Null when it can't be read yet.
export function lostCounts(c) {
  const e = c.event;
  if (!e?.inputs?.crm || !e.inputs.attendees) return null;
  try {
    const mapped = (file, kind) => {
      const t = readCsv(file);
      const m = listSources(e.paths.dir).find((x) => x.kind === kind && x.fingerprint === fingerprint(t.headers));
      return m ? applyMapping(t.records, m) : null;
    };
    const crm = mapped(e.inputs.crm, 'crm'),
      list = mapped(e.inputs.attendees, 'attendees');
    if (!crm || !list) return null;
    const low = (x) =>
      String(x || '')
        .trim()
        .toLowerCase();
    const out = [];
    for (const p of list) {
      const rows = crm.filter((r) =>
        p.email && r.email
          ? low(p.email) === low(r.email)
          : p.name && low(p.name) === low(r.name) && p.company && r.company && companyRelated(companyKey(p.company), companyKey(r.company))
      );
      const hit = rows.filter((r) => r.rejected_at || (r.meanings || []).includes('lost') || r.deal_state === 'lost');
      if (!hit.length) continue;
      const at =
        hit
          .map((r) => r.rejected_at || r.last_contact)
          .filter(Boolean)
          .sort()
          .pop() || null;
      out.push({ name: p.name, why: hit.some((r) => r.rejected_at) ? 'rejected' : 'lost deal', at });
    }
    return out;
  } catch {
    return null;
  }
}

// Ratings given at an earlier event stand while the voice they rated hasn't changed since: the blind set isn't
// asked again for nothing. Returns that event's name, or null.
export function ratingsCarry(e) {
  try {
    const vf = contextFor(e.settings, e.event).dir ? join(contextFor(e.settings, e.event).dir, 'voice', 'SKILL.md') : null;
    const voiceAt = vf && existsSync(vf) ? statSync(vf).mtimeMs : 0;
    for (const ev of listEvents()) {
      if (ev.slug === e.event.slug) continue;
      const rated = readLedger(join(e.paths.dir, '..', ev.slug, 'ledger.jsonl')).entries.filter((x) => x.type === 'copy_rating');
      const at = Math.max(0, ...rated.map((x) => Date.parse(x.at)));
      if (rated.length && at >= voiceAt) return ev.name;
    }
  } catch {
    /* no earlier ratings */
  }
  return null;
}

// The draft answer's shape, with fact_source drawn from the jobs' own fact_sources: the checks refuse any
// other value, so the format never offers one they'd refuse.
export function draftFormat(list) {
  const facts = [...new Set(list.flatMap((j) => j.fact_sources || []))];
  const fs = facts.length ? `"<one of that job's own fact_sources (in this batch: ${facts.join(', ')})>"` : '"none"';
  return `[{"id","touch","subject","body","brief","insight":"I3"|null,"structure":"<the job's structure: question-first|insight-first|plain-request|peer-note>","fact_source":${fs}}]`;
}

// Has the message before this follow-up (j.previous_touch_now, a skipped step passed over) been rewritten since it was
// written? The hashes are the ledger's save, as in outreach's staleFor: previous_hash alone says nothing past a skip.
// A save that recorded that message as having no text yet counts as written for no version of it.
export function rewrittenSince(x, d, j) {
  const beforeNow = j.previous_touch_now ?? j.touch - 1;
  const map = x?.before_hashes;
  if (j.touch > 1 && j.previous_hash_now && map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, beforeNow) && map[beforeNow] == null) return true;
  const writtenFor = x?.before_hashes?.[beforeNow] ?? (beforeNow === j.touch - 1 ? (x?.previous_hash ?? d?.previous_hash) : null);
  return !!(j.touch > 1 && writtenFor && j.previous_hash_now && writtenFor !== j.previous_hash_now);
}

// Critic fails on a message as the hold counts them (event-outreach criticFails): once per save, so a draft the flow
// stops writing again is one the hold holds, and said.
export function countFails(e, j) {
  return criticFailCount(e.entries, j.id, j.touch);
}
