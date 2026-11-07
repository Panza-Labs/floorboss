// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Deterministic checks on a draft before the critic sees it.
import { relativeWordsIn } from './leadtime.mjs';
import { CONSTANTS } from '../../../lib/config.mjs';

export function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

// First name for the greeting check, skipping honorifics ("Ing. Roberto Díaz" → Roberto).
const HONORIFICS =
  /^(mr|mrs|ms|mx|miss|dr|dra|prof|professor|professorin|primar|primaria|ing|lic|arq|sr|sra|srta|herr|frau|mme|mlle|m|dott|dottssa|sir|dame|doctor|doctora|doktor|madam|madame|monsieur|señor|señora|senhor|senhora|director|directora|president|chair|chairman|chairwoman|minister|ambassador|mayor|governor|secretary|senator|judge|justice|general|colonel|captain|rev|reverend|father|rabbi|imam|sheikh|chief|engineer|eng|ir|ca|cpa|cs|adv|advocate|er|shri|smt|kumari)\.?$/i;
const firstName = (name) =>
  String(name)
    .trim()
    .split(/\s+/)
    .find((w) => !HONORIFICS.test(w)) || '';

// draft: {channel, subject, body}. ctx: {contact, slotLabels, eventName, optout, pasteLimit, otherNames}
export function checkDraft(draft, ctx) {
  const problems = controlProblems(draft);
  const body = String(draft.body || '');
  if (draft.channel === 'email') {
    if (!String(draft.subject || '').trim()) problems.push('email has no subject');
    // The fixed opt-out line isn't the message: it doesn't count towards the limit.
    const n = wordCount(ctx.optout ? body.split(ctx.optout).join(' ') : body);
    if (n > CONSTANTS.email_word_limit) problems.push(`email is ${n} words; the limit is ${CONSTANTS.email_word_limit}`);
  } else if (body.length > ctx.pasteLimit) {
    problems.push(`paste message is ${body.length} characters; the limit is ${ctx.pasteLimit}`);
  }
  for (const label of ctx.slotLabels || []) {
    if (!timeMentioned(body, label)) problems.push(`doesn't offer ${label.replace(/ \(.*\)$/, '')} (its day and time)`);
  }
  // The event's own name, or a short name the user gave it ("GRCF").
  // …or the name without its year or edition ("GreenRift Climate Forum 2026" → "GreenRift Climate Forum").
  const bare = ctx.eventName
    ? String(ctx.eventName)
        .replace(/\s*(?:\b(?:19|20)\d{2}\b|\b\d+(?:st|nd|rd|th)\b|\bedition\b)\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : null;
  // …or the part before a colon or dash ("RLX 2027: Retail Leaders Expo" → "RLX"), or a leading acronym.
  const head = bare ? bare.split(/\s*[:|–—]\s*|\s+-\s+/)[0].trim() : null;
  const acronym = ctx.eventName ? (/^([A-Z][A-Z0-9&]{1,7})\b/.exec(String(ctx.eventName)) || [])[1] : null;
  // …or the name without its kind word ("Harbour & Haul Expo" → "Harbour & Haul", "Northgate Summit" stays whole).
  const kindless = bare ? bare.replace(/\s+(expo|summit|conference|forum|festival|week|show|congress|fair|days?|meetup|connect)$/i, '').trim() : null;
  // …or the name without its city ("Lakeshore Ops Summit Chicago" → "Lakeshore Ops Summit").
  const cityless =
    bare && ctx.eventCity ? bare.replace(new RegExp(`\\s+${String(ctx.eventCity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim() : null;
  const eventNames = [
    ctx.eventName,
    bare,
    head && head.length >= 2 ? head : null,
    acronym,
    kindless && kindless.split(/\s+/).length >= 2 ? kindless : null,
    cityless && cityless !== bare && cityless.split(/\s+/).length >= 2 ? cityless : null,
    ...(ctx.eventAliases || [])
  ].filter(Boolean);
  // A follow-up sits in the thread that named the event; it doesn't have to name it again.
  if (!ctx.followup && eventNames.length && !eventNames.some((n) => body.toLowerCase().includes(String(n).toLowerCase())))
    problems.push(
      `doesn't name the event: write ${[...new Map(eventNames.map((n) => [String(n).toLowerCase(), n])).values()].map((n) => `"${n}"`).join(' or ')} (only these count; another short name, like "the ${(String(ctx.eventName || '').match(/\b(expo|summit|conference|forum|festival|week|show|congress|fair)\b/i) || ['', 'event'])[1].toLowerCase()}", counts only once the user adds it as one of the event's short names)`
    );
  if (ctx.optout && !body.includes(ctx.optout)) problems.push(`missing the opt-out sentence${ctx.language ? ` in ${ctx.language}` : ''}`);
  if (ctx.optoutLeftOff && body.includes(ctx.optoutLeftOff))
    problems.push('ends with the opt-out sentence, which you chose to leave off emails to people you already know');
  // Only languages the sender can hold the meeting in.
  if (ctx.language && (ctx.languages || []).length && !ctx.languages.some((l) => l.toLowerCase() === String(ctx.language).toLowerCase()))
    problems.push(`written in ${ctx.language}, which isn't one of the languages you meet in (${ctx.languages.join(', ')})`);
  const rel = relativeWordsIn(`${draft.subject || ''} ${body}`);
  if (rel.length) problems.push(`uses relative time words (${rel.join(', ')}); write the day and date`);
  if (/\{\{|\}\}|\[(?:name|company|first name|title)\]/i.test(`${draft.subject || ''} ${body}`)) problems.push('has an unfilled placeholder');
  const greet =
    /^\s*(hi|hello|hey|dear|good (?:morning|afternoon)|hallo|liebe|lieber|guten tag|hola|estimad[oa]|olá|ola|caro|cara|bonjour|cher|chère)\s+([\p{L}'’.-]+)(?:\s+([\p{L}'’-]+))?/iu.exec(
      body
    );
  if (greet && ctx.contact) {
    // "Hi Roberto" or "Dear Dr Rahimi": a first name, or an honorific with any part of the name.
    // Accents don't decide it: "hi joão" greets João even if the list wrote "Joao", and the other way round.
    const fold = (w) => w.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const parts = fold(String(ctx.contact.name).toLocaleLowerCase())
      .split(/\s+/)
      .map((w) => w.replace(/[.,]/g, ''));
    const word = fold(greet[2].toLowerCase().replace(/\.$/, ''));
    // Any part of the name counts: name order differs by culture ("Tran Minh Duc" is greeted "Duc").
    const ok =
      word === fold(firstName(ctx.contact.name).toLowerCase()) ||
      (!HONORIFICS.test(greet[2]) && parts.includes(word)) ||
      (HONORIFICS.test(greet[2]) && greet[3] && parts.includes(fold(greet[3].toLowerCase())));
    if (!ok) problems.push(`greets "${greet[2]}${HONORIFICS.test(greet[2]) && greet[3] ? ` ${greet[3]}` : ''}" but the contact is ${ctx.contact.name}`);
  }
  for (const other of ctx.otherNames || []) {
    if (other && other.split(/\s+/).length >= 2 && body.toLowerCase().includes(other.toLowerCase())) {
      problems.push(`mentions another attendee (${other})`);
    }
  }
  // A number the user's own material marks confidential (NDA, not public, internal only) never goes in a message.
  // A whole figure, not digits inside another number ("26" from "2024-26" is not in "2026").
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const n of confidentialNumbers(ctx.ownFacts || ''))
    if (new RegExp(`(?<![\\d.,])${esc(n)}(?![\\d])`, 'i').test(body)) problems.push(`uses ${n}, which your profile marks as confidential (NDA or not public)`);
  // A customer's own result quoted back to them ("Brightside lifted repeat purchase 14%" to Brightside's VP).
  // Only a proof row that names their company as a whole word, and only when the draft carries that row's own
  // number: saying they work with you is fine, quoting their result back isn't.
  const co = String(ctx.contact?.company || '').trim();
  const wordRe = co.length >= 4 ? new RegExp(`(?:^|[^\\p{L}\\d])${co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\p{L}\\d]|$)`, 'iu') : null;
  const proofBlock = (/\*\*Proof library\*\*([\s\S]*?)(?:\n\*\*|$)/.exec(String(ctx.ownFacts || '')) || [, String(ctx.ownFacts || '')])[1];
  const theirs = wordRe ? proofBlock.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*(claim|insight|---)/i.test(l) && wordRe.test(l)) : [];
  const numsOf = (l) => (l.split('|')[1] || '').match(/[€$£]\s?\d[\d,.]*|\d[\d,.]*\s?%|\d+(?:\.\d+)?x\b|\d{3,}/g) || [];
  if (theirs.some((l) => numsOf(l).some((n) => body.includes(n.trim()))))
    problems.push(`quotes ${co}'s own result from your proof library back to someone at ${co}: they know it; write to them as a customer`);
  // A figure (a percentage, a multiple, an amount of money) is quoted only from what floorboss has for this
  // message: the user's material, the research, the CRM, the user's notes ("cuts truck waiting time by 70%"
  // came from nowhere and went through).
  for (const n of inventedFigures(body, [ctx.ownFacts, ctx.factText].filter(Boolean).join('\n')))
    problems.push(
      `uses ${n}, which nothing floorboss has for this message says (your what-you-bring, the research, the CRM, your notes): cut it, or add where it comes from to your profile`
    );
  for (const claim of ownClaims(body, ctx.ownFacts || ''))
    problems.push(
      `says something about you that your profile doesn't back ("${claim}"): only what's in what-you-bring may be said about your experience or views; cut it or add it to your profile`
    );
  return problems;
}

// Characters a reader can't see or that change what they see: a bidi override (U+202E shows "moc.live" as
// "evil.com"), a zero-width space, a control character. A line break goes in the body only, never the subject
// (a CRLF there can start a header such as Bcc:). Every kind of message gets this check.
export function controlProblems(draft) {
  const out = [];
  const subject = String(draft.subject ?? ''),
    body = String(draft.body ?? '');
  if (/\p{Cf}/u.test(subject + body))
    out.push('has an invisible formatting character (a direction override, a zero-width space or a similar mark): write it without');
  if (/[^\P{Cc}\n]|[\u2028\u2029]/u.test(body))
    out.push('its body has a control character other than a plain line break (a carriage return, a tab, a bell…): write it without');
  if (/[\p{Cc}\u2028\u2029\u0085]/u.test(subject)) out.push('its subject has a line break or a control character: one plain line');
  return out;
}

// Figures in a draft that none of its sources has: "70%", "3x", "€40k", "$1.2m" (spaces and thousands
// separators aside). Times and dates aren't figures.
const FIGURE = /[€$£]\s?\d[\d,.]*\s?(?:[kmb]n?|million|billion)?\b|\d+(?:[.,]\d+)?\s?(?:%|percent\b|per cent\b)|\b\d+(?:\.\d+)?x\b/gi;
const figureKey = (f) =>
  String(f)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/per ?cent/g, '%')
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[.,]$/, '');
export function inventedFigures(body, sources) {
  const have = new Set((String(sources || '').match(FIGURE) || []).map(figureKey));
  return [...new Set((String(body || '').match(FIGURE) || []).map((f) => f.trim().replace(/[.,]$/, '')))].filter((f) => !have.has(figureKey(f)));
}

// First-person lines about the user's own experience, struggles or views: "matches what I see", "exactly
// where I am", "I keep every quote under human review", "I've seen the same backlog problem". These are the
// lines a model invents to sound relatable. One is fine only when the user's profile says it.
const OWN_CLAIM = [
  // "I've seen your talk" is about them, not the sender's experience: only "seen the same / this / that…".
  /\b(?:I've|I have|I'd|we've|we have) (?:seen|noticed|found|learned|watched)\b(?! (?:your|you|that you|how you))/i,
  /\b(?:I've|I have|we've|we have) been (?:wrestling|struggling|stuck|thinking|fighting|chasing)\b/i,
  /\bin (?:my|our) experience\b/i,
  /\blike you,? (?:I|we)\b/i,
  /\b(?:I|we) (?:struggled|wrestled|fought|battled) with\b/i,
  /\bI know (?:exactly|first-?hand|all too well) (?:how|what)\b/i,
  /\b(?:I|we) (?:keep|kept) (?:seeing|running into|hitting|finding|my|our)\b/i,
  /\b(?:matches|mirrors|echoes) (?:what|how) (?:I|we)\b/i,
  /\bexactly where (?:I|we) (?:am|are)\b/i,
  /\b(?:where|what) (?:I'm|I am|we're|we are) (?:at|seeing|stuck|dealing with|going through|wrestling with)\b/i,
  /\b(?:what|how) I (?:see|think about|keep seeing)\b/i,
  /\bmy (?:read|take|experience|bet|hunch|view|sense)(?: so far)? (?:is|has been|was)\b/i,
  /\b(?:I|we) (?:don't|do not|never) (?:know|figured out|understand) (?:what|how|whether|which)\b/i,
  /\b(?:I'm|I am|we're|we are) (?:struggling|wrestling|stuck|trying to (?:figure|work) out)\b/i,
  /\bthe (?:part|thing) (?:I|we) (?:always|keep|still)\b/i,
  // Patterns claimed for the sender's customers that the profile doesn't give ("in our work with retailers").
  /\b(?:in|from) (?:our|my) work with\b/i,
  /\bacross (?:the )?(?:\w+ ){0,2}(?:we work with|we've worked with|we talk to|we speak with)\b/i,
  /\b(?:we|I) (?:often|usually|typically|always|regularly) (?:see|hear|find)\b/i,
  /\bwhat (?:we|I) hear (?:most|from)\b/i
];
const words = (t) =>
  new Set(
    String(t)
      .toLowerCase()
      .match(/[a-z][a-z'-]{2,}/g) || []
  );
export function ownClaims(body, ownFacts) {
  const facts = String(ownFacts || '')
    .split(/\n|(?<=[.!?])\s+/)
    .map(words)
    .filter((w) => w.size >= 3);
  const out = [];
  for (const sentence of String(body).split(/(?<=[.!?])\s+|\n+/)) {
    // Scheduling lines are about the meeting, not the sender's experience ("I'm trying to work out a time",
    // "we have found two slots", "where we're at the event: Hall B").
    const hit = OWN_CLAIM.map((re) => re.exec(sentence))
      .filter(Boolean)
      .sort((a, b) => a.index - b.index)[0];
    if (!hit) continue;
    // Only the claim itself is excused when it's about the meeting: the matched words run straight into a time,
    // a slot or a place ("trying to work out a time", "have found two slots", "where we're at the event").
    if (
      /^[^.]{0,40}\b(time|times|slot|slots|day|days|minutes|date|meeting|the event|the show|hall|booth|stand)\b/i.test(
        sentence.slice(hit.index + hit[0].length)
      ) &&
      !/\b(customers?|clients?|retailers?|companies|teams?|we work with|our work)\b/i.test(sentence)
    )
      continue;
    // Backed when most of the claim's words (from where it starts, so a greeting doesn't count) come from
    // one line of the user's own profile.
    const w = [...words(sentence.slice(hit.index))].filter(
      (x) => !['the', 'and', 'that', 'this', 'with', 'you', 'your', 'have', 'what', 'where', 'how'].includes(x)
    );
    const backed = facts.some((f) => w.length && w.filter((x) => f.has(x)).length / w.length >= 0.6);
    if (!backed) out.push(sentence.trim().slice(0, 90));
  }
  return out;
}

const WEEKDAYS = { mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' };

// Times are written the way a person would ("Would Tue 27th at 10:00 or 14:30 work?"), not as the label
// ("Tue 27 Oct, 10:00 Berlin time"): a label counts as offered when its day (weekday or date) and its
// time (10:00, 10.00, 10h, 1000, 10am) are in the text. A day shared by both times needs saying once.
export function timeMentioned(body, label) {
  const m = /^(\w{3}) (\d{1,2}) \w{3}, (\d{2}):(\d{2})/.exec(String(label));
  if (!m) return String(body).includes(label);
  const [, wd, day, hh, mm] = m;
  const t = String(body).toLowerCase();
  const h = Number(hh),
    h12 = h % 12 || 12,
    ap = h < 12 ? 'a\\.?m\\.?' : 'p\\.?m\\.?';
  const times = [
    `${hh}[:.h]${mm}`,
    `(?<!\\d)${h}[:.h]${mm}`,
    `(?<!\\d)${hh}${mm}(?!\\d)`,
    `(?<!\\d)${h}${mm}(?!\\d)`,
    ...(mm === '00' ? [`(?<![\\d:.])${h}h(?!\\d)`, `(?<![\\d:.])${h12} ?${ap}`] : [`(?<![\\d:.])${h12}[:.]${mm} ?${ap}`])
  ];
  const timeOk = new RegExp(times.join('|')).test(t);
  const dayOk = new RegExp(
    `\\b(${wd.toLowerCase()}|${WEEKDAYS[wd.toLowerCase()] || wd.toLowerCase()})\\b|(?<!\\d)${Number(day)}(st|nd|rd|th|\\.)?(?!\\d|:)`
  ).test(t);
  return timeOk && dayOk;
}

// Numbers (with %, x, $, € or a unit) on lines of the user's material that say NDA, confidential, not public,
// internal only or anonymous: those figures can't be quoted.
export function confidentialNumbers(text) {
  const out = new Set();
  for (const line of String(text || '').split(/\n/)) {
    if (!/\b(nda|confidential|not public|internal only|do not share|don'?t share|anonymous|under nda|private)\b/i.test(line)) continue;
    // Years and year ranges (2024, 2024-26) are dates, not figures.
    const dated = line.replace(/\b(19|20)\d{2}(\s?[-–/]\s?(19|20)?\d{2})?\b/g, ' ');
    for (const m of dated.matchAll(/[$€£]?\d[\d,.]*\s?(%|x\b|k\b|m\b|bn\b|percent)?/gi)) {
      const n = m[0].trim();
      if (n.replace(/\D/g, '').length >= 2 || /%|x/i.test(n)) out.add(n.replace(/\s+$/, ''));
    }
  }
  return [...out];
}

// Links and addresses in a confirmation, other than the user's own email and domains. Read loosely: "[.]",
// " dot ", a fullwidth dot and "hxxp" count, and any host with a letter suffix does, whatever its ending.
export function confirmationLinks(text, settings = {}) {
  const own = new Set((settings.own_domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '')));
  const ownEmail = String(settings.own_email || '').toLowerCase();
  const t = String(text || '')
    .normalize('NFKC')
    .replace(/\s*\[\s*\.\s*\]\s*|\s*\(\s*dot\s*\)\s*|\s+dot\s+/gi, '.')
    .replace(/\bhxxp/gi, 'http');
  const found =
    t.match(
      /\b(?:https?|ftp):\/\/\S+|(?<![\w/])\/\/[^\s/]+\S*|\bwww\.\S+|\bmailto:\S+|[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+|\b\d{1,3}(?:\.\d{1,3}){3}\b|(?<![@\p{L}\d.-])[\p{L}\d-]+(?:\.[\p{L}\d-]+)*\.\p{L}{2,}(?![\p{L}\d-])\S*/gu
    ) || [];
  return found
    .map((x) => x.replace(/[.,;:!?)\]]+$/, ''))
    .filter((x) => {
      const low = x.toLowerCase();
      if (ownEmail && low.replace(/^mailto:/, '') === ownEmail) return false;
      const host = (low.replace(/^mailto:/, '').split('@')[1] || low.replace(/^[a-z]+:\/\//, '').replace(/^\/\//, '')).split(/[/:?#]/)[0].replace(/^www\./, '');
      return ![...own].some((d) => host === d || host.endsWith(`.${d}`));
    });
}
