// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The meeting agenda: for every booked meeting, when and where, who they are, how the user knows them, what was
// said, what floorboss knows about their company and what's new, and what to talk about. Built the day before
// (or the morning of) a meeting day, or on request. The facts come from floorboss's own records; the talking
// points are Claude's, written from those facts only, and each names the fact it rests on.
import { readJson } from '../../../lib/jsonio.mjs';
import { readDraft } from '../../../lib/drafts.mjs';
import { noteText } from '../../../lib/normalize.mjs';
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { todayKeyIn } from '../../../lib/tz.mjs';
import { readCompanyBrief } from '../../attendee-research/scripts/companies.mjs';
import { readProfile } from '../../attendee-research/scripts/profiles.mjs';

// The page loads nothing, runs no script and sends nothing anywhere, so text from a web page or an attendee
// note can't act in it.
const AGENDA_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'";
// One line, no control or invisible characters (a bidi override in a note or a reply reorders what's shown).
const clip = (t, n) => {
  const s = noteText(t, Infinity);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const slugOf = (x) =>
  String(x)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
export const newsPath = (dir, company, day) => join(dir, 'companies', `${slugOf(company)}-news-${day}.json`);
// The newest news saved for a company on `day` or in the six days before it (the brief that builds itself looks
// nothing up, so it shows what an earlier run saved). null when there is none.
function savedNewsPath(dir, company, day) {
  const re = new RegExp(`^${slugOf(company)}-news-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 6 * 864e5).toISOString().slice(0, 10);
  let names = [];
  try {
    names = readdirSync(join(dir, 'companies'));
  } catch {
    return null;
  }
  const days = names
    .map((n) => (re.exec(n) || [])[1])
    .filter((d) => d && d <= day && d >= from)
    .sort();
  return days.length ? newsPath(dir, company, days[days.length - 1]) : null;
}

// What went, from its fingerprinted record (drafts/<hash>.json), never the working copy Claude may write.
const sentText = (dir, hash) => {
  try {
    return /^[0-9a-f]{24}$/.test(String(hash || '')) ? readDraft(dir, hash)?.body || null : null;
  } catch {
    return null;
  }
};

// Every booked meeting (on `day` when given), in time order, with the facts the agenda may use.
// savedNews: the newest news saved in the last week, not only today's (agenda-facts).
export function agendaData(c, { day = null, savedNews = false } = {}) {
  const zone = c.event.time_zone;
  const resolved = readJson(join(c.paths.derived, 'resolved.json'), {});
  const slotById = Object.fromEntries((c.slots || []).map((s) => [s.id, s]));
  const meetings = [];
  for (const [id, p] of Object.entries(c.folded.people || {})) {
    if (!p.booked || p.stopped || p.dropped) continue;
    const start = p.booked_start || slotById[p.booked]?.start || null;
    if (!start) continue;
    const meetDay = todayKeyIn(zone, new Date(start));
    if (day && meetDay !== day) continue;
    const ct = c.byId[id] || {};
    const r = resolved[id] || {};
    const sent = Object.entries(p.touches || {})
      .filter(([, t]) => t.sent)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([t, x]) => ({ touch: Number(t), date: x.sent.date || null, text: clip(x.sent.text || sentText(c.paths.dir, x.sent.hash) || '', 600) }));
    const brief = ct.company ? readCompanyBrief(c.paths.dir, ct.company) : null;
    const newsDay = todayKeyIn(zone, c.now);
    const newsFile = ct.company ? (savedNews ? savedNewsPath(c.paths.dir, ct.company, newsDay) : newsPath(c.paths.dir, ct.company, newsDay)) : null;
    const news = newsFile ? readJson(newsFile, null) : null;
    meetings.push({
      id,
      start,
      day: meetDay,
      time: new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(start)),
      place: c.settings.meeting_place || null,
      person: { name: ct.name, title: ct.title || null, company: ct.company || null, email: ct.email || null },
      // How the user knows them: what the CRM, the mailbox and earlier events say (never more than that).
      relation: {
        group: r.group || null,
        says: clip(r.says, 200) || null,
        crm: r.crm ? { status: r.crm.status || null, owner: r.crm.holder || null, last_contact: r.crm.last_contact || null } : null,
        account_note: r.account_note || null,
        coworker_also: r.coworker_also || null,
        mailbox: r.mailbox_note || null,
        user_note: clip((c.triage?.user_notes || {})[id], 300) || null
      },
      // Received: what floorboss read in the browser, and the replies the user reported in words, oldest first.
      thread: {
        sent,
        received: [
          ...(p.received || []).map((x) => ({ at: x.at, text: clip(x.text, 600) })),
          ...(p.replies_said || []).map((x) => ({ at: x.at, text: clip(x.text, 600), ...(x.channel ? { channel: x.channel } : {}), recorded: true }))
        ].sort((a, b) => String(a.at).localeCompare(String(b.at))),
        booked_via: p.booked_via || null
      },
      company_brief: brief ? clip(brief, 2500) : null,
      news: news?.news || [],
      profile: (() => {
        const t = readProfile(c.paths.dir, id);
        return t ? clip(t, 1500) : null;
      })()
    });
  }
  meetings.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { event: { name: c.event.name, city: c.event.city, zone }, day, goal: c.settings.goal || null, meetings };
}

// Claude's talking points, checked: one entry per meeting, two to four points, one question, each point naming
// the fact it rests on (brief, news, thread, crm, profile, goal). Nothing about a person the facts don't give.
export function validatePoints(data, raw) {
  const errors = [];
  const byId = new Map((Array.isArray(raw?.meetings) ? raw.meetings : []).map((m) => [String(m.id), m]));
  const SOURCES = /^(brief|news|thread|crm|profile|goal|list)$/;
  for (const m of data.meetings) {
    const x = byId.get(m.id);
    if (!x) {
      errors.push(`${m.id} (${m.person.name}) has no talking points`);
      continue;
    }
    const pts = Array.isArray(x.points) ? x.points : [];
    if (pts.length < 2 || pts.length > 4) errors.push(`${m.id}: give two to four points`);
    for (const p of pts)
      if (!p?.text || !SOURCES.test(String(p.from || ''))) errors.push(`${m.id}: each point is {"text","from":"brief|news|thread|crm|profile|goal|list"}`);
    for (const p of pts)
      if (p?.from === 'news' && !m.news.length) errors.push(`${m.id}: a point says it's from the news, but there's no news for ${m.person.company}`);
    for (const p of pts) if (p?.from === 'profile' && !m.profile) errors.push(`${m.id}: a point says it's from their profile, but there's no research on them`);
    if (!x.ask) errors.push(`${m.id}: one question to ask them ("ask")`);
  }
  return { errors, points: byId };
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
// Every string from a list, the CRM, the mailbox or the news, as it goes onto a page: characters a reader can't see
// are taken out (a bidi override reorders what is shown; a zero-width character hides in a name), a line break or
// other control character becomes a space, and it is cut at a length no real value reaches. Plain text is unchanged.
// Three of those characters are part of how some text is written, and stay where they do that work: the zero-width
// non-joiner and joiner between two letters or marks (Persian, the Indic scripts), the joiner between two emoji
// (a family, a flag), and the variation selector that follows an emoji.
const UNSEEN = /[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0]/gu;
const LETTER = /[\p{L}\p{M}]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const before = (s, i) => (i > 0 ? String.fromCodePoint(s.codePointAt(i - (i > 1 && s.charCodeAt(i - 1) >= 0xdc00 && s.charCodeAt(i - 1) <= 0xdfff ? 2 : 1))) : '');
const after = (s, i) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)) : '');
const keepsItsPlace = (ch, s, i) => {
  const a = before(s, i),
    b = after(s, i + ch.length);
  if (ch === '\u200c' || ch === '\u200d') {
    if (LETTER.test(a) && LETTER.test(b)) return true;
    return ch === '\u200d' && (EMOJI.test(a) || a === '\ufe0f') && EMOJI.test(b);
  }
  return ch === '\ufe0f' && EMOJI.test(a);
};
export const pageLine = (t, n = 1000) => {
  if (t == null) return t;
  const s = String(t)
    .replace(UNSEEN, (ch, i, whole) => (keepsItsPlace(ch, whole, i) ? ch : ''))
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const WEB = /^https?:\/\/[^\s"'<>]+$/i;
// The facts and the talking points as the three renderers use them: every string cleaned as above, and a news
// link kept only when it is a plain web address.
function forPage(data, points) {
  const d = {
    ...data,
    event: { ...data.event, name: pageLine(data.event?.name, 300) },
    day: pageLine(data.day, 20),
    goal: pageLine(data.goal),
    meetings: (data.meetings || []).map((m) => ({
      ...m,
      time: pageLine(m.time, 80),
      place: pageLine(m.place, 300),
      person: { ...m.person, name: pageLine(m.person?.name, 300), title: pageLine(m.person?.title, 300), company: pageLine(m.person?.company, 300) },
      relation: {
        ...m.relation,
        crm: m.relation?.crm
          ? { status: pageLine(m.relation.crm.status, 300), owner: pageLine(m.relation.crm.owner, 300), last_contact: pageLine(m.relation.crm.last_contact, 300) }
          : m.relation?.crm,
        account_note: pageLine(m.relation?.account_note),
        coworker_also: pageLine(m.relation?.coworker_also, 300),
        mailbox: pageLine(m.relation?.mailbox),
        user_note: pageLine(m.relation?.user_note)
      },
      news: (Array.isArray(m.news) ? m.news : []).map((n) => {
        const url = pageLine(n?.url, 2000);
        return { ...n, text: pageLine(n?.text, 600), url: WEB.test(String(url ?? '')) ? url : null };
      }),
      thread: { ...m.thread, received: (m.thread?.received || []).map((x) => ({ ...x, text: pageLine(x?.text, 2000) })) }
    }))
  };
  const p = new Map(
    [...(points || new Map())].map(([id, x]) => [
      id,
      {
        ...x,
        points: (Array.isArray(x?.points) ? x.points : []).map((q) => ({ ...q, text: pageLine(q?.text), from: pageLine(q?.from, 20) })),
        ask: pageLine(x?.ask),
        avoid: pageLine(x?.avoid)
      }
    ])
  );
  return [d, p];
}
const knowLine = (m) =>
  [
    m.relation.crm?.status
      ? `CRM: ${m.relation.crm.status}${m.relation.crm.owner ? ` (${m.relation.crm.owner})` : ''}${m.relation.crm.last_contact ? `, last contact ${m.relation.crm.last_contact}` : ''}`
      : null,
    m.relation.account_note,
    m.relation.coworker_also ? `${m.relation.coworker_also} also works this company` : null,
    m.relation.mailbox,
    m.relation.user_note ? `your note: ${m.relation.user_note}` : null
  ].filter(Boolean);
// One field of a company brief, up to the next bold field (a clipped brief is one line).
const briefField = (brief, name) =>
  (new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+?)(?=\\s*\\*\\*[A-Z][^*\\n]{1,40}:\\*\\*|\\n|$)`, 's').exec(brief || '') || [])[1] || null;
// The relationship as facts only: the brief's lines for the drafter ("Write as to a customer…", "Never quote…")
// are instructions, not something to read before a meeting.
const factsOnly = (t) =>
  t
    ? String(t)
        .split(/(?<=[.!?])\s+/)
        .filter((x) => !/^(write|never|don'?t|do not|use|open|say|keep|avoid|mention|lead|quote)\b/i.test(x.trim()))
        .join(' ')
        .replace(/[.\s]+$/, '')
        .trim() || null
    : null;
const companyLine = (brief) => {
  const s = briefField(brief, 'Sells');
  const rel = [
    factsOnly(briefField(brief, 'Relation to us')),
    factsOnly(briefField(brief, 'Your customer')) && `your customer: ${factsOnly(briefField(brief, 'Your customer'))}`,
    factsOnly(briefField(brief, 'Your proof customer')) && `proof customer: ${factsOnly(briefField(brief, 'Your proof customer'))}`
  ].filter(Boolean);
  return [s ? `Sells: ${clip(s, 200)}` : null, rel.length ? `To you: ${clip(rel.join('; '), 300)}` : null].filter(Boolean);
};

// note: one line under the title (the facts-only brief says so when saved talking points no longer fit).
export function renderMarkdown(rawData, rawPoints, { note = null } = {}) {
  const [data, points] = forPage(rawData, rawPoints);
  const L = [`# ${data.event.name}: your meetings${data.day ? ` on ${data.day}` : ''}`, '', data.goal ? `Goal: ${data.goal}` : '', '', ...(note ? [pageLine(note), ''] : [])];
  for (const m of data.meetings) {
    const x = points.get(m.id) || {};
    L.push(`## ${m.time} · ${m.person.name}, ${m.person.title || ''} at ${m.person.company || ''}`, m.place ? `Where: ${m.place}` : '', '');
    for (const k of knowLine(m)) L.push(`- ${k}`);
    for (const k of companyLine(m.company_brief)) L.push(`- ${k}`);
    for (const n of m.news.slice(0, 3)) L.push(n.url ? `- New: ${n.text} (${n.url})` : `- New: ${n.text}`);
    if (m.thread.received.length) L.push(`- They wrote: "${clip(m.thread.received[m.thread.received.length - 1].text, 200)}"`);
    // No talking points (the facts-only brief): the headings for them are left out, not shown empty.
    L.push(
      '',
      ...((x.points || []).length ? ['**Talk about**', ...x.points.map((p) => `- ${p.text} _(from ${p.from})_`), ''] : []),
      ...(x.ask ? [`**Ask:** ${x.ask}`] : []),
      ...(x.avoid ? [`**Leave out:** ${x.avoid}`] : []),
      ''
    );
  }
  return L.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

export function renderHtml(rawData, rawPoints, { note = null } = {}) {
  const [data, points] = forPage(rawData, rawPoints);
  const cards = data.meetings
    .map((m) => {
      const x = points.get(m.id) || {};
      const know = [...knowLine(m), ...companyLine(m.company_brief)];
      return `<section class="m"><header><span class="t">${esc(m.time)}</span><h2>${esc(m.person.name)}</h2><p class="who">${esc(m.person.title || '')}${m.person.company ? ` · ${esc(m.person.company)}` : ''}${m.place ? ` · ${esc(m.place)}` : ''}</p></header>
${know.length ? `<h3>What you know</h3><ul>${know.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
${
  m.news.length
    ? `<h3>New since you wrote</h3><ul>${m.news
        .slice(0, 3)
        .map((n) => `<li>${esc(n.text)}${n.url ? ` <a href="${esc(n.url)}">source</a>` : ''}</li>`)
        .join('')}</ul>`
    : ''
}
${m.thread.received.length ? `<h3>They wrote</h3><blockquote>${esc(clip(m.thread.received[m.thread.received.length - 1].text, 300))}</blockquote>` : ''}
${(x.points || []).length ? `<h3>Talk about</h3><ul>${x.points.map((p) => `<li>${esc(p.text)} <span class="src">${esc(p.from)}</span></li>`).join('')}</ul>` : ''}
${x.ask ? `<p class="ask"><b>Ask:</b> ${esc(x.ask)}</p>` : ''}${x.avoid ? `<p class="avoid"><b>Leave out:</b> ${esc(x.avoid)}</p>` : ''}</section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${AGENDA_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(data.event.name)} agenda</title><style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e4e1d8;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a3a29c;--line:#33322e;--accent:#8cc5b3}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:760px;margin-inline:auto}
h1{font-size:1.5rem;margin:0 0 4px}.goal{color:var(--muted);margin:0 0 24px}
.m{border-top:1px solid var(--line);padding:20px 0;break-inside:avoid}.t{color:var(--accent);font-weight:600}
h2{font-size:1.2rem;margin:2px 0}.who{color:var(--muted);margin:0 0 8px}h3{font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 4px}
ul{margin:0;padding-left:20px}.src{font-size:.75rem;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px}
blockquote{margin:0;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}.ask{margin:12px 0 0}.avoid{color:var(--muted);margin:4px 0 0}
a{color:var(--accent)}@media print{body{padding:0}}</style></head><body>
<h1>${esc(data.event.name)}: your meetings${data.day ? ` · ${esc(data.day)}` : ''}</h1><p class="goal">${esc(data.goal || '')}</p>${note ? `<p class="goal">${esc(pageLine(note))}</p>` : ''}
${cards || '<p>No meetings booked.</p>'}</body></html>`;
}

// A calendar line is at most 75 bytes; a longer one goes on as lines that start with a space (RFC 5545, 3.1). A
// character of several bytes is never split.
function fold75(line) {
  const out = [];
  let cur = '',
    bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 75) {
      out.push(cur);
      cur = ` ${ch}`;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}
// One calendar event per meeting, the brief in its notes, so the agenda is where the meeting already is.
export function renderIcs(rawData, rawPoints, { minutes = 30 } = {}) {
  const [data, points] = forPage(rawData, rawPoints);
  const fmt = (d) =>
    new Date(d)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  // A line break of any kind (CRLF, a bare CR, a Unicode separator) is one escaped \n, and other control characters go,
  // so text can never start a new calendar line.
  const text = (s) =>
    String(s)
      .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  const ev = data.meetings.map((m) => {
    const x = points.get(m.id) || {};
    const desc = [
      `${m.person.title || ''} at ${m.person.company || ''}`,
      ...knowLine(m),
      ...((x.points || []).length ? ['', 'Talk about:', ...x.points.map((p) => `- ${p.text}`)] : []),
      ...(x.ask ? ['', `Ask: ${x.ask}`] : [])
    ].join('\n');
    return [
      'BEGIN:VEVENT',
      `UID:floorboss-${m.id}-${fmt(m.start)}`,
      `DTSTAMP:${fmt(Date.now())}`,
      `DTSTART:${fmt(m.start)}`,
      `DTEND:${fmt(Date.parse(m.start) + minutes * 60e3)}`,
      `SUMMARY:${text(`${m.person.name} (${m.person.company || ''})`)}`,
      ...(m.place ? [`LOCATION:${text(m.place)}`] : []),
      `DESCRIPTION:${text(desc)}`,
      'END:VEVENT'
    ]
      .map(fold75)
      .join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//floorboss//agenda//EN', ...ev, 'END:VCALENDAR', ''].join('\r\n');
}
