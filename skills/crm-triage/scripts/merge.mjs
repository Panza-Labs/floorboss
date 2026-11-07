// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// One person, one contact. Rows of the attendee list that are the same person (two registrations, a work
// and a personal address, "Jon" and "Jonathan", an initial, a typo) are merged before anything else looks at
// them, so a hold on one row covers the other, and nobody gets two first messages. Ids come from the
// ledger's person entries and never change.
import {
  companyKey,
  emailDomain,
  isSharedDomain,
  normEmail,
  normPersonName,
  nameMatchKey,
  sameName,
  companyRelated,
  levenshtein,
  hasSurname
} from '../../../lib/normalize.mjs';

const profileKey = (url) => {
  const u = String(url || '')
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  return /(^|\.)linkedin\.com\/(in|pub)\/[^/]+|\/(in|people|person|profiles?|users?|u|speakers?|attendees?|members?|participants?|delegates?|team)\/[^/]+$/.test(
    u
  )
    ? u
    : null;
};
const SHARED_INBOX =
  /^(info|hello|hi|contact|team|office|sales|press|media|tips|news|admin|support|enquiries|inquiries|jobs|careers|hr|marketing|events|partnerships|mail|post|service|kontakt|redaktion|presse|vertrieb|buero)@/i;

// Rows → contacts. Each contact: name, title, company, company_key, email, emails[], phone, profile_url,
// notes, location, booth, attendee_type, contact_opt_in, lines[], merge_why[]. Rows with a company and no
// name go to the visit list; rows with neither are skipped.
export function mergeRows(rows, { sharedDomains = [] } = {}) {
  const people = [],
    visit = [],
    skipped = [];
  for (const raw of rows) {
    const r = { ...raw, email: normEmail(raw.email) || '', company_key: raw.company ? companyKey(raw.company) : null };
    if (!r.name && r.company) {
      visit.push(r);
      continue;
    }
    if (!r.name || !r.company) {
      skipped.push({ line: r.line, reason: 'missing name or company' });
      continue;
    }
    people.push(r);
  }
  // Company spellings that share a work domain belong together ("Acme" and "Acme Labs" at acme.com).
  const byDomain = new Map();
  for (const r of people) {
    const d = emailDomain(r.email);
    if (d && !isSharedDomain(d, sharedDomains) && r.company_key) (byDomain.get(d) || byDomain.set(d, new Set()).get(d)).add(r.company_key);
  }
  const sameCompany = (a, b) =>
    !!a.company_key &&
    !!b.company_key &&
    (a.company_key === b.company_key ||
      companyRelated(a.company_key, b.company_key) ||
      [...byDomain.values()].some((set) => set.has(a.company_key) && set.has(b.company_key)));
  // Union-find over rows.
  const parent = people.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const whys = {};
  const union = (i, j, why) => {
    const a = find(i),
      b = find(j);
    if (a === b) return;
    parent[b] = a;
    (whys[a] ||= []).push(...(whys[b] || []), why);
  };
  // 1. The same personal address (a shared inbox is not a person).
  const byEmail = new Map();
  people.forEach((r, i) => {
    if (r.email && !SHARED_INBOX.test(r.email)) {
      if (byEmail.has(r.email)) union(byEmail.get(r.email), i, `same address ${r.email}`);
      else byEmail.set(r.email, i);
    }
  });
  // 2. The same personal profile link.
  const byProfile = new Map();
  people.forEach((r, i) => {
    const k = profileKey(r.profile_url);
    if (k) {
      if (byProfile.has(k)) union(byProfile.get(k), i, `same profile ${k}`);
      else byProfile.set(k, i);
    }
  });
  // 3. The same name at the same or a related company; a nickname, an initial or a small typo of the same
  //    surname at the same company. Two different personal addresses don't stop a merge (work and private).
  const bySurname = new Map();
  people.forEach((r, i) => {
    const w = nameMatchKey(r.name).split(' ').filter(Boolean);
    if (w.length > 1) (bySurname.get(w[w.length - 1]) || bySurname.set(w[w.length - 1], []).get(w[w.length - 1])).push(i);
  });
  for (const idx of bySurname.values()) {
    for (let x = 0; x < idx.length; x++)
      for (let y = x + 1; y < idx.length; y++) {
        const a = people[idx[x]],
          b = people[idx[y]];
        if (!sameCompany(a, b)) continue;
        const fa = nameMatchKey(a.name).split(' ')[0],
          fb = nameMatchKey(b.name).split(' ')[0];
        const exact = nameMatchKey(a.name) === nameMatchKey(b.name) || normPersonName(a.name) === normPersonName(b.name);
        const nick = sameName(a.name, b.name, { initials: true });
        const typo = fa.length >= 3 && fb.length >= 3 && fa[0] === fb[0] && levenshtein(fa, fb) <= 2;
        if (exact) union(idx[x], idx[y], `same name at ${a.company}`);
        else if (nick) union(idx[x], idx[y], `${a.name} / ${b.name} at ${a.company} (nickname or initial)`);
        else if (typo) union(idx[x], idx[y], `${a.name} / ${b.name} at ${a.company} (spelling)`);
      }
  }
  const groups = new Map();
  people.forEach((r, i) => (groups.get(find(i)) || groups.set(find(i), []).get(find(i))).push(r));
  const contacts = [];
  for (const [root, grp] of groups) {
    grp.sort((a, b) => a.line - b.line);
    const first = grp[0];
    const pick = (f) => grp.map((r) => r[f]).find(Boolean) || '';
    // The fullest name (with accents, with a surname) represents the person.
    const name = grp
      .map((r) => r.name)
      .sort((a, b) => hasSurname(b) - hasSurname(a) || /[^\x00-\x7f]/.test(b) - /[^\x00-\x7f]/.test(a) || b.length - a.length)[0];
    const emails = [...new Set(grp.map((r) => r.email).filter(Boolean))];
    const work = emails.find((e) => !isSharedDomain(emailDomain(e), sharedDomains)) || emails[0] || '';
    const optIns = grp.map((r) => r.contact_opt_in).filter(Boolean);
    contacts.push({
      name,
      title: pick('title'),
      company: first.company,
      company_key: first.company_key,
      email: work,
      emails,
      phone: String(pick('phone'))
        .replace(/[^\d+]/g, '')
        .slice(0, 20),
      profile_url: pick('profile_url'),
      notes: [...new Set(grp.map((r) => r.notes).filter(Boolean))].join(' | '),
      location: pick('location'),
      booth: pick('booth'),
      attendee_type: pick('attendee_type'),
      // Two registrations, one says no to contact: the no wins.
      contact_opt_in: optIns.find((v) => /^(no|n|false|0|off|nein|non|não|declined?|opted[- ]?out)$/i.test(v)) || optIns[0] || '',
      lines: grp.map((r) => r.line),
      merge_why: [...new Set(whys[root] || [])],
      researchable: hasSurname(name) || !!work
    });
  }
  // Company-only rows: one visit entry per company.
  const seen = new Set(),
    visitOut = [];
  for (const v of visit) {
    if (seen.has(v.company_key)) continue;
    seen.add(v.company_key);
    visitOut.push({ company: v.company, company_key: v.company_key, booth: v.booth || '', notes: v.notes || '' });
  }
  return { contacts, visit: visitOut, skipped };
}

// Keys that identify a person across loads: each address, the personal profile link, and name + company.
export function personKeys(c, shared = new Set()) {
  // A shared inbox (sales@, or one address on two people the merge kept apart) says nothing about who it is.
  const keys = (c.emails || [c.email]).filter((e) => e && !SHARED_INBOX.test(e) && !shared.has(e)).map((e) => `e:${e}`);
  const pk = profileKey(c.profile_url);
  if (pk) keys.push(`u:${pk}`);
  if (c.name && c.company_key) keys.push(`n:${normPersonName(c.name)}|${c.company_key}`);
  return keys;
}

// Give each contact its id: an existing person entry that shares a key, else the next number. Returns the
// contacts with ids plus the new person entries to append, and merges of two earlier ids into one.
export function assignIds(contacts, people) {
  const byKey = new Map();
  let max = 0;
  for (const [id, p] of Object.entries(people)) {
    if (p.merged_into) continue;
    for (const k of p.keys || []) byKey.set(k, id);
    max = Math.max(max, Number(id.slice(1)) || 0);
  }
  const entries = [],
    merges = [];
  const taken = new Set();
  const seen = new Map();
  for (const c of contacts) for (const e of new Set((c.emails || [c.email]).filter(Boolean))) seen.set(e, (seen.get(e) || 0) + 1);
  const shared = new Set([...seen].filter(([, n]) => n > 1).map(([e]) => e));
  for (const c of contacts) {
    const keys = personKeys(c, shared);
    const hits = [...new Set(keys.map((k) => byKey.get(k)).filter(Boolean))].sort();
    let id;
    if (hits.some((h) => !taken.has(h))) {
      id = hits.find((h) => !taken.has(h));
      // Two earlier people turned out to be one (this list's rows were merged): the later id points at the
      // earlier one. Without that evidence, a key that happens to match two people merges nobody.
      for (const other of (c.merge_why || []).length ? hits.filter((h) => h !== id && !taken.has(h)) : []) {
        merges.push({ id: other, into: id, why: c.merge_why.join('; ') || 'same person on this list' });
        for (const k of people[other]?.keys || []) byKey.set(k, id);
      }
    } else id = `c${String(++max).padStart(3, '0')}`;
    taken.add(id);
    const known = new Set(people[id]?.keys || []);
    const newKeys = keys.filter((k) => !known.has(k));
    if (!people[id] || newKeys.length || people[id].name !== c.name || (people[id].email || '') !== (c.email || ''))
      entries.push({ type: 'person', who: 'floorboss', id, keys: keys, name: c.name, company: c.company, email: c.email || null, lines: c.lines });
    for (const k of keys) byKey.set(k, id);
    c.id = id;
  }
  return { contacts, entries, merges };
}

// One CRM, read two ways: the records a connected CRM returned for the list, and the export the user gave too.
// A lookup returns what its tool shows (often no notes, deals or labels); the export fills those in for the same
// person (same address, else same name at the same company). A stop in either holds: opted out in either is
// opted out, either's stop note stands, and every status of both is kept with its meaning. Export rows the lookup
// didn't return are kept after the looked-up ones, so the looked-up rows keep their places (a "crm:<row>" answer).
export function mergeCrmRows(lookedUp, exported) {
  const used = new Set();
  const nameAt = (a, b) => {
    const ka = a.company ? companyKey(a.company) : null,
      kb = b.company ? companyKey(b.company) : null;
    return !!(a.name && b.name && normPersonName(a.name) === normPersonName(b.name) && ka && kb && (ka === kb || companyRelated(ka, kb)));
  };
  const blank = (v) => v == null || String(v).trim() === '';
  let filled = 0;
  const rows = lookedUp.map((r) => {
    const email = normEmail(r.email);
    const x = exported.find((e, i) => !used.has(i) && email && normEmail(e.email) === email) || exported.find((e, i) => !used.has(i) && nameAt(r, e));
    if (!x) return r;
    used.add(exported.indexOf(x));
    const notes = [...new Set([r.notes, x.notes].map((n) => String(n || '').trim()).filter(Boolean))].join(' | ');
    const statuses = [...(r.statuses || [])],
      meanings = [...(r.meanings || [])];
    (x.statuses || []).forEach((s, i) => {
      if (!statuses.includes(s)) {
        statuses.push(s);
        meanings.push(x.meanings[i]);
      }
    });
    const out = { ...r, notes, statuses, meanings, status: r.status || x.status || '', from_export: x.line };
    for (const k of ['name', 'email', 'company', 'title', 'owner', 'profile_url', 'crm_id', 'phone', 'company_size'])
      if (blank(out[k]) && !blank(x[k])) out[k] = x[k];
    for (const k of ['deal', 'deal_stage', 'deal_state', 'won_at', 'rejected_at', 'on_won_deal'])
      if ((blank(out[k]) || out[k] === false) && !blank(x[k])) out[k] = x[k];
    out.last_contact = [r.last_contact, x.last_contact].filter(Boolean).sort().pop() || null;
    out.opted_out = !!(r.opted_out || x.opted_out);
    out.stop_note = r.stop_note || x.stop_note || null;
    out.caution_note = r.caution_note || x.caution_note || null;
    if (notes !== String(r.notes || '').trim() || statuses.length > (r.statuses || []).length || (!r.deal_state && x.deal_state)) filled++;
    return out;
  });
  return { rows: [...rows, ...exported.filter((e, i) => !used.has(i))], matched: used.size, filled };
}
