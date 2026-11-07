// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Normalising names, companies and domains so matching is deterministic.

// Zero-width and soft-hyphen characters hide inside names and addresses ("Ma\u200Bx"): drop them first.
const INVISIBLE = /[\u00AD\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;
// Cyrillic and Greek letters that look Latin ("Аcme" with a Cyrillic А), folded when the text also has Latin.
const CONFUSABLE = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ӏ: 'l',
  ο: 'o',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x'
};
import { createHash } from 'node:crypto';
export function unconfuse(s) {
  const t = String(s ?? '').replace(INVISIBLE, '');
  if (!/[a-z]/i.test(t)) return t;
  return t.replace(/[\u0370-\u04FF]/g, (ch) => {
    const l = ch.toLowerCase();
    return CONFUSABLE[l] ? (ch === l ? CONFUSABLE[l] : CONFUSABLE[l].toUpperCase()) : ch;
  });
}

export function stripAccents(s) {
  return unconfuse(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/œ/g, 'oe');
}

export function clean(s) {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9@.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Honorifics and academic titles are dropped, so "Dr. med. Anna Weber" and "Anna Weber" match.
const TITLE_WORDS = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'miss',
  'dr',
  'dra',
  'prof',
  'professor',
  'med',
  'ing',
  'dipl',
  'mag',
  'lic',
  'arq',
  'sr',
  'sra',
  'srta',
  'herr',
  'frau',
  'mme',
  'mlle',
  'dott',
  'sir',
  'dame',
  'phd',
  'mba',
  'md',
  'jr',
  'sr'
]);

const CREDENTIAL =
  /^(phd|md|mba|pmp|cpa|cfa|esq|rn|pe|ceng|frcs|frcp|mrcp|cissp|cisa|cism|shrm-?cp|sphr|acca|ca|cma|llm|jd|msc|bsc|ma|ba|dds|dvm|od|np|pa-?c|facc|faia|leed ap|six sigma|jr|sr|ii|iii|iv)\.?$/i;

export function normPersonName(name) {
  // Pronouns and notes in brackets ("Li (he/him)", "Fox, Di (Hooli)") and credentials after a comma
  // ("Doe, PMP", "Ng, MBA, CFA") aren't part of the name.
  name = String(name ?? '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  for (let parts = name.split(','); parts.length > 1 && CREDENTIAL.test(parts[parts.length - 1].trim()); parts = name.split(','))
    name = parts.slice(0, -1).join(',');
  // "DOE Jane" → "Jane DOE": a surname in capitals written first, as delegate lists often do.
  const caps = /^\s*(\p{Lu}[\p{Lu}'-]+)\s+(\p{Lu}\p{Ll}[\p{L}' -]*)$/u.exec(name);
  if (caps && !/,/.test(name)) name = `${caps[2]} ${caps[1]}`;
  // "DOE-SMITH, Jane" → "Jane DOE-SMITH" (surname first, as many lists and CRMs write it).
  const flip = /^([^,]+),\s*([^,]+)$/.exec(String(name ?? '').trim());
  if (flip && !/^(jr|sr|ii|iii|iv|phd|md|mba)\.?$/i.test(flip[2].trim())) name = `${flip[2]} ${flip[1]}`;
  // Letters in any script stay: "张伟" and "Иван Петров" are names, not blanks.
  const words = stripAccents(name)
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .replace(/['-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = words.filter((w) => !TITLE_WORDS.has(w));
  return (kept.length ? kept : words).join(' ');
}

// Chinese, Japanese and Korean names are often written without a space ("张伟"): two or more characters count.
export function hasSurname(name) {
  const n = normPersonName(name);
  return n.split(' ').filter(Boolean).length >= 2 || /^[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]{2,}$/u.test(n);
}

const LEGAL_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'oy',
  'ab',
  'as',
  'aps',
  'kk',
  'pty',
  'pte',
  'pvt',
  'group',
  'holdings',
  'the',
  'sl',
  'lda',
  'kft',
  'sp',
  'zoo'
]);

const MULTI_SUFFIXES = [
  ['s', 'a', 'de', 'c', 'v'],
  ['sa', 'de', 'cv'],
  ['s', 'de', 'r', 'l', 'de', 'c', 'v'],
  ['s', 'de', 'r', 'l'],
  ['s', 'a', 'p', 'i', 'de', 'c', 'v'],
  ['s', 'a', 's'],
  ['s', 'a', 'r', 'l'],
  ['s', 'r', 'l'],
  ['s', 'p', 'a'],
  ['s', 'l', 'u'],
  ['s', 'l'],
  ['s', 'a'],
  ['s', 'c'],
  ['sp', 'z', 'o', 'o'],
  ['pty', 'ltd'],
  ['pte', 'ltd'],
  ['pvt', 'ltd'],
  ['private', 'limited'],
  ['co', 'ltd'],
  ['b', 'v'],
  ['n', 'v'],
  ['l', 'l', 'c'],
  ['e', 'u', 'r', 'l'],
  ['ltda'],
  ['eirl'],
  ['sapi'],
  ['sac'],
  ['saa'],
  ['cv']
].sort((a, b) => b.length - a.length);

export function companyKey(company) {
  const words = stripAccents(company)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && words[0] === 'the') words.shift();
  // Multi-word legal forms ("S.A. de C.V.", "S. de R.L.", "Pty Ltd", "Sp. z o.o."), longest first.
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    for (const form of MULTI_SUFFIXES) {
      if (words.length > form.length && form.every((w, i) => words[words.length - form.length + i] === w)) {
        words.splice(words.length - form.length);
        changed = true;
        break;
      }
    }
  }
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

// Takes an address as people paste it: "Jane Doe <jane@x.test>", "mailto:jane@x.test", quoted, with hidden
// characters. Returns the bare address, lower case, or null.
export function normEmail(email) {
  let e = String(email ?? '')
    .replace(INVISIBLE, '')
    .trim()
    .toLowerCase();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(e);
  if (angle) e = angle[1];
  e = e
    .replace(/^mailto:/, '')
    .replace(/^["'\s]+|["'\s;,]+$/g, '')
    .replace(/\?.*$/, '');
  return /^[^@\s"'<>(),;:]+@[^@\s"'<>(),;:]+\.[^@\s"'<>(),;:]+$/.test(e) ? e : null;
}

// The address without a "+tag" ("jane+events@x.test" is jane@x.test's inbox).
export function emailBase(email) {
  const e = normEmail(email);
  if (!e) return null;
  const [local, dom] = e.replace(/\+[^@]*@/, '@').split('@');
  // Gmail ignores dots in the local part: jane.doe.example@gmail.com is janedoe.example@gmail.com.
  return /^(gmail|googlemail)\.com$/.test(dom) ? `${local.replace(/\./g, '')}@${dom}` : `${local}@${dom}`;
}

// Every address in a line of text.
export function emailsIn(text) {
  return [
    ...new Set(
      (
        String(text ?? '')
          .replace(INVISIBLE, '')
          .match(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,}/gi) || []
      )
        .map(normEmail)
        .filter(Boolean)
    )
  ];
}

export function emailDomain(email) {
  const e = normEmail(email);
  return e ? e.split('@')[1] : null;
}

export const DEFAULT_SHARED_DOMAINS = Object.freeze([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'mail.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  'zoho.com',
  'fastmail.com',
  'nhs.net',
  'posteo.de',
  'posteo.net',
  'gmx.net',
  't-online.de',
  'freenet.de',
  'mail.ru',
  'yandex.com',
  'pm.me',
  'hey.com',
  'yahoo.es',
  'yahoo.fr',
  'hotmail.co.uk',
  'hotmail.es',
  'hotmail.fr',
  'orange.fr',
  'free.fr',
  'laposte.net',
  'libero.it',
  'virgilio.it',
  'btinternet.com',
  'naver.com'
]);

// Shared domains never stand for one company: webmail, government, military, national health.
export function isSharedDomain(domain, extra = []) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  const list = [...DEFAULT_SHARED_DOMAINS, ...extra.map((x) => String(x).toLowerCase().replace(/^@/, ''))];
  if (list.some((s) => d === s || d.endsWith('.' + s))) return true;
  // Webmail providers on any country domain (gmail.co.uk, outlook.com.br, yahoo.fr).
  if (/^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|aol|proton|protonmail|gmx|yandex|qq|163|zoho|fastmail|rediffmail)\./.test(d)) return true;
  // Government and military: .gov, .gov.xx, .mil, .gouv.fr, .gob.xx, .gc.ca and test variants.
  const labels = d.split('.');
  // Korea's go.kr and korea.kr, Japan's go.jp, the EU's europa.eu: one address domain, many bodies.
  return (
    labels.some((l) => ['gov', 'mil', 'gouv', 'gob', 'govt'].includes(l)) ||
    d.endsWith('.gc.ca') ||
    /(^|\.)(go\.kr|korea\.kr|go\.jp|go\.id|go\.th|gov\.vn|europa\.eu|bund\.de|admin\.ch|gv\.at|overheid\.nl)(\.(test|example))?$/.test(d)
  );
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Similarity of two strings in [0, 1]: the better of token overlap and edit-distance ratio.
export function similarity(a, b) {
  const x = String(a ?? ''),
    y = String(b ?? '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = new Set(x.split(' ')),
    ty = new Set(y.split(' '));
  const inter = [...tx].filter((t) => ty.has(t)).length;
  const jaccard = inter / new Set([...tx, ...ty]).size;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(jaccard, lev);
}

// Two company keys that probably name the same organisation: one is the other's leading words
// ("acme" / "acme freight services"), they match without spaces ("a b c logistics" / "abc logistics"), or one is
// the other's initials ("afs" / "acme freight services"). Used where a miss means contacting someone off-limits,
// so it errs towards a match; callers say "looks like" in the reason.
const ABBREV = {
  st: 'saint',
  ste: 'sainte',
  mt: 'mount',
  intl: 'international',
  int: 'international',
  corp: 'corporation',
  mfg: 'manufacturing',
  svcs: 'services',
  svc: 'services',
  tech: 'technology',
  technologies: 'technology',
  sys: 'systems',
  assoc: 'associates',
  bros: 'brothers',
  natl: 'national',
  univ: 'university',
  grp: 'group',
  hldgs: 'holdings',
  labs: 'laboratories',
  lab: 'laboratories',
  mgmt: 'management',
  dev: 'development',
  eng: 'engineering',
  solns: 'solutions',
  ctr: 'center',
  centre: 'center'
};
// "a f s" → "afs", "intl" → "international": spellings of one name line up before comparing.
const canonTokens = (k) =>
  k
    .split(' ')
    .map((w) => ABBREV[w] || w)
    .join(' ')
    .replace(/\b([a-z0-9]) and (?=[a-z0-9]\b)/g, '$1 ')
    .replace(/\b([a-z0-9]) (?=[a-z0-9]\b)/g, '$1')
    .split(' ');

export function companyRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = canonTokens(a),
    tb = canonTokens(b);
  if (ta.join(' ') === tb.join(' ')) return true;
  // A typo in a long name ("Acme Frieght"): two letters apart at most.
  const ja = ta.join(' '),
    jb = tb.join(' ');
  if (Math.min(ja.length, jb.length) >= 8 && Math.abs(ja.length - jb.length) <= 2 && levenshtein(ja, jb) <= 2) return true;
  const [short, long] = ta.join('').length <= tb.join('').length ? [ta, tb] : [tb, ta];
  const joined = short.join('');
  if (joined.length < 3) return false;
  // Leading whole words, compared with and without spaces.
  for (let i = 1; i <= long.length; i++) if (long.slice(0, i).join('') === joined) return true;
  // Initials: "afs" for "acme freight services", "nbs" for "northern bulk shipping".
  const initials = (t) =>
    t
      .filter((w) => !['and', 'of', 'the', 'de', 'la', 'für', 'fur'].includes(w))
      .map((w) => w[0])
      .join('');
  if (short.length === 1 && joined.length >= 2 && joined.length <= 5 && long.length >= 2 && initials(long) === joined) return true;
  return false;
}

// Common English short forms. Both spellings map to one key, so "Bob Smith" and "Robert Smith" meet.
const NICK = {
  robert: ['bob', 'rob', 'bobby', 'robbie', 'bert'],
  william: ['bill', 'will', 'billy', 'liam'],
  james: ['jim', 'jamie', 'jimmy'],
  michael: ['mike', 'mick', 'mikey'],
  richard: ['rick', 'dick', 'rich', 'ricky'],
  thomas: ['tom', 'tommy'],
  john: ['jack', 'johnny', 'jon'],
  jonathan: ['jon', 'jonny'],
  joseph: ['joe', 'joey'],
  charles: ['charlie', 'chuck', 'chas'],
  christopher: ['chris', 'kit'],
  daniel: ['dan', 'danny'],
  david: ['dave', 'davy'],
  edward: ['ed', 'eddie', 'ted', 'ned'],
  anthony: ['tony'],
  andrew: ['andy', 'drew'],
  matthew: ['matt'],
  nicholas: ['nick', 'nicky'],
  stephen: ['steve'],
  steven: ['steve'],
  benjamin: ['ben', 'benny'],
  samuel: ['sam', 'sammy'],
  alexander: ['alex', 'sasha', 'sandy'],
  timothy: ['tim'],
  patrick: ['pat', 'paddy'],
  peter: ['pete'],
  gregory: ['greg'],
  kenneth: ['ken', 'kenny'],
  ronald: ['ron', 'ronnie'],
  donald: ['don', 'donnie'],
  lawrence: ['larry'],
  gerald: ['gerry', 'jerry'],
  frederick: ['fred', 'freddie'],
  henry: ['hank', 'harry'],
  francis: ['frank'],
  raymond: ['ray'],
  elizabeth: ['liz', 'beth', 'betty', 'lizzie', 'eliza', 'libby'],
  katherine: ['kate', 'kathy', 'katie', 'kat', 'kay'],
  catherine: ['cathy', 'kate', 'cat'],
  margaret: ['maggie', 'meg', 'peggy', 'greta'],
  jennifer: ['jen', 'jenny'],
  susan: ['sue', 'susie'],
  patricia: ['pat', 'patty', 'trish'],
  deborah: ['deb', 'debbie'],
  rebecca: ['becky', 'becca'],
  victoria: ['vicky', 'tori'],
  alexandra: ['alex', 'sasha', 'lexi'],
  christine: ['chris', 'chrissy'],
  jessica: ['jess', 'jessie'],
  samantha: ['sam'],
  kimberly: ['kim'],
  abigail: ['abby'],
  barbara: ['barb'],
  dorothy: ['dot', 'dottie'],
  judith: ['judy'],
  pamela: ['pam'],
  cynthia: ['cindy'],
  theresa: ['terry', 'tess'],
  virginia: ['ginny'],
  frances: ['fran'],
  josephine: ['jo', 'josie'],
  madeline: ['maddie']
};
// Short form → the full names it can stand for ("chris": christopher, christine). Two first names match when
// they're equal or can stand for the same full name ("bob"/"rob", "chris"/"christine"), never because they
// share a short form ("christopher"/"christine", "patrick"/"patricia" stay apart).
const FULLS = new Map();
for (const [full, shorts] of Object.entries(NICK)) {
  FULLS.set(full, new Set([...(FULLS.get(full) || []), full]));
  for (const sh of shorts) FULLS.set(sh, new Set([...(FULLS.get(sh) || []), full]));
}
export function sameFirstName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const fa = FULLS.get(a),
    fb = FULLS.get(b);
  return !!(fa && fb && [...fa].some((x) => fb.has(x)));
}

// Same person by name: same surname, and first names that match as above or where one is an initial.
export function sameName(a, b, { initials = false } = {}) {
  const x = normPersonName(a).split(' ').filter(Boolean),
    y = normPersonName(b).split(' ').filter(Boolean);
  if (x.length < 2 || y.length < 2) return false;
  // A double-barrelled surname ("Doe-Smith") meets either part ("Doe"); any other surname must be equal.
  const lastX = x[x.length - 1],
    lastY = y[y.length - 1];
  if (lastX !== lastY && !x.slice(1).includes(lastY) && !y.slice(1).includes(lastX)) return false;
  if (sameFirstName(x[0], y[0])) return true;
  return initials && ((x[0].length === 1 && y[0][0] === x[0]) || (y[0].length === 1 && x[0][0] === y[0]));
}
const NICK_KEY = new Map([...FULLS.entries()].filter(([, f]) => f.size === 1).map(([k, f]) => [k, [...f][0]]));

// "bob smith" → "robert smith": first names folded to one spelling, for matching only.
export function nameMatchKey(name) {
  const w = foldTranslit(normPersonName(name)).split(' ').filter(Boolean);
  if (w.length) w[0] = NICK_KEY.get(w[0]) || w[0];
  return w.join(' ');
}

// "Mueller" and "Müller" (written without the umlaut: "Muller") meet: ae/oe/ue fold to a/o/u for matching.
export function foldTranslit(s) {
  return String(s)
    .replace(/([a-z])(a|o|u)e/g, '$1$2')
    .replace(/^(a|o|u)e/, '$1');
}

// A note in the user's words, as one line: control, format (bidi overrides, zero-width) and line-break
// characters become a space, so a note can't reorder what's shown or hide text from the user. Capped.
export const noteText = (s, cap = 300) =>
  String(s ?? '')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    .trim()
    .slice(0, cap);
// Text of several lines (a profile, an earlier message, a mailbox note): its line breaks kept, every other control
// or invisible character (a bidi override, a zero-width space, a carriage return) gone.
export const blockText = (s, cap = 4000) =>
  String(s ?? '')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[^\P{Cc}\n]+/gu, ' ')
    .trim()
    .slice(0, cap);

// How many paid lookups the user agreed to, from their words. "top 6" wins wherever it is in the sentence ("only 7
// credits left, so the top 6" means 6); otherwise the smallest number said, so a misread can only spend fewer
// credits than meant, never more. No number: all of them (max).
// The rules section of a voice file: only a heading at the start of a line counts (a quoted email can't open one).
export function voiceRulesOf(voice) {
  const m = /^## Rules from your feedback[ \t]*\r?$/m.exec(String(voice || ''));
  return m
    ? String(voice)
        .slice(m.index + m[0].length)
        .split(/\n## /)[0]
        .trim()
    : '';
}

// A company named by its file slug (the flow passes the slug, never the name, so no name reaches a shell command):
// the one company among names whose slug it is. None or several: refused.
// The slug a company is passed by: its file slug plus a short hash of the exact name, so two companies whose
// names slug alike ("C++ Labs", "C Labs") stay apart.
export const companySlug = (name) => `${fileSlug(name, 'x')}-${createHash('sha256').update(String(name)).digest('hex').slice(0, 6)}`;
export function companyFromSlug(names, slug) {
  const hits = [...new Set(names.filter(Boolean))].filter((n) => companySlug(n) === String(slug));
  if (hits.length !== 1)
    throw new Error(hits.length ? `"${slug}" fits more than one company: ${hits.join(', ')}.` : `No company on this event's list has the slug "${slug}".`);
  return hits[0];
}

export function lookupCount(text, max) {
  const t = String(text || '').toLowerCase();
  const topN = /top\s+(\d+)/.exec(t);
  const nums = [...t.matchAll(/\d+/g)].map((m) => Number(m[0]));
  return Math.max(0, topN ? Math.min(max, Number(topN[1])) : nums.length ? Math.min(max, ...nums) : max);
}

// A file name for a company (or any name): Latin letters with their accents dropped ("Müller" is "muller"), and when
// other scripts remain (Japanese, Cyrillic, Arabic…), a short hash of the name too, so two such names never share
// a file ("桜木ロボティクス" and "日向オートメーション" would both strip to nothing).
export function fileSlug(text, fallback = 'company') {
  const t = String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
  const ascii = t.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!/[^\x00-\x7f]/.test(t.replace(/[\s\p{P}\p{S}]+/gu, ''))) return ascii || fallback;
  const h = createHash('sha256').update(String(text).normalize('NFKC').trim().toLowerCase()).digest('hex').slice(0, 10);
  return ascii ? `${ascii}-${h}` : `${fallback}-${h}`;
}
