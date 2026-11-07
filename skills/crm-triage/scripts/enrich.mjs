// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Contact details for people floorboss wants to reach by email or LinkedIn but whose list row has neither.
// The CRM is checked first, for free: an email or LinkedIn link already on their record is used as is.
// Only who's still missing goes to an enrichment tool (Clay, Apollo…), which costs credits per lookup:
// as a CSV the user imports, or through the tool's MCP after the user says yes to the count.
// Found details live in enriched.json and are laid over the attendee list on every load.
import { normPersonName, companyKey, normEmail, sameName, emailDomain, isSharedDomain } from '../../../lib/normalize.mjs';

export const enrichKey = (name, company) => `${normPersonName(name || '')}|${companyKey(company || '') || ''}`;
const LINKEDIN = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?$/i;
export const isLinkedIn = (u) => LINKEDIN.test(String(u || '').trim());

// ids: who to look at. want: {email, linkedin}. crmOf(id): the matched CRM record's {email, profile_url}.
// have: existing enriched entries by key. Returns { fromCrm: [entries], toEnrich: [rows], complete }.
// A person a tool found nothing for (not_found_at) isn't looked up again for 90 days: each try can cost a credit.
export function planEnrich(ids, { byId, want, crmOf, have, today = null }) {
  const fromCrm = [],
    toEnrich = [];
  let complete = 0,
    notFoundBefore = 0;
  for (const id of ids) {
    const c = byId[id];
    if (!c) continue;
    const key = enrichKey(c.name, c.company);
    const prior = have[key] || {};
    const email = c.email || prior.email || null;
    const link = isLinkedIn(c.profile_url) ? c.profile_url : prior.profile_url || null;
    // Only a confirmed CRM match counts: copying the email of an uncertain match would confirm it by itself.
    const crm = crmOf(id) || {};
    const fill = {};
    if (want.email && !email && crm.email) fill.email = crm.email;
    if (want.linkedin && !link && isLinkedIn(crm.profile_url)) fill.profile_url = crm.profile_url;
    if (Object.keys(fill).length) fromCrm.push({ key, id, ...fill, source: 'crm' });
    const needs = [];
    if (want.email && !email && !fill.email) needs.push('email');
    if (want.linkedin && !link && !fill.profile_url) needs.push('linkedin');
    if (!needs.length) {
      complete++;
      continue;
    }
    if (prior.not_found_at && (!today || (Date.parse(today) - Date.parse(prior.not_found_at)) / 864e5 < 90)) {
      notFoundBefore++;
      continue;
    }
    const [first, ...rest] = String(c.name).trim().split(/\s+/);
    toEnrich.push({
      floorboss_id: id,
      first_name: first || '',
      last_name: rest.join(' '),
      full_name: c.name,
      title: c.title || '',
      company: c.company || '',
      company_domain: c.email ? String(c.email).split('@')[1] : '',
      linkedin_url: link || '',
      needs: needs.join(' ')
    });
  }
  return { fromCrm, toEnrich, complete, notFoundBefore };
}

// An enrichment tool's export (CSV rows or JSON) → entries. Rows are matched by floorboss_id; values are
// checked (a real address, a LinkedIn profile link) and never replace what the list or CRM already has.
const EMAIL_COLS = ['email', 'workemail', 'emailaddress', 'businessemail', 'professionalemail', 'validatedemail', 'finalemail', 'foundemail'];
const LINK_COLS = ['linkedinurl', 'linkedin', 'linkedinprofile', 'linkedinprofileurl', 'personlinkedinurl', 'profileurl'];
const norm = (h) =>
  String(h)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
// domainsOf(contact): the email domains already seen for that person's company (from the list). An email
// at another company's domain is held for the user to check: an export can be wrong, or poisoned.
export function readEnriched(rows, { byId, source, domainsOf = () => [], accept = new Set() }) {
  const errors = [],
    entries = [],
    check = [];
  let emails = 0,
    links = 0,
    empty = 0;
  rows.forEach((r, i) => {
    const cols = Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), String(v ?? '').trim()]));
    const id = cols.floorbossid;
    if (!id) {
      errors.push(`row ${i + 2}: no floorboss_id (keep that column from floorboss's list when you export)`);
      return;
    }
    const c = byId[id];
    if (!c) {
      errors.push(`row ${i + 2}: ${id} isn't on this event's list`);
      return;
    }
    // The row must be about the person its id names: an export with shuffled or edited ids would put one
    // person's address on another.
    const rowName = cols.fullname || cols.name || [cols.firstname, cols.lastname].filter(Boolean).join(' ');
    if (!rowName) {
      errors.push(`row ${i + 2}: no name column (keep full_name, or first_name and last_name, from floorboss's list)`);
      return;
    }
    if (!sameName(rowName, c.name)) {
      errors.push(`row ${i + 2}: ${id} is ${c.name} on the list, but this row is "${rowName.slice(0, 60)}"`);
      return;
    }
    const rawEmail = EMAIL_COLS.map((k) => cols[k]).find(Boolean) || '';
    const rawLink = LINK_COLS.map((k) => cols[k]).find(Boolean) || '';
    const e = {};
    if (rawEmail && !c.email) {
      const n = normEmail(rawEmail);
      if (!n || /^[=+\-@]/.test(n)) errors.push(`row ${i + 2}: "${rawEmail.slice(0, 60)}" isn't an email address`);
      else {
        // A webmail address someone else at the company uses says nothing about the company's own domain.
        const known = domainsOf(c).filter((x) => !isSharedDomain(x));
        const dom = emailDomain(n);
        // Webmail too: a gmail address for someone whose company has a known domain is exactly what a poisoned
        // export would give, so it waits for the user like any other address off the company's domains.
        if (known.length && !known.includes(dom) && !accept.has(id)) check.push({ id, name: c.name, company: c.company, email: n, known_domains: known });
        else {
          e.email = n;
          emails++;
        }
      }
    }
    if (rawLink && !isLinkedIn(c.profile_url)) {
      if (isLinkedIn(rawLink)) {
        e.profile_url = rawLink;
        links++;
      } else errors.push(`row ${i + 2}: "${rawLink.slice(0, 60)}" isn't a LinkedIn profile link`);
    }
    if (!Object.keys(e).length) {
      empty++;
      return;
    }
    entries.push({ key: enrichKey(c.name, c.company), id, ...e, source });
  });
  return { errors, entries, emails, links, empty, check };
}

// The load step: fill a list row's missing email or profile link from enriched.json.
export function overlay(rows, enriched) {
  let filled = 0;
  const out = rows.map((r) => {
    const e = enriched[enrichKey(r.name || [r.first_name, r.last_name].filter(Boolean).join(' '), r.company)];
    if (!e) return r;
    const add = {};
    if (!r.email && e.email) add.email = e.email;
    if (!isLinkedIn(r.profile_url) && e.profile_url) add.profile_url = e.profile_url;
    if (!Object.keys(add).length) return r;
    filled++;
    return { ...r, ...add, enriched_from: e.source };
  });
  return { rows: out, filled };
}
