// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// How many people at one company hear from the user, by the company's size. Writing to three people at a
// four-person shop reads as spam; three at a bank of 200,000 is ordinary account work. The size comes from a
// size or headcount column in the list or the CRM, else Claude's judgement at the fit step, else unknown.
// The user picks a scale at onboarding (or gives their own numbers), and "cap" at the gate still wins.

export const BANDS = ['micro', 'small', 'mid', 'large', 'enterprise'];
export const BAND_LABEL = { micro: '1-10 people', small: '11-50', mid: '51-500', large: '501-5,000', enterprise: 'over 5,000', unknown: 'size unknown' };

export const SCALES = {
  // The default: one at a small company, more as the company grows.
  scale: { micro: 1, small: 1, mid: 2, large: 3, enterprise: 5, unknown: 2 },
  // Selling to whole teams (an enterprise motion where several threads per account is normal).
  teams: { micro: 1, small: 2, mid: 3, large: 5, enterprise: 8, unknown: 3 },
  // One per company, whatever its size, unless the user names more.
  one: { micro: 1, small: 1, mid: 1, large: 1, enterprise: 1, unknown: 1 }
};

// A size cell as an export writes it ("51-200", "1,001-5,000", "10000+", "250", "Enterprise", "KMU") → a band.
export function bandOf(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[ \s]/g, ' ');
  if (!s) return null;
  if (/^(micro|solo|self.?employed|freelance|1 ?person)/.test(s)) return 'micro';
  if (/^(small|smb|kmu|klein|startup|start.?up)/.test(s)) return 'small';
  if (/^(mid|medium|mittel|mid.?market|midmarket)/.test(s)) return 'mid';
  if (/^(large|gro(ß|ss)|big)/.test(s)) return 'large';
  if (/^(enterprise|konzern|fortune|global|very large)/.test(s)) return 'enterprise';
  // "2.5k" is 2,500; "1.000" and "1,000" are a thousand; a year ("(2019)") isn't a headcount.
  const nums = (s.match(/\d[\d,.]*\s*k?/g) || [])
    .map((x) => {
      const raw = x.trim(),
        k = /k$/.test(raw);
      const digits = raw.replace(/k$/, '').trim();
      const n = k
        ? Number(digits.replace(',', '.')) * 1000
        : Number(/^\d{1,3}([.,]\d{3})+$/.test(digits) ? digits.replace(/[.,]/g, '') : digits.replace(',', '.'));
      return n;
    })
    .filter((n) => Number.isFinite(n));
  const counts = nums.length > 1 ? nums.filter((n) => !(n >= 1900 && n <= 2099 && Number.isInteger(n))) : [...nums];
  if (!counts.length) return null;
  nums.length = 0;
  nums.push(...counts);
  // A range is placed by its upper end ("51-200" is mid); "10000+" by its number.
  const n = Math.max(...nums);
  return n <= 10 ? 'micro' : n <= 50 ? 'small' : n <= 500 ? 'mid' : n <= 5000 ? 'large' : 'enterprise';
}

// The user's own numbers: "small 1, mid 2, large 4", "1 at small firms, 2 at mid-size", "one per company, but
// 3 at enterprises", "2 per company". Read clause by clause: a band word and the number in the same clause go
// together, whichever comes first; a clause with a number and no band sets every band not named elsewhere.
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const BAND_WORDS = [
  ['micro', /\b(micro|tiny|solo|1-10)\b/],
  ['small', /\b(small|11-50)\b/],
  ['mid', /\b(mid|medium|mid-?size\w*|51-500)\b/],
  ['large', /\b(large|big|501-5,?000)\b/],
  ['enterprise', /\b(enterprises?|huge|very large|5,?000\+)\b/],
  ['unknown', /\b(unknown|not sure)\b/]
];
export function parseScale(text, base = SCALES.scale) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => String(WORDNUM[w]));
  const named = {},
    all = [];
  for (const clause of t.split(/[,;]|\bbut\b|\band\b|\bthen\b/)) {
    const nums = (clause.replace(/\b\d+-\d+(,\d+)?\b|5,?000\+?/g, ' ').match(/\b\d{1,2}\b/g) || []).map(Number);
    const bands = BAND_WORDS.filter(([, re]) => re.test(clause)).map(([b]) => b);
    if (nums.length === 1 && bands.length) for (const b of bands) named[b] = Math.max(1, nums[0]);
    else if (nums.length === 1 && /per|each|every|everywhere|a company|max|at most|any/.test(clause)) all.push(Math.max(1, nums[0]));
    else if (nums.length > 1 && bands.length) return null; // "small 1 mid 2" with no commas: too easy to misread
  }
  if (!Object.keys(named).length && !all.length) return null;
  const out = { ...base };
  if (all.length) for (const b of Object.keys(out)) out[b] = all[0];
  Object.assign(out, named);
  return out;
}

// The setting, read: { mode, scale } from config.company_caps (missing means the default sliding scale).
export function scaleOf(settings = {}) {
  const cc = settings.company_caps;
  if (cc === 'off' || cc?.mode === 'off') return null;
  if (cc && typeof cc === 'object' && cc.scale) return { ...SCALES.scale, ...cc.scale };
  if (cc && SCALES[cc.mode || cc]) return SCALES[cc.mode || cc];
  return SCALES.scale;
}

// Each company's size, from what's known: a size column (list or CRM) first, then Claude's judgement at fit
// (the most common answer among that company's people). key → { band, from }.
export function companySizes({ contacts = [], crmRows = [], fits = {}, keyOf = (c) => c.company_key }) {
  const out = {};
  const vote = (k, band, from) => {
    if (!k || !band) return;
    out[k] ||= { votes: {}, from: {} };
    out[k].votes[band] = (out[k].votes[band] || 0) + (from === 'judged' ? 1 : 10);
    out[k].from[band] = out[k].from[band] === 'list' || out[k].from[band] === 'crm' ? out[k].from[band] : from;
  };
  for (const c of contacts) vote(keyOf(c), bandOf(c.company_size), 'list');
  for (const r of crmRows) vote(r.company_key, bandOf(r.company_size), 'crm');
  for (const c of contacts) {
    const b = fits[c.id]?.company_size;
    if (BANDS.includes(b)) vote(keyOf(c), b, 'judged');
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => {
      const band = Object.entries(v.votes).sort((a, b) => b[1] - a[1])[0][0];
      return [k, { band, from: v.from[band] }];
    })
  );
}
