// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The profile's files written from structured answers, so a confirmed answer is never left as the blank
// template.
const PLACEHOLDER = /<[^>\n]{2,}>/;
// One line of text: control characters go too (they survive \s), and nothing longer than a long paragraph.
const clean = (x) =>
  String(x ?? '')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
    .slice(0, 600);
const slug = (x) =>
  clean(x)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

// segs: [{name, who, why?, cares?, how?, ask?}]: at least a name and who for each, up to three.
export function segmentsMd(goal, segs) {
  // A group given as one line ("Product leaders: VPs of Product at SaaS companies") is split at the colon.
  const asObj = (s) => (typeof s === 'string' ? (/:/.test(s) ? { name: s.split(':')[0], who: s.split(':').slice(1).join(':') } : { name: s, who: s }) : s);
  const list = (Array.isArray(segs) ? segs : [])
    .map(asObj)
    .filter((s) => clean(s?.name) && clean(s?.who))
    .slice(0, 3);
  if (!list.length)
    throw new Error('Give the groups as "segments": [{"name","who":"<roles and company types>","how"?:"<how to write to them>","ask"?:"<20 minutes>"}].');
  for (const s of list)
    if (PLACEHOLDER.test(`${s.name} ${s.who}`))
      throw new Error(`The group "${clean(s.name)}" still has a template placeholder in it: write it in the user's terms.`);
  const field = (k, v) => (clean(v) ? `- **${k}:** ${clean(v)}\n` : '');
  return (
    `---\nname: who-to-meet\ndescription: Who I want to meet at events, by segment, and how to write to each. Used by floorboss and by any agent writing outreach for me.\n---\n\n# Who to meet\n\nGoal: ${clean(goal)}\n\n` +
    list
      .map(
        (s) =>
          `## Segment: ${slug(s.name)}\n${field('Who', s.who)}${field('Why they matter', s.why)}${field('Cares about', s.cares)}${field('How to write', s.how)}${field('Ask', s.ask || '20 minutes')}`
      )
      .join('\n')
  );
}

// o: {one_sentence, problems?: {"<segment>": "<problem>"}, gets?, proof?: [{claim, source, segments, named, date}],
// never_say?: [..], about_me?}. Anything not given keeps the template's line out rather than its placeholder.
export function bringMd(o) {
  if (!clean(o?.one_sentence) && !clean(o?.about_me))
    throw new Error('Give at least "one_sentence" (what you offer, in plain words) or "about_me" (for a job seeker or researcher).');
  for (const v of [o.one_sentence, o.about_me, o.gets])
    if (PLACEHOLDER.test(String(v || ''))) throw new Error('The answer still has a template placeholder (<…>) in it.');
  const proof = (Array.isArray(o.proof) ? o.proof : []).filter((p) => clean(p?.claim));
  const problems = Object.entries(o.problems || {}).filter(([, v]) => clean(v));
  const never = (Array.isArray(o.never_say) ? o.never_say : o.never_say ? [o.never_say] : []).map(clean).filter(Boolean);
  const insights = (Array.isArray(o.insights) ? o.insights : []).filter((i) => clean(i?.insight));
  return (
    `---\nname: what-you-bring\ndescription: What I offer, what I want from a meeting, and the proof I can use. Used by floorboss and by any agent writing outreach for me.\n---\n\n# What you bring\n\n` +
    (clean(o.about_me) ? `**About me:** ${clean(o.about_me)}\n\n` : '') +
    (clean(o.one_sentence) ? `**In one sentence:** ${clean(o.one_sentence)}\n\n` : '') +
    (problems.length ? `**Problems it solves, per segment**\n${problems.map(([k, v]) => `- ${cell(k)}: "${clean(v)}"`).join('\n')}\n\n` : '') +
    (clean(o.gets) ? `**What they get from the meeting:** ${clean(o.gets)}\n\n` : '') +
    `**Proof library**\n\n| claim | source | segments | named | date |\n|---|---|---|---|---|\n${proof.map((p) => `| ${cell(p.claim)} | ${cell(p.source) || 'internal'} | ${Array.isArray(p.segments) ? p.segments.map(cell).filter(Boolean).join(', ') : cell(p.segments)} | ${p.named === false || /^no/i.test(String(p.named)) ? 'no' : 'yes'} | ${cell(p.date)} |`).join('\n')}\n\n` +
    // No insights given: no table at all (an empty heading reads as a section the user filled), and setup asks.
    (insights.length ? `${INSIGHTS_HEAD}\n\n${INSIGHTS_TABLE}\n${insights.map(insightRow).join('\n')}\n\n` : '') +
    `**Never say:** ${never.length ? never.join('; ') : 'nothing beyond the voice rules'}\n`
  );
}

const INSIGHTS_HEAD = "**What you know that they don't**";
const INSIGHTS_TABLE = '| insight | basis | segments | situations |\n|---|---|---|---|';
// A table cell: text only (an object or a number is no answer, so it leaves the cell empty), with no "|" to
// break the row. Segments may be a list of names.
const cell = (x) => (typeof x === 'string' ? clean(x).replace(/\|/g, '/') : '');
const insightRow = (i) =>
  `| ${cell(i.insight)} | ${cell(i.basis)} | ${Array.isArray(i.segments) ? i.segments.map(cell).filter(Boolean).join(', ') : cell(i.segments)} | ${cell(i.situations)} |`;

// Who the sender is, in one line ("founder of Tallyroute"): what-you-bring's "About me", the only thing a
// message may say about them. Replaces the line, or goes in under the heading.
export function setAbout(md, line) {
  const v = clean(line);
  if (!v) return md;
  if (PLACEHOLDER.test(v)) throw new Error('The answer still has a template placeholder (<…>) in it.');
  const re = /^\*\*About me:\*\*.*$/m;
  if (re.test(md)) return md.replace(re, () => `**About me:** ${v}`);
  return /^# What you bring[ \t]*$/m.test(md) ? md.replace(/^# What you bring[ \t]*$/m, (h) => `${h}\n\n**About me:** ${v}`) : `**About me:** ${v}\n\n${md}`;
}

// Insights the user gave ([{insight, basis?, segments?, situations?}]): rows added to the "what you know" table,
// which is made if there is none (or only the template's example row).
export function addInsights(md, rows) {
  const add = rows.filter((i) => cell(i?.insight));
  if (!add.length) return md;
  for (const i of add) if (PLACEHOLDER.test(`${i.insight} ${i.basis || ''}`)) throw new Error('The answer still has a template placeholder (<…>) in it.');
  const lines = String(md).split('\n');
  const at = lines.findIndex((l) => /^\|\s*insight\s*\|\s*basis\s*\|\s*segments\s*\|/i.test(l));
  if (at >= 0) {
    let end = at + 2;
    while (end < lines.length && lines[end].trim().startsWith('|')) end++;
    const kept = lines.slice(at + 2, end).filter((l) => !/^\|\s*</.test(l));
    return [...lines.slice(0, at + 2), ...kept, ...add.map(insightRow), ...lines.slice(end)].join('\n');
  }
  const block = `${INSIGHTS_HEAD}\n\n${INSIGHTS_TABLE}\n${add.map(insightRow).join('\n')}\n`;
  const never = /^\*\*Never say:\*\*/m.exec(md);
  return never ? `${md.slice(0, never.index)}${block}\n${md.slice(never.index)}` : `${md.trimEnd()}\n\n${block}`;
}

// A never-say rule added later goes into what-you-bring's own "Never say" line (the one the critic reads).
export function addNeverSay(md, items) {
  const add = items.map(clean).filter(Boolean);
  if (!add.length) return md;
  const re = /^\*\*Never say:\*\*[ \t]*(.*)$/m;
  const m = re.exec(md);
  if (!m) return `${md.trimEnd()}\n\n**Never say:** ${add.join('; ')}\n`;
  const have = PLACEHOLDER.test(m[1]) || /^nothing beyond/i.test(m[1].trim()) ? [] : m[1].split(';').map(clean).filter(Boolean);
  return md.replace(re, `**Never say:** ${[...new Set([...have, ...add])].join('; ')}`);
}

export const stillTemplate = (md) => !md || (PLACEHOLDER.test((/\*\*In one sentence:\*\*(.*)/.exec(md) || [])[1] || '') && !/\*\*About me:\*\*/.test(md));

// One field of the voice file ("Sign-off", "Sender name"), set from an answer; the template's line is replaced.
export function setVoiceField(md, field, value) {
  const v = clean(value);
  if (!v) return md;
  const re = new RegExp(`^-\\s*\\*\\*${field}:\\*\\*.*$`, 'mi');
  if (re.test(md)) return md.replace(re, `- **${field}:** ${v}`);
  // A field dropped while blank goes back with the others (after the last one), not under a later section.
  const fields = [...String(md).matchAll(/^-\s*\*\*[^*\n]+:\*\*.*$/gm)];
  const at = fields.length ? fields[fields.length - 1].index + fields[fields.length - 1][0].length : null;
  return at != null ? `${md.slice(0, at)}\n- **${field}:** ${v}${md.slice(at)}` : `${md.trimEnd()}\n- **${field}:** ${v}\n`;
}

// The voice file as written from answers: a field nobody answered is left out, never the template's
// "<e.g. …>" example (a drafter could read it as the user's own) nor an empty line; a section with nothing in
// it ("Emails that got replies" with no emails) goes too.
export function clearVoicePlaceholders(md) {
  return String(md)
    .replace(/^-[ \t]*\*\*[^*\n]+:\*\*[ \t]*(?:<[^\n]*>)?[ \t]*$\n?/gm, '')
    .replace(/^>[ \t]*<[^\n]*>[ \t]*\n?/gm, '')
    .replace(/^## [^\n]+\n\s*(?=^## |(?![\s\S]))/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '\n');
}

// One file can hold several emails ("Email 1 …", "Subject: …", "Hi Jonas," after a blank line): split into
// emails at a blank line followed by a label, a Subject: or From: line, or a greeting once the email so far
// has its own. Label lines ("Email 2 (to a CFO, got a reply):") and From/To/Date lines are left out; each
// email's Subject: line becomes its subject.
const LABEL = /^(?:email|e-mail|message|sample)\s*#?\d+\b.*$|^-{3,}\s*$|^={3,}\s*$/i;
const HEADER = /^(subject|from|to|date|sent|cc):/i;
const GREETS = /^(hi|hello|hey|dear|good morning|morning|hiya)\b[^\n]{0,40}[,!:]?\s*$/i;
export function splitEmails(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let cur = null;
  const start = () => {
    cur = { subject: '', lines: [], greeted: false };
    out.push(cur);
  };
  let blank = true;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) {
      blank = true;
      if (cur) cur.lines.push('');
      continue;
    }
    const body = !!cur && cur.lines.some((x) => x.trim());
    if (!cur || (blank && (body || cur.subject) && (LABEL.test(l) || (body && (HEADER.test(l) || (GREETS.test(l) && cur.greeted)))))) start();
    blank = false;
    if (LABEL.test(l)) continue;
    const h = HEADER.exec(l);
    if (h) {
      if (/^subject$/i.test(h[1]) && !cur.subject) cur.subject = l.slice(h[0].length).trim();
      continue;
    }
    if (GREETS.test(l) && !cur.lines.some((x) => x.trim())) cur.greeted = true;
    cur.lines.push(raw.replace(/\s+$/, ''));
  }
  return out
    .map((e) => ({
      subject: e.subject,
      body: e.lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }))
    .filter((e) => e.body);
}

// A length the user set as a rule ("under 80 words", "max 60 words"): it wins over the length read from
// their emails.
export function lengthRule(rules) {
  for (const r of rules || []) {
    const m =
      /\b(?:under|below|at most|max(?:imum)?|no more than|less than|fewer than|up to|keep (?:it|them) (?:to|under))\s+(\d{2,3})\s+words\b|\b(\d{2,3})\s+words\s+(?:max(?:imum)?|or (?:less|fewer)|tops)\b/i.exec(
        String(r)
      );
    if (m) return `under ${m[1] || m[2]} words (your rule)`;
  }
  return null;
}

// What the user's own emails that got replies show: how long they run and how they open.
export function voiceFromEmails(bodies) {
  const list = bodies.map((b) => String(b || '').trim()).filter(Boolean);
  if (!list.length) return {};
  // Per email, the median (two emails: the mean of the two), so one long email doesn't set the length.
  const words = list.map((b) => b.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const mid = words.length % 2 ? words[(words.length - 1) / 2] : (words[words.length / 2 - 1] + words[words.length / 2]) / 2;
  const firsts = list.map((b) => b.split(/\n/)[0].trim());
  const open = firsts
    .map((l) => (/^(hi|hello|hey|dear|good morning|morning|hiya)\b/i.exec(l) || [])[1])
    .map((x) => (x ? x.toLowerCase().replace(/^./, (ch) => ch.toUpperCase()) : null));
  const counts = {};
  for (const o of open) counts[o || ''] = (counts[o || ''] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return {
    length: `about ${Math.max(10, Math.round(mid / 10) * 10)} words, like your emails that got replies`,
    greeting: top ? `"${top} <first name>,"` : 'no greeting: straight in, as in your emails'
  };
}
