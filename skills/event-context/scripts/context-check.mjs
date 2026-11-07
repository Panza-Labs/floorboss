// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Context check: what's thin in the who-to-meet and what-you-bring skills, and what that means.

import { stripAccents } from '../../../lib/normalize.mjs';

// "Hostelería" → "hosteleria": accents are dropped, not turned into dashes.
export const slugOf = (name) =>
  stripAccents(String(name))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// Segments are "## Segment: <name>" headings in who-to-meet.
export function parseSegments(md) {
  const out = [];
  const re = /^##\s+Segment:\s*(.+)$/gim;
  let m;
  const heads = [];
  while ((m = re.exec(md))) heads.push({ name: m[1].trim(), at: m.index, end: re.lastIndex });
  heads.forEach((h, i) => {
    // A segment ends at the next heading of its level or above ("## Not a fit" isn't part of the last segment).
    const rest = md.slice(h.end);
    const next = /^#{1,2}\s/m.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    // A field may wrap onto indented lines below it.
    const field = (label) => {
      // [ \t]* after the label: an empty field must not take the next line as its value.
      const m = new RegExp(`^-\\s*\\*\\*${label}:?\\*\\*:?[ \\t]*(\\S.*(?:\\n[ \\t]+(?!-\\s*\\*\\*).+)*)`, 'im').exec(body);
      return m ? m[1].replace(/\s*\n\s*/g, ' ').trim() : null;
    };
    const must = field('Must meet');
    out.push({
      name: h.name,
      slug: slugOf(h.name),
      who: field('Who'),
      ask: field('Ask'),
      sources: field('Research sources'),
      // Split on commas, semicolons and "and", but not inside brackets ("Mira (Lindqvist Foundation, Oslo)").
      must_meet:
        must && !/^<.*>$/.test(must) && !/^(none|none named|n\/?a|nobody|-|—|tbd|no one)\.?$/i.test(must)
          ? must
              .replace(/\([^)]*\)/g, (m) => m.replace(/[,;]/g, '\u0000'))
              .split(/\s*[,;]\s*|\s+and\s+/)
              .map((x) => x.replace(/\u0000/g, ',').trim())
              .filter(Boolean)
          : [],
      body
    });
  });
  return out;
}

// Proof library: a markdown table with columns claim | source | segments | named | date.
export function parseProof(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^\|\s*claim\s*\|\s*source\s*\|\s*segments\s*\|\s*named\s*\|\s*date\s*\|/i.test(l));
  if (start < 0) return [];
  const rows = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.trim().startsWith('|')) break;
    const cells = l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    rows.push({
      claim: cells[0],
      source: cells[1],
      segments: cells[2].split(/[,;]/).map(slugOf).filter(Boolean),
      named: /^(yes|y|named|true)$/i.test(cells[3]),
      date: cells[4]
    });
  }
  return rows;
}

// "What you know" table: insight | basis | segments | situations.
export function parseInsights(md) {
  const lines = String(md || '').split('\n');
  const start = lines.findIndex((l) => /^\|\s*insight\s*\|\s*basis\s*\|\s*segments\s*\|/i.test(l));
  if (start < 0) return [];
  const rows = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.trim().startsWith('|')) break;
    const cells = l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3 || /^<.*>$/.test(cells[0])) continue;
    rows.push({
      id: `I${rows.length + 1}`,
      insight: cells[0],
      basis: cells[1],
      segments: cells[2].split(/[,;]/).map(slugOf).filter(Boolean),
      situations: cells[3] || ''
    });
  }
  return rows;
}

// How many insights setup asks for. Fewer than this and a batch of 20+ drafts repeats the same points.
export const INSIGHTS_WANTED = Object.freeze({ min: 10, max: 15 });

// No insight goes to more than about a quarter of a batch: one stat in many inboxes reads as mass-sent.
export function insightCap(n) {
  return Math.max(1, Math.round(n / 4));
}

// contacts: [{ id, segment }] for one batch. Warns per segment when its insights are spread too thin
// (more than two contacts per insight), and says roughly how many drafts will fall back to a question.
export function insightBudget(insights, contacts, names = {}) {
  const cap = insightCap(contacts.length);
  const notes = [];
  const bySeg = {};
  // Contacts without a segment aren't counted: no insight is tagged for them, so they get questions anyway.
  for (const c of contacts) if (c.segment) (bySeg[c.segment] ||= []).push(c.id);
  for (const [seg, ids] of Object.entries(bySeg)) {
    const k = insights.filter((x) => x.segments.includes(seg)).length;
    if (ids.length <= 2 * k) continue;
    const questions = Math.max(0, ids.length - k * cap);
    notes.push(
      `${k} insight${k === 1 ? '' : 's'} for ${ids.length} ${names[seg] || seg} contacts: expect repetition.` +
        (questions ? ` Each insight goes to at most ${cap}, so about ${questions} of them will get a question instead.` : '') +
        ' More rows in the "what you know" table fix this.'
    );
  }
  return { cap, notes };
}

export function contextCheck({ whoToMeet, whatYouBring, voice }) {
  const problems = [],
    notes = [];
  const segments = parseSegments(whoToMeet || '');
  if (!segments.length) problems.push('who-to-meet has no "## Segment:" sections, so nobody can be matched to a segment.');
  if (segments.length > 3) problems.push(`who-to-meet has ${segments.length} segments; the limit is 3.`);
  for (const s of segments) {
    if (!s.who) problems.push(`Segment "${s.name}" doesn't say who (the "Who" line).`);
    if (!s.ask) notes.push(`Segment "${s.name}" has no ask; drafts will ask for a 30-minute meeting.`);
  }
  const proof = parseProof(whatYouBring || '');
  if (!proof.length) notes.push('what-you-bring has no proof table: drafts will lead with the problem and make no claims.');
  for (const s of segments) {
    if (proof.length && !proof.some((p) => p.segments.includes(s.slug))) {
      notes.push(`No proof points for the ${s.name} segment: drafts to ${s.name} will lead with the problem only.`);
    }
  }
  const insights = parseInsights(whatYouBring || '');
  if (!insights.length)
    notes.push(
      'what-you-bring has no "what you know that they don\'t" table: drafts will lean on questions, since there\'s nothing new to tell readers. This is the biggest lever on draft quality.'
    );
  else if (insights.length < INSIGHTS_WANTED.min)
    notes.push(
      `what-you-bring has ${insights.length} insight${insights.length === 1 ? '' : 's'} in the "what you know" table; aim for ${INSIGHTS_WANTED.min}–${INSIGHTS_WANTED.max}. With fewer, drafts in a big batch repeat the same few points, and readers who compare notes see a mail merge.`
    );
  for (const s of segments) {
    const n = insights.filter((p) => p.segments.includes(s.slug)).length;
    if (insights.length && !n) notes.push(`No insights for the ${s.name} segment: drafts there will lead with a question.`);
    else if (n && n < 3) notes.push(`Only ${n} insight${n === 1 ? '' : 's'} for the ${s.name} segment: aim for at least three, or drafts there will repeat.`);
  }
  // A tag that names no segment ("cloud-infra" for "cloud-infrastructure-analysts") silently hides a row.
  const slugs = new Set(segments.map((x) => x.slug));
  const unknown = [...new Set([...proof, ...insights].flatMap((r) => r.segments).filter((t) => t && !slugs.has(t)))];
  if (unknown.length && segments.length)
    problems.push(
      `These segment tags in what-you-bring match no segment, so their rows are never used: ${unknown.join(', ')}. The segments are: ${[...slugs].join(', ')}.`
    );
  const anon = proof.filter((p) => !p.named);
  if (anon.length) notes.push(`${anon.length} proof point(s) are anonymous: drafts describe the customer, never name it.`);
  if (!/sign-?off/i.test(voice || '')) notes.push("voice has no sign-off line; drafts will end with the sender's first name.");
  return { segments: segments.map(({ body, ...rest }) => rest), proof, insights, problems, notes };
}
