// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Deterministic checks on a draft before the critic sees it.
import { relativeFlag } from './leadtime.mjs';
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
  // The last message of a sequence asks only yes or no: it offers no times (see closingProblems).
  if (!(ctx.followup && ctx.lastTouch))
    for (const label of ctx.slotLabels || []) {
      if (!timeMentioned(body, label)) problems.push(`doesn't offer ${label.replace(/ \(.*\)$/, '')} (its day and time)`);
    }
  problems.push(...writingProblems(draft, ctx));
  const eventNames = eventNamesOf(ctx);
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
  const rel = relativeFlag(`${draft.subject || ''} ${body}`);
  if (rel) problems.push(rel);
  if (/\{\{|\}\}|\[(?:name|company|first name|title)\]/i.test(`${draft.subject || ''} ${body}`)) problems.push('has an unfilled placeholder');
  const greet =
    /^\s*(hi|hello|hey|dear|good (?:morning|afternoon)|hallo|liebe|lieber|guten tag|hola|estimad[oa]|olá|ola|caro|cara|bonjour|cher|chère)\s+([\p{L}\p{M}'’.-]+)(?:\s+([\p{L}\p{M}'’-]+))?/iu.exec(
      body
    );
  // A name keeps its combining signs (Devanagari, Thai, Bengali, Tamil, Arabic, Hebrew vowels): read without them, "Hi
  // सुनील" greeted "स".
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

// ---------- the writing rules a busy reader answers (2026-11-20) ----------

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (w) =>
  String(w)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
// The body without its opt-out line, and its first sentence after the greeting.
const withoutOptout = (body, ctx) => (ctx.optout ? String(body).split(ctx.optout).join(' ') : String(body));
const GREETING_HEAD =
  /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon)|hallo|liebe|lieber|guten tag|hola|estimad[oa]|olá|ola|caro|cara|bonjour|cher|chère)\b[^\n,]*,?\s*/i;
export function firstSentence(body) {
  const rest = String(body || '')
    .replace(GREETING_HEAD, '')
    .trim();
  // A full stop after an abbreviation ("Acme Bros.", "Inc.", "e.g.") doesn't end the sentence.
  return (rest.split(/(?<=[.?!:])(?<!\b(?:Bros|Inc|Ltd|Co|Corp|Dr|Mr|Ms|Mrs|St|vs|e\.g|i\.e|Jr|Sr|No)\.)\s+|\n+/)[0] || '').trim();
}

// 1. A first sentence about the sender ("I'm Gary from…", "We build…"): the reader closes the email before the part
// that's for them. Their situation comes first, then why it's relevant to them, then the value.
const SENDER_OPENER =
  /^(?:i['’]m\b|i am\b|i['’]ve (?:built|founded|started)\b|my name\b|my (?:company|team|startup|business|product)\b|i (?:build|built|run|founded|lead|sell|make|started)\b|we (?:build|built|help|make|sell|run|started)\b|we(?:['’]re| are) an?\b|our (?:company|team|product|platform|software|startup)\b|i work (?:at|with|for|on|in)\b)/i;
const NAME_HERE = /^[\p{Lu}][\p{Ll}'’-]+ here\b/u;
// 2. A demo pitch, not a meeting between peers.
const DEMO = /\bshow you (?:how|what|around)\b|\bwalk you through\b|\bwalk-?throughs?\b|\bdemo(?:s|nstration)?\b|\bset aside\b|\bquick call to show\b/gi;
// 6. A follow-up that opens by pointing at the earlier email instead of saying again what's offered.
const BACK_REFERENCE =
  /^(?:(?:for|about|re:?|regarding|on) (?:the|my|our) (?:[\p{L}-]+ ){0,2}(?:walk-?through|demo|meeting|call|chat|note|email|message|conversation|offer)\b|as (?:i |we )?(?:mentioned|said|wrote|promised)\b|as per\b|following (?:up|on)\b|further to\b|per my\b|circling back\b|(?:just )?(?:checking|following) in\b|to follow up\b|picking (?:this )?up (?:on|from)\b|bumping\b)/iu;
// Clock times written in a message: 11:10, 14h10, 2:15pm, 9.45am.
const CLOCK = /(?<![\d.,:$€£])(\d{1,2})(?::|h(?=\d))(\d{2})(?!\d)(\s?[ap]\.?m\.?)?|(?<![\d.,:$€£])(\d{1,2})\.(\d{2})\s?([ap]\.?m\.?)/gi;
const ANY_TIME = /(?<![\d.,:$€£])\d{1,2}(?::|h(?=\d)|\.(?=\d{2}\s?[ap]\.?m))\d{2}(?!\d)|(?<![\d.,:$€£])\d{1,2}\s?[ap]\.?m\.?(?![\p{L}])/iu;
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WD_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const WISH_OPENER = /^(?:i['’]d like\b|i would like\b|let['’]s\b|let us\b)/i;
// A meeting place belongs in the confirmation: booth 42037, Hall G, stand 12, table 4, or the event's own meeting_place.
const PLACE = [/\bbooth\s*(?:no\.?\s*|number\s*|#\s*)?\d/i, /\bhall\s+(?:\d+|[A-HJ-Z]\b)/i, /\bstand\s*(?:no\.?\s*|#\s*)?\d/i, /\btable\s*(?:no\.?\s*|#\s*)?\d/i];
const ZONE = /(?<![\p{L}\d])(?:PT|PST|PDT|ET|EST|EDT|UTC|GMT|CET|CEST|CST|CDT|MST|MDT)(?![\p{L}\d])/u;
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_DAY = new RegExp(`(?<![\\p{L}])(?:${MONTHS})\\.?,?\\s+(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?(?![\\d:])|(?<![\\d:])\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})(?![\\p{L}])`, 'iu');
const MAY_DAY = /(?<![\p{L}])May\s+\d{1,2}(?:st|nd|rd|th)?(?![\d:])|(?<![\d:])\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?May(?![\p{L}])/u;
const AMPM = /(?<![\p{L}])[ap]\.m\b\.?|(?<![\d.,:$€£])\d{1,2}(?::\d{2})?\s?[ap]m(?![\p{L}])/i;
const OFFERS_TIME = /(?<![\d.,:$€£])\d{1,2}(?::|h(?=\d))\d{2}(?!\d)|(?<![\d.,:$€£])\d{1,2}\s?[ap]\.?m\b/i;
// Places a time zone might be named by ("New York time", the event's city, the zone in a slot label).
function placeAndTimeProblems(text, ctx) {
  const out = [];
  const place = [ctx.meetingPlace && String(ctx.meetingPlace).trim()].filter((p) => p && p.length >= 3);
  const hit = PLACE.map((r) => r.exec(text)).find(Boolean) || place.map((p) => new RegExp(esc(p), 'i').exec(text)).find(Boolean);
  if (hit)
    out.push(`names a meeting place ("${hit[0].trim()}") before they say yes: ask for the time at the event; where to find you goes in the confirmation`);
  const zone = ZONE.exec(text);
  if (zone) out.push(`names a time zone ("${zone[0]}"): they are at the event, so say the time as a person would, "9:00" or "14:30"`);
  const cities = [
    ctx.eventCity,
    ...(ctx.slotLabels || []).map((l) => (/\d{2}:\d{2}\s+(.+?)\s+time\b/i.exec(String(l)) || [])[1])
  ].filter(Boolean);
  const cityTime =
    cities.map((c) => new RegExp(`(?<![\\p{L}])${esc(c)}\\s+time\\b`, 'iu').exec(text)).find(Boolean) ||
    /(?<=[a-z,;] )(?:[A-Z][\p{L}.'’-]+ ){1,3}time\b/u.exec(text);
  if (cityTime) out.push(`says "${cityTime[0].trim()}": leave the city or zone out, they are at the event and it is their local time`);
  const ap = AMPM.exec(text);
  if (ap) out.push(`writes "${ap[0].trim()}": write times as 9:00 or 14:30, not a.m. or p.m. or am/pm`);
  const offering = text.split(/(?<=[.?!])\s+|\n+/).filter((s) => OFFERS_TIME.test(s));
  const md = offering.map((s) => MONTH_DAY.exec(s) || MAY_DAY.exec(s)).find(Boolean);
  if (md) out.push(`puts a month by the day ("${md[0].trim()}") in the sentence with the times: the event is the reference, write "Tue 1st at 9:00"`);
  return out;
}

export function writingProblems(draft, ctx) {
  const out = [];
  const body = String(draft.body || '');
  const text = withoutOptout(body, ctx);
  const subject = String(draft.subject || '');
  const first = firstSentence(text);
  if (!ctx.senderOpeningOk && (SENDER_OPENER.test(first) || NAME_HERE.test(first)))
    out.push(
      `opens with you, not them ("${first.slice(0, 60)}"): open with their situation, then why it's relevant to them, then the value; who you are fits in one short clause after that`
    );
  // A demo the reader's own history names (a CRM "Demo scheduled") may be named; any other is a pitch.
  const demoOk = /\bdemo/i.test(String(ctx.factText || ''));
  const demo = [...`${subject}\n${text}`.matchAll(DEMO)].map((m) => m[0]).filter((w) => !(demoOk && /^demo/i.test(w)));
  if (demo.length)
    out.push(
      `pitches a demo ("${demo[0]}"): ask for a conversation between peers about their business, not a showing of your product`
    );
  // A first message that opens on the sender's wish ("I'd like to compare...", "Let's...") instead of the reader.
  if (WISH_OPENER.test(first))
    out.push(`opens with a wish ("${first.slice(0, 40)}"): open with their situation, not "I'd like", "I would like", "Let's" or "Let us"`);
  out.push(...placeAndTimeProblems(text, ctx));
  if (draft.channel === 'email' && !ctx.followup) {
    if (subject.includes('?')) out.push('its subject asks a question: say it as a short statement');
    const name = fold(firstName(ctx.contact?.name || '').toLowerCase());
    if (name.length >= 2 && new RegExp(`(?<![\\p{L}\\d])${esc(name)}(?![\\p{L}\\d])`, 'iu').test(fold(subject.toLowerCase())))
      out.push(`its subject has their first name (${firstName(ctx.contact.name)}): leave names out of the subject`);
  }
  // 4. Times on the hour or the half hour, the way people book. A time already offered (an older slot a sent
  // message gave) may still be named.
  const offered = new Set(
    (ctx.slotLabels || []).map((l) => (/, (\d{2}):(\d{2})/.exec(String(l)) || []).slice(1).join(':')).filter(Boolean)
  );
  for (const m of text.matchAll(CLOCK)) {
    let h = Number(m[1] ?? m[4]);
    const mm = m[2] ?? m[5];
    const ap = String(m[3] ?? m[6] ?? '').toLowerCase();
    if (h > 23 || Number(mm) > 59 || mm === '00' || mm === '30') continue;
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    const key = `${String(h).padStart(2, '0')}:${mm}`;
    if (offered.has(key) || (!ap && offered.has(`${String(h + 12).padStart(2, '0')}:${mm}`))) continue;
    out.push(`offers ${m[0].trim()}: times go on the hour or half hour (9:00, 9:30), the way people book`);
    break;
  }
  if (ctx.followup) {
    if (BACK_REFERENCE.test(first))
      out.push(
        `refers back to the earlier email ("${first.slice(0, 50)}"): assume they never read it; say in one short clause what you offer and why it matters to them, then the new thing, then the times`
      );
    if (ctx.previousBody) {
      const n = wordCount(text),
        p = wordCount(withoutOptout(ctx.previousBody, ctx));
      if (n >= p) out.push(`a follow-up is shorter than the message before it (this one is ${n} words; that one was ${p})`);
    }
    if (ctx.lastTouch) out.push(...closingProblems(text, ctx));
  }
  return out;
}

// The last message of a sequence is a short closing note: it says it's the last, names the days the user is at the
// show, and asks only yes or no (no times to weigh).
function closingProblems(text, ctx) {
  const out = [];
  if (!/\b(?:last|final)\b/i.test(text)) out.push(`the last message says it's the last ("Last note from me on this")`);
  const days = (ctx.eventDays || []).map((d) => new Date(`${d}T12:00:00Z`));
  const named = days.some((d) =>
    new RegExp(`\\b(?:${WD[d.getUTCDay()]}|${WD_FULL[d.getUTCDay()]})\\b|(?<![\\d:.])${d.getUTCDate()}(?:st|nd|rd|th)\\b`, 'i').test(text)
  );
  if (days.length && !named) {
    const say = (d) => `${WD[d.getUTCDay()].replace(/^./, (c) => c.toUpperCase())} ${d.getUTCDate()}${ordinal(d.getUTCDate())}`;
    out.push(`the last message names the days you're at the show (${say(days[0])}${days.length > 1 ? ` to ${say(days[days.length - 1])}` : ''})`);
  }
  if (ANY_TIME.test(text)) out.push('the last message asks only yes or no: leave the times out');
  return out;
}
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// What the checks warn about without failing: the critic weighs them, and the drafter sees them.
export function draftWarnings(draft, ctx) {
  const out = [];
  const text = withoutOptout(String(draft.body || ''), ctx);
  const subject = String(draft.subject || '');
  if (draft.channel === 'email' && !ctx.followup && subject.length > 40)
    out.push(`subject is ${subject.length} characters: about 40 at most reads best (a few words on the angle)`);
  // 5. The show's full long name, said more than once, when it has a shorter one.
  const names = eventNamesOf(ctx);
  const long = names[1] || names[0];
  const shorter = names.filter((n) => n.length < String(long || '').length && n !== ctx.eventName);
  if (long && shorter.length) {
    const times = (`${subject}\n${text}`.match(new RegExp(`(?<![\\p{L}\\d])${esc(long)}(?![\\p{L}\\d])`, 'giu')) || []).length;
    if (times > 1) {
      const short = (ctx.eventAliases || [])[0] || (names[1] && names[1] !== ctx.eventName ? names[1] : shorter[0]);
      out.push(`uses the show's full name ("${long}") more than once: after the first mention say "${short}", or "the ${kindOf(ctx.eventName)}"`);
    }
  }
  // 7. More about the sender than about the reader.
  const me = (text.match(/\b(?:i|i['’](?:m|ve|d|ll)|me|my|mine|we|we['’](?:re|ve|d|ll)|our|ours|us)\b/gi) || []).length;
  const you = (text.match(/\b(?:you|your|yours|you['’](?:re|ve|d|ll))\b/gi) || []).length;
  if (me > you) out.push(`says I/we/our/my ${me} times and you/your ${you}: write about them more than about you`);
  return out;
}
const kindOf = (name) => (String(name || '').match(/\b(expo|summit|conference|forum|festival|week|show|congress|fair)\b/i) || ['', 'show'])[1].toLowerCase();

// Every name that counts for the event: its own, a short name the user gave it, and the forms read from it.
function eventNamesOf(ctx) {
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
  return [
    ctx.eventName,
    bare,
    head && head.length >= 2 ? head : null,
    acronym,
    kindless && kindless.split(/\s+/).length >= 2 ? kindless : null,
    cityless && cityless !== bare && cityless.split(/\s+/).length >= 2 ? cityless : null,
    ...(ctx.eventAliases || [])
  ].filter(Boolean);
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
  // An RFC 2047 encoded word (=?UTF-8?B?…?=): a mail app may show it decoded, as text nobody approved.
  if (/=\?[^?\s]*\?[bq]\?[^?\s]*\?=/i.test(subject))
    out.push('its subject has an encoded word (=?…?=), which a mail app may show as other text: write it out plainly');
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
