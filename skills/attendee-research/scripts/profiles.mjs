// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Research profiles: one markdown file per contact, every claim with a source URL.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeText } from '../../../lib/jsonio.mjs';
import { safeUrl } from '../../../lib/escape.mjs';

export const profilePath = (dir, id) => join(dir, 'profiles', `${id}.md`);

const metaPath = (dir, id) => join(dir, 'profiles', `${id}.json`);
// What research found out about the research itself: whether the person's identity at their company was
// confirmed, the role their own latest source gives, and whether the search finished (a run cut short by
// its search budget leaves a thin profile that the next plan picks up again).
export function profileMeta(dir, id) {
  if (!existsSync(metaPath(dir, id))) return null;
  try {
    return JSON.parse(readFileSync(metaPath(dir, id), 'utf8'));
  } catch {
    return null;
  }
}

// A finished profile. One cut short (complete: false) is researched again on the next run.
export function hasProfile(dir, id) {
  if (!existsSync(profilePath(dir, id))) return false;
  const m = profileMeta(dir, id);
  // Cut short twice: what's there is what there is (a person with no public footprint never "finishes").
  return !m || m.complete !== false || (m.attempts || 1) >= 2;
}

export function readProfile(dir, id) {
  return existsSync(profilePath(dir, id)) ? readFileSync(profilePath(dir, id), 'utf8') : null;
}

// result: { summary?, claims: [{ text, url }] }. Claims without a usable URL are rejected.
export function writeProfile(dir, contact, result) {
  const claims = Array.isArray(result?.claims) ? result.claims : [];
  const kept = [],
    rejected = [];
  for (const c of claims) {
    const url = safeUrl(c?.url);
    const text = String(c?.text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    // Professional information only: personal life never goes into a profile a draft can draw on.
    const personal =
      /\b(honeymoon|wedding|married|engaged|divorce|pregnan|baby|newborn|children|kids|daughter|son|husband|wife|partner's|funeral|died|passed away|illness|cancer|diagnos|hospital|religio|church|mosque|synagogue|vacation|holiday photos?|birthday|dating|running route|marathon|half-marathon|strava|personal best|workout|gym|home address|neighbou?rhood)\b/i;
    // The company's own name doesn't count ("Little Sprout Kids" is a company, not someone's children).
    const withoutCompany = contact.company ? text.split(contact.company).join(' ') : text;
    const routine = /\bruns?\b.{0,40}\broute\b|\b\d+ ?k\b.{0,20}\b(run|route|race)\b|\bjog(s|ging)?\b/i;
    if (text && (personal.test(withoutCompany) || routine.test(withoutCompany))) rejected.push({ ...c, why: 'personal, not professional' });
    else if (kept.length >= 8) rejected.push({ ...c, why: 'more than eight claims' });
    else if (text && url && /^https?:/.test(url)) kept.push({ text: text.length > 300 ? `${text.slice(0, 299)}…` : text, url });
    else rejected.push(c);
  }
  const identity = result?.identity_confirmed === true;
  const role = String(result?.role_seen ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const lines = [`# ${contact.name}`, '', `${contact.title || 'Title unknown'}, ${contact.company}`, ''];
  lines.push(
    identity
      ? 'Identity: confirmed at this company.'
      : "Identity: NOT confirmed at this company. A note may use what the company is doing (that's still a real reason to write), but mustn't state or rely on their own title or role; the user checks their profile before sending."
  );
  if (role && role.toLowerCase() !== String(contact.title || '').toLowerCase())
    lines.push(`Their own latest source gives their role as: ${role} (the list says ${contact.title || 'nothing'}).`);
  lines.push('');
  if (result?.note) lines.push(`Note from research: ${String(result.note).replace(/\s+/g, ' ').trim().slice(0, 400)}`, '');
  if (kept.length) {
    lines.push('## Claims (each with its source)', '');
    for (const c of kept) lines.push(`- ${c.text} [${c.url}]`);
  } else {
    lines.push('Nothing usable found in public sources. A reason can still come from role and company.');
  }
  writeText(profilePath(dir, contact.id), lines.join('\n') + '\n');
  const meta = {
    identity_confirmed: identity,
    role_seen: role || null,
    claims: kept.length,
    person_claims: Number.isInteger(result?.person_claims) ? result.person_claims : null,
    complete: result?.complete !== false,
    attempts: (profileMeta(dir, contact.id)?.attempts || 0) + 1,
    saved_at: new Date().toISOString()
  };
  writeText(metaPath(dir, contact.id), JSON.stringify(meta, null, 2) + '\n');
  return {
    kept: kept.length,
    rejected: rejected.length,
    identity_confirmed: identity,
    complete: meta.complete,
    ...(role && role.toLowerCase() !== String(contact.title || '').toLowerCase() ? { role_differs: role } : {})
  };
}
