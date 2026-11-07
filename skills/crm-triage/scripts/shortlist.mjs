// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The shortlist: everyone resolved as warm or reach, ranked, trimmed by the user's "keep N" and the company
// caps. Must-meet people and people the user decided to reach are pinned: no limit or cap removes them (they
// do count toward a company's cap), and
// one that can't be reached is reported, never dropped in silence.
import { scaleOf, BAND_LABEL } from './sizes.mjs';
import { companyKey as keyOf, companyRelated, nameMatchKey, sameName, normPersonName, levenshtein } from '../../../lib/normalize.mjs';

// Can floorboss reach this person on the channels the user turned on? Email first; the event app and
// LinkedIn (the "paste" channel) only when on, and a LinkedIn link only when LinkedIn messages are.
export function reachable(c, settings, channel = null) {
  if (!c || channel === 'none') return false;
  const chans = settings.channels || ['email'];
  if (c.email && channel !== 'app' && chans.includes('email')) return true;
  if (c.phone && (settings.sending?.channels || []).includes('chat') && channel !== 'app') return true;
  if (!chans.includes('paste')) return false;
  const li = channel !== 'app' && /linkedin\.com\//i.test(c.profile_url || '');
  if (li) return settings.linkedin_messages !== false;
  return !settings.no_app;
}

// band: the company's size (sizes.mjs). A cap the user named for this company wins; then their "cap N" for every
// company (or the account_cap setting); then the sliding scale by size; "off" means no cap.
export function capFor(companyKey, settings, caps = {}, band = null) {
  let o;
  for (const [k, v] of Object.entries({ ...(settings.account_caps || {}), ...caps }))
    if (k !== '*' && companyRelated(keyOf(String(k).replace(/-/g, ' ')), companyKey)) o = v;
  if (o === 'all') return Infinity;
  if (Number.isFinite(Number(o)) && o !== null && o !== undefined) return Number(o);
  // The default for every company: the user's "cap 2" at the gate, else the setting.
  const all = caps['*'] !== undefined ? caps['*'] : settings.account_cap;
  if (all === 'off' || all === 'all') return Infinity;
  if (all != null) return Number(all);
  const scale = scaleOf(settings);
  return scale ? (scale[band || 'unknown'] ?? scale.unknown) : Infinity;
}

// Who a must-meet line names: a person ("Cy Ng", "Cy Ng (Big Bank)", "Cy Ng at Big Bank", "Cy Ng, Big Bank",
// "Cy Ng - Big Bank") or a company ("anyone at Bergmann"). Whole names only; the line is capped and its spaces
// collapsed first.
export function mustMeetHits(raw, contacts) {
  const text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (text.length < 3) return { hits: [], atCo: [] };
  const m = /^(.+?) ?(?:\(([^)]+)\)| at (.+)|, ?(.+)| [-–—] (.+))$/.exec(text);
  const name = (m ? m[1] : text).trim(),
    co = m ? (m[2] || m[3] || m[4] || m[5]).trim() : null;
  const hits =
    name.split(' ').length >= 2
      ? contacts.filter((c) => (nameMatchKey(c.name) === nameMatchKey(name) || sameName(c.name, name)) && (!co || companyRelated(keyOf(co), c.company_key)))
      : [];
  const co2 = /^(?:(?:all|anyone|everyone) )?(?:at )?(.+?)(?: (?:buyers?|people|staff|team|folks))?$/i.exec(text)?.[1];
  const atCo =
    !hits.length && co2 && co2.length >= 3 && /^(?:all|anyone|everyone|at) /i.test(text)
      ? contacts.filter((c) => c.company_key && companyRelated(keyOf(co2), c.company_key))
      : [];
  return { hits, atCo };
}

// mustMeet: lines from settings and who-to-meet. Returns per line: found ids, or near names to ask about.
export function mustMeetReport(lines, contacts, resolved) {
  const seen = new Set();
  const wanted = lines.filter((w) => {
    const k = String(w.text).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const pinned = new Set();
  const people = wanted.map(({ text, segment }) => {
    const { hits, atCo } = mustMeetHits(text, contacts);
    const found = hits.length ? hits : atCo;
    for (const c of found) pinned.add(c.id);
    if (found.length)
      return {
        name: text,
        segment,
        company: !hits.length || undefined,
        found: found.map((c) => ({ id: c.id, name: c.name, company: c.company, group: resolved[c.id]?.group, says: resolved[c.id]?.says }))
      };
    const key = (n) => normPersonName(n).replace(/[^a-z ]/g, '');
    const want = key(text.replace(/\(.*\)| at .*|,.*| [-–—] .*/i, ''));
    const near = contacts
      .filter((c) => {
        const k = key(c.name);
        return k && want && k !== want && levenshtein(k, want) <= 3 && k[0] === want[0];
      })
      .slice(0, 4);
    return {
      name: text,
      segment,
      found: false,
      note: near.length
        ? `not on the list as written; did you mean ${near.map((c) => `${c.name} (${c.company}, ${c.id})`).join(' or ')}? Ask; don't pick.`
        : 'not on this list (or spelled differently): check the list, or add them by hand'
    };
  });
  return { people, pinned, note: wanted.length ? `${people.filter((p) => p.found).length} of ${people.length} must-meet names are on the list.` : undefined };
}

// resolved: id → resolve() result. fits: id → fit. decisions: id → the user's decide group.
// chosen: people the user set to reach by name on check-these. They rank like anyone else (dozens of answers never
// push known people out), so keep N may cut them; when it does, the result line names them, never in silence.
export function shortlist({ contacts, resolved, fits, settings, keep, caps, pinned = new Set(), decisions = {}, sizes = {}, chosen = new Set() }) {
  const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
  const candidates = contacts.filter((c) => ['warm', 'reach'].includes(resolved[c.id]?.group) && reachable(c, settings, c.channel));
  const score = (c) => fits[c.id]?.score ?? (resolved[c.id].group === 'warm' ? 60 : 50);
  const isPinned = (c) => pinned.has(c.id) || decisions[c.id] === 'reach' || decisions[c.id] === 'warm';
  // People the user knows rank above strangers: warm first, then anyone else known (a CRM record, a customer, the
  // user's account), then cold reach. A cold stranger never pushes a customer out of "keep 40" on score alone.
  const known = (c) => {
    const r = resolved[c.id];
    return r.group === 'warm' || !!r.crm || r.rung === 'customer_rule' || !!r.as_new || !!r.account_note || !!c.known;
  };
  const tier = (c) => (resolved[c.id].group === 'warm' ? 0 : known(c) ? 1 : 2);
  candidates.sort((a, b) => isPinned(b) - isPinned(a) || tier(a) - tier(b) || score(b) - score(a) || a.id.localeCompare(b.id));
  const kept = [],
    held = [],
    overCap = new Map();
  const counts = new Map();
  const reps = [];
  const repOf = (k) => {
    let r = reps.find((x) => companyRelated(x, k));
    if (!r) {
      r = k;
      reps.push(k);
    }
    return r;
  };
  let pinnedKept = 0;
  for (const c of candidates) {
    const rep = repOf(c.company_key || c.id);
    const n = counts.get(rep) || 0;
    const band = sizes[rep]?.band || sizes[c.company_key]?.band || null;
    const cap = capFor(rep, settings, caps, band);
    if (keep?.segments && !isPinned(c) && !keep.segments.includes(fits[c.id]?.segment)) {
      held.push({ id: c.id, why: `not in segment ${keep.segments.join(', ')}` });
      continue;
    }
    if (!isPinned(c) && n >= cap) {
      held.push({ id: c.id, why: `over the company cap (${cap} for ${band ? BAND_LABEL[band] : 'a company of unknown size'})` });
      overCap.set(rep, {
        company: c.company,
        slug: rep.replace(/\s+/g, '-'),
        cap,
        size: band || 'unknown',
        size_from: sizes[rep]?.from || null,
        fit: (overCap.get(rep)?.fit || n) + 1
      });
      continue;
    }
    // "keep 40" is 40 people in all: pinned people come first and take places too; only when there are more of
    // them than N does the list go over, and the result line says by how many.
    if (!isPinned(c) && keep?.top != null && kept.length >= keep.top) {
      held.push({ id: c.id, why: `below your limit (keep ${keep.top})`, known: known(c) });
      continue;
    }
    kept.push(c.id);
    // A pinned person is never cut, but takes a place under the company cap ("cap Merriton at 4" means four
    // people in all).
    counts.set(rep, n + 1);
    if (isPinned(c)) pinnedKept++;
  }
  // Pinned people who can't be shortlisted are said out loud.
  const pinnedOut = [...pinned]
    .filter((id) => !kept.includes(id) && byId[id])
    .map((id) => ({ id, name: byId[id].name, group: resolved[id]?.group, says: resolved[id]?.says }));
  const over = keep?.top != null ? kept.length - keep.top : 0;
  // Known people the limit cut are named on the result line: a cut customer is never silent.
  const cutKnown = held.filter((h) => h.known).map((h) => ({ id: h.id, name: byId[h.id].name, company: byId[h.id].company }));
  const cutLine = cutKnown.length
    ? `; cut ${cutKnown.length} you know: ${cutKnown
        .slice(0, 8)
        .map((x) => `${x.name} (${x.company})`)
        .join(', ')}${cutKnown.length > 8 ? ` and ${cutKnown.length - 8} more` : ''}; say rescue <name> to keep them`
    : '';
  // Someone the user set to reach on check-these and the limit cut is named too, with how to keep them.
  const cutChosen = held
    .filter((h) => chosen.has(h.id) && !h.known && /below your limit|not in segment/.test(h.why))
    .map((h) => ({ id: h.id, name: byId[h.id].name, company: byId[h.id].company }));
  const chosenLine = cutChosen.length
    ? `; cut ${cutChosen.length} you said to reach on check-these: ${cutChosen
        .slice(0, 8)
        .map((x) => `${x.name} (${x.company})`)
        .join(', ')}${cutChosen.length > 8 ? ` and ${cutChosen.length - 8} more` : ''}; say rescue <name> to keep them`
    : '';
  const keptLine =
    keep?.top == null && !keep?.segments
      ? null
      : (keep?.top == null
          ? `segment ${keep.segments.join(', ')}`
          : over > 0
            ? `${keep.top} kept + ${over} must-meet or chosen by you (never cut: ${pinnedKept} in all)`
            : `${kept.length} kept (keep ${keep.top})`) +
        cutLine +
        chosenLine;
  return { ranked: kept, held, over_cap: [...overCap.values()], pinned_out: pinnedOut, kept_line: keptLine, cut_known: cutKnown, cut_chosen: cutChosen };
}
