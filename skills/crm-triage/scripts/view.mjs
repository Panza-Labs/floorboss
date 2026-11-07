// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Everything about an event, computed on read from the inputs, the confirmed mappings and the ledger: the
// contacts (duplicates merged, ids from the ledger), who each person is to the sender, the shortlist and the
// times offered. The triage verbs and the drafting step both read through here; nothing here decides anything
// the ledger doesn't already say.
import { companySizes } from './sizes.mjs';
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { allowedPath, notSensitive } from '../../../lib/paths.mjs';
import { readCsv, toCsv, decode } from '../../../lib/csv.mjs';
import { readJson, writeJson, writeText } from '../../../lib/jsonio.mjs';
import { loadEvent, contextFor, nowFrom } from '../../../lib/event.mjs';
import { saveConfig } from '../../../lib/config.mjs';
import { todayKeyIn, daysBetween } from '../../../lib/tz.mjs';
import { readLedger, fold, append } from '../../../lib/ledger.mjs';
import { companyKey, companyRelated, normPersonName, sameName, noteText, clean } from '../../../lib/normalize.mjs';
import {
  propose,
  applyMapping,
  validateMapping,
  fingerprint,
  readSource,
  writeSource,
  sourcePath,
  defaultStatusMeaning,
  dealStateOf,
  STOP_WORDS,
  INSTRUCTION_LIKE,
  listSources
} from './sources.mjs';
import { mergeRows, assignIds, mergeCrmRows } from './merge.mjs';
import { gatherEvidence, indexCrm, readAccounts, accountsFromCrm, earlierEvents } from './evidence.mjs';
import { resolve, sameHolder, ownerIsUserFor } from './resolve.mjs';
import { shortlist, mustMeetReport, mustMeetHits, reachable } from './shortlist.mjs';
import { parseDncReport } from './dnc.mjs';
import { readKnown } from './known.mjs';
import { overlay } from './enrich.mjs';
import { parseSegments } from '../../event-context/scripts/context-check.mjs';
import { validateCrmRecords, validateMailHistory } from '../../connectors/scripts/tasks.mjs';
import { assignSlots } from '../../slot-finder/scripts/assign.mjs';

export { INSTRUCTION_LIKE };
export const REMINDER = "Make sure you're allowed to use this data for outreach. See 'Your responsibility' in the README.";
export const INPUT_FILES = {
  attendees: 'attendees.csv',
  crm: 'crm.csv',
  'crm-records': 'crm-records.json',
  dnc: 'dnc.txt',
  accounts: 'accounts.csv',
  'mail-history': 'mail-history.json'
};

// ---------- the event, its inputs and its ledger ----------

export function ctxOf(slug, opts = {}) {
  const { event, config, settings, paths } = loadEvent(slug);
  const now = nowFrom(opts);
  const today = todayKeyIn(event.time_zone, now);
  const { entries, damaged } = readLedger(paths.ledger);
  const state = fold(entries, damaged);
  for (const d of [paths.inputs, paths.sources, paths.derived, paths.work]) if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { event, config, settings, paths, now, today, entries, state, slug };
}
export const log = (c, entry) => append(c.paths.ledger, entry, c.now);

// Where an input lives: inputs/<kind> first, then the paths an older event.json may still name. Those are
// read only from where lists are read (the data folder, the temp folder, the working folder): a path saved in
// event.json is never a way to read any file on the disk. One outside them stops triage, said plainly, rather
// than going on without (a CRM export left out would let opted-out people through).
export function inputFile(c, kind) {
  const inDir = join(c.paths.inputs, INPUT_FILES[kind]);
  if (existsSync(inDir)) return inDir;
  const legacy = { attendees: c.event.attendees_path || c.paths.attendees, crm: c.event.crm?.path, dnc: c.event.dnc_path, accounts: c.event.accounts_path }[
    kind
  ];
  if (!legacy || !existsSync(legacy)) return null;
  try {
    return allowedPath(legacy, { list: true });
  } catch (e) {
    throw new Error(`${e.message} Give it again with crm-triage inputs --kind ${kind} --file <file>, from a folder floorboss reads lists from.`);
  }
}

// ---------- column mappings ----------

export function tableFor(c, kind) {
  const path = inputFile(c, kind);
  if (!path) return null;
  const t = readCsv(notSensitive(path));
  return { path, headers: t.headers, records: t.records, encoding: t.encoding, flagged: t.flagged };
}

// The mapping for a file: the confirmed one for its fingerprint, else a fresh proposal (saved unconfirmed so
// load can read the file meanwhile, and so `next` knows to ask).
export function mappingFor(c, kind, table) {
  const fp = fingerprint(table.headers);
  const have = readSource(c.paths.dir, fp);
  if (have) return have;
  const p = propose(table.headers, table.records, kind);
  // A status map saved in settings (older events, the mock) decides meanings the proposal only guessed.
  if (kind === 'crm' && c.settings.status_map)
    for (const [st, mean] of Object.entries(c.settings.status_map)) if (st in p.values.status) p.values.status[st] = mean === 'ask' ? null : mean;
  // The same file layout confirmed at another of the user's events is used again, not asked again: the user
  // confirms a layout once. A status value that mapping never saw keeps the proposal's guess and, if there is
  // none, the mapping goes back to the user.
  const earlier = c.event.mock ? null : confirmedElsewhere(c, kind, fp);
  if (earlier) {
    const status = { ...p.values.status, ...(earlier.m.values?.status || {}) };
    const fresh = Object.keys(p.values.status).filter((k) => !(k in (earlier.m.values?.status || {})));
    const known = fresh.every((k) => status[k]);
    const m = {
      ...earlier.m,
      file: basename(table.path),
      values: { ...(earlier.m.values || {}), status },
      stop_like_cells: p.stop_like_cells,
      owner_values: p.owner_values,
      confirmed: known,
      reused_from: earlier.slug,
      ...(known ? { confirmed_at: c.now.toISOString() } : { proposed_at: c.now.toISOString(), new_statuses: fresh })
    };
    writeSource(c.paths.dir, m);
    if (known)
      log(c, {
        type: 'mapping_confirmed',
        who: 'floorboss',
        source: kind,
        fingerprint: fp,
        said: `the same columns you confirmed for ${earlier.name || earlier.slug}`
      });
    return m;
  }
  const m = {
    kind,
    fingerprint: fp,
    file: basename(table.path),
    headers: table.headers,
    columns: p.columns,
    values: p.values,
    stop_like_cells: p.stop_like_cells,
    confirmed: false,
    proposed_at: c.now.toISOString(),
    date_order_ambiguous: p.date_order_ambiguous,
    owner_values: p.owner_values
  };
  writeSource(c.paths.dir, m);
  return m;
}

// A confirmed mapping for this layout at another (real) event on this device, the latest confirmed first.
function confirmedElsewhere(c, kind, fp) {
  const root = join(c.paths.dir, '..');
  if (!existsSync(root)) return null;
  const found = [];
  for (const slug of readdirSync(root)) {
    if (slug === c.slug) continue;
    const ev = readJson(join(root, slug, 'event.json'), null);
    if (!ev || ev.mock) continue;
    const m = readSource(join(root, slug), fp);
    if (m?.confirmed && m.kind === kind && m.fingerprint === fp) found.push({ slug, name: ev.name, m });
  }
  return found.sort((a, b) => String(b.m.confirmed_at || '').localeCompare(String(a.m.confirmed_at || '')))[0] || null;
}

// ---------- reading everything about everyone ----------

export function readContacts(c) {
  const table = tableFor(c, 'attendees');
  if (!table) throw new Error(`No attendee list yet. Give it with inputs --event ${c.slug} --kind attendees --file <csv>.`);
  const m = mappingFor(c, 'attendees', table);
  const fields = Object.values(m.columns).map((x) => x.field);
  if (!fields.includes('company') || !(fields.includes('name') || fields.includes('first_name') || fields.includes('last_name')))
    throw new Error(
      `Couldn't find name and company columns in ${table.headers.join(', ')}. Confirm the mapping (propose-mapping, then confirm-mapping --file) pointing at them.`
    );
  const ov = overlay(applyMapping(table.records, m), readJson(join(c.paths.dir, 'enriched.json'), {}));
  const merged = mergeRows(ov.rows, { sharedDomains: c.settings.shared_domains || [] });
  const { contacts, entries, merges } = assignIds(merged.contacts, c.state.people);
  for (const e of entries) log(c, e);
  for (const mg of merges) log(c, { type: 'person_merged', who: 'floorboss', id: mg.id, into: mg.into, why: mg.why });
  // What the user said about each person stands: their spelling of a name, their channel, their notes.
  for (const ct of contacts) {
    const p = c.state.people[ct.id];
    if (p?.renamed_to) ct.name = p.renamed_to;
    if (p?.email_override) {
      ct.emails = [...new Set([p.email_override, ...ct.emails])];
      ct.email = p.email_override;
    }
    // Addresses this person had on earlier lists still count for holds (a stop under an old address stands).
    for (const k of p?.keys || []) if (k.startsWith('e:') && !ct.emails.includes(k.slice(2))) ct.emails.push(k.slice(2));
    ct.channel = p?.channel || null;
    ct.notes_from_user = p?.notes || [];
    ct.known = !!p?.known;
  }
  const gone = Object.entries(c.state.people)
    .filter(([id, p]) => !p.merged_into && !contacts.some((x) => x.id === id))
    .map(([id, p]) => ({ id, name: p.name }));
  return { table, mapping: m, contacts, visit: merged.visit, skipped: merged.skipped, filled: ov.filled, gone };
}

export function readCrm(c) {
  const recordsPath = inputFile(c, 'crm-records');
  const recipe = c.settings.connectors?.['crm.lookup'] || c.config.connectors?.['crm.lookup'];
  if (recordsPath && (recipe || !inputFile(c, 'crm'))) {
    const r = validateCrmRecords(readJson(recordsPath));
    const rows = r.records.map((x, i) => {
      const meanings = [x.status].filter(Boolean).map((v) => defaultStatusMeaning(v) ?? 'unknown');
      const deal_state = dealStateOf(x.deal_stage);
      return {
        line: i + 1,
        name: x.name || '',
        email: String(x.email || '').toLowerCase(),
        company: x.company || '',
        title: x.title || '',
        owner: x.holder || '',
        status: x.status || '',
        statuses: [x.status].filter(Boolean),
        meanings,
        opted_out: !!x.opted_out,
        last_contact: x.last_contact || null,
        // As for an export: a close date counts only when the status or the deal's stage says won.
        won_at: x.won_at && (meanings.includes('customer') || deal_state === 'won') ? x.won_at : null,
        rejected_at: null,
        deal: x.deal || '',
        deal_stage: x.deal_stage || '',
        deal_state,
        on_won_deal: deal_state ? deal_state === 'won' : x.on_won_deal,
        notes: String(x.notes || ''),
        stop_note: STOP_WORDS.test(`${x.status || ''} ${x.notes || ''}`) ? `${x.status || ''} ${x.notes || ''}`.trim().slice(0, 140) : null,
        profile_url: x.profile_url || '',
        crm_id: x.crm_id || ''
      };
    });
    const source = recipe ? `connector: ${recipe.server} · ${recipe.tool}` : 'connector';
    // The user gave an export too: both are read. The export fills what the lookup didn't return (notes, deals,
    // labels) and its stops hold; its mapping is confirmed like any export's.
    const table = recipe ? tableFor(c, 'crm') : null;
    if (table) {
      const m = mappingFor(c, 'crm', table);
      const both = mergeCrmRows(rows, applyMapping(table.records, m));
      return {
        rows: both.rows,
        source: `${source}, and the export ${basename(table.path)}`,
        not_found: r.not_found,
        mapping: m,
        table,
        both: { looked_up: rows.length, export_rows: table.records.length, matched: both.matched, filled: both.filled }
      };
    }
    return { rows, source, not_found: r.not_found, mapping: null };
  }
  const table = tableFor(c, 'crm');
  if (!table) return null;
  const m = mappingFor(c, 'crm', table);
  return { rows: applyMapping(table.records, m), source: 'export', mapping: m, table };
}

export function readInputs(c, contacts) {
  const notes = [];
  const crm = readCrm(c);
  const crmIndex = crm ? indexCrm(crm.rows) : null;
  const ownerIsUser = ownerIsUserFor(c.settings, [...new Set((crm?.rows || []).map((r) => r.owner).filter(Boolean))]);
  const accountsPath = inputFile(c, 'accounts');
  const listed = accountsPath ? readAccounts(readCsv(notSensitive(accountsPath))) : [];
  // CRM rows whose person is on the list at an unrelated company now: they moved, and their old row makes no
  // account (an account note comes from someone still there, or from the accounts list).
  const listAt = new Map();
  for (const x of contacts)
    if (x.name && x.company_key) (listAt.get(normPersonName(x.name)) || listAt.set(normPersonName(x.name), []).get(normPersonName(x.name))).push(x.company_key);
  const left = new Set(
    (crm?.rows || []).filter((r) => {
      const at = listAt.get(normPersonName(r.name || ''));
      const rk = r.company_key || (r.company ? companyKey(r.company) : null);
      return at && rk && at.every((k) => k !== rk && !companyRelated(k, rk));
    })
  );
  const fromCrm = crm ? accountsFromCrm(crm.rows, { ownerIsUser, left }) : [];
  if (crm?.both)
    notes.push(
      `Read both the connected CRM (${crm.both.looked_up} looked up) and your export (${crm.both.export_rows} rows): the export filled in notes, deals or labels for ${crm.both.filled} of them, and a stop or opt-out in either one holds.`
    );
  const dncPath = inputFile(c, 'dnc');
  let dnc = [],
    dncNotes = [];
  if (dncPath) {
    const rep = parseDncReport(decode(readFileSync(dncPath)).text, { today: c.today });
    dnc = rep.entries;
    dncNotes = rep.notes;
  }
  // A plain name on the do-not-contact list that is a company on the attendee list is a company.
  const companyKeys = new Set(contacts.map((x) => x.company_key));
  const personNames = new Set(contacts.map((x) => normPersonName(x.name)));
  dnc = dnc.map((e) =>
    e.type === 'name' &&
    !personNames.has(e.value) &&
    [...companyKeys].some((k) => k && (k === companyKey(e.label || e.value) || companyRelated(companyKey(e.label || e.value), k)))
      ? { ...e, type: 'company', value: companyKey(e.label || e.value) }
      : e
  );
  // The mock reads only its own (invented) contacts file, never the user's real ones.
  const savedKnown = [...new Set([...(c.event.mock ? [] : c.config.known_contacts_paths || []), ...(c.settings.known_contacts_paths || [])])];
  // Read only from where lists are read, whatever the settings say (they can be set by a command too).
  const listOk = (p) => {
    try {
      allowedPath(p, { list: true });
      return true;
    } catch {
      return false;
    }
  };
  for (const p of savedKnown.filter((x) => existsSync(x) && !listOk(x)))
    notes.push(
      `The contacts file ${p} is outside the folders floorboss reads lists from, so it isn't read and doesn't count for "in touch": give it again with --known from the data folder or the working folder.`
    );
  const knownPaths = savedKnown.filter((x) => !existsSync(x) || listOk(x));
  const knownDays = Number(c.settings.known_export_days ?? 730);
  // A saved path that is no longer a plain file (a folder saved before floorboss checked) is left out, said so.
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const known = knownPaths
    .filter((p) => isFile(p))
    .flatMap((p) => readKnown(notSensitive(p)))
    .filter((k) => !k.date || daysBetween(k.date, c.today) <= knownDays);
  for (const p of knownPaths.filter((x) => !existsSync(x))) notes.push(`The contacts file ${p} isn't there any more, so it no longer counts for "in touch".`);
  for (const p of knownPaths.filter((x) => existsSync(x) && !isFile(x)))
    notes.push(`The contacts path ${p} isn't a file (a folder or a pipe), so it isn't read: give the contacts file itself.`);
  const earlier = earlierEvents(c.slug);
  for (const sk of earlier.skipped) notes.push(`An earlier event couldn't be read, so its people don't count as "in touch": ${sk}`);
  // Someone who said stop at any earlier event stays stopped, however long ago: only "in touch" fades.
  known.push(...earlier.people.filter((k) => k.stopped || !k.date || daysBetween(k.date, c.today) <= Number(c.settings.known_days ?? 180)));
  const mhPath = inputFile(c, 'mail-history');
  const mailbox = new Map();
  // Through the validator, so a missing they_replied reads as a conversation (held), the safe reading.
  if (mhPath) {
    const mh = validateMailHistory(readJson(mhPath, []));
    for (const p of mh.people || []) if (p.threads > 0) mailbox.set(p.email, p);
  }
  return {
    ownerIsUser,
    crm,
    crmIndex,
    accounts: [...listed, ...fromCrm],
    listedAccounts: listed,
    dnc,
    dncNotes,
    known,
    mailbox,
    notes,
    listKeys: [...companyKeys].filter(Boolean),
    sharedDomains: c.settings.shared_domains || [],
    today: c.today
  };
}

// The holds that stick once seen: a do-not-contact list entry, and an opt-out or stop (a bounce clears with a
// new address, so it doesn't). Before this, a person on the do-not-contact list was held only while the current
// file named them: importing the list again without them let them through. Now the ledger's hold_seen line
// holds them until the user's own decide reach or warm, made after seeing it, releases them (resolve.mjs).
const STICKY = (h) => (h.rung === 'do_not_contact' && /^on your do-not-contact list/.test(h.says)) || (h.rung === 'opted_out' && !/bounced/.test(h.says));
export function pastHolds(entries, id) {
  const seen = new Map();
  for (const e of entries || [])
    if (e.type === 'hold_seen' && e.id === id && STICKY(e) && !seen.has(e.says)) seen.set(e.says, { rung: e.rung, says: e.says, at: e.at });
  return [...seen.values()];
}

// A CRM record told apart by who it is: the same name and address in the same row.
const recordKey = (r) => (r ? `${normPersonName(r.name || '')}|${String(r.email || '').toLowerCase()}` : null);
// Match answers given at the user's other events ("c008 same-person crm:5"), for the same attendee and the same
// CRM record (the row says the same name and address): a match settled once isn't asked again. The mock and the
// real events never share them.
function earlierMatches(c) {
  const root = join(c.paths.dir, '..');
  const out = [];
  if (c.event.mock || !existsSync(root)) return out;
  for (const slug of readdirSync(root)) {
    if (slug === c.slug) continue;
    try {
      const ev = readJson(join(root, slug, 'event.json'), null);
      const led = join(root, slug, 'ledger.jsonl');
      if (!ev || ev.mock || !existsSync(led)) continue;
      const people = Object.entries(fold(readLedger(led).entries).people)
        .map(([id, p]) => ({ ...p, id }))
        .filter((p) => p.name && !p.merged_into && p.matches.some((m) => /^crm:\d+$/.test(m.ref || '')));
      // Their titles, as that event's list gave them (the ledger keeps no title): for an attendee with no address.
      const titles = Object.fromEntries(
        (readJson(join(root, slug, 'derived', 'contacts.json'), []) || []).filter((x) => x && x.id).map((x) => [x.id, x.title || null])
      );
      // Its CRM export: the copy taken in, or (older events) the path the event names.
      const file = [join(root, slug, 'inputs', 'crm.csv'), ev.crm?.path].find((f) => f && existsSync(f));
      if (file) allowedPath(file, { list: true });
      if (!people.length || !file) continue;
      const t = readCsv(file);
      const m = listSources(join(root, slug)).find((x) => x.kind === 'crm' && x.fingerprint === fingerprint(t.headers));
      if (!m) continue;
      const rows = applyMapping(t.records, m);
      for (const p of people)
        for (const x of p.matches) {
          // Only answers about a CRM row carry to another event (a bare "different-person" or "not-in-crm" doesn't).
          if (!/^crm:\d+$/.test(x.ref || '')) continue;
          const n = Number(String(x.ref || '').replace(/^crm:/, ''));
          if (rows[n])
            out.push({
              name: p.name,
              email:
                String(p.email || '')
                  .trim()
                  .toLowerCase() || null,
              company_key: p.company ? companyKey(p.company) : null,
              company_norm: clean(p.company || '') || null,
              title_norm: clean(titles[p.id] || '') || null,
              group: x.group,
              ref: x.ref,
              because: x.because,
              key: recordKey(rows[n]),
              event: ev.name || slug,
              at: x.at
            });
        }
    } catch {
      /* an event that can't be read carries nothing */
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// The attendee an earlier answer was about is this one: the same address, or (neither has one) the same name
// with the same company name and the same title. A same name alone is two people as often as one ("Ana Berg at
// Acme is not CRM row 0" says nothing about an Ana Berg at Globex), and the company key alone joins two companies
// ("Acme Inc" and "Acme Group" are both "acme"). Without a title on both sides, nothing is carried.
const sameAttendee = (k, ct) => {
  if (!sameName(k.name, ct.name)) return false;
  const email =
    String(ct.email || '')
      .trim()
      .toLowerCase() || null;
  if (k.email || email) return !!(k.email && email && k.email === email);
  const company = clean(ct.company || ''),
    title = clean(ct.title || '');
  return !!(k.company_norm && company && k.company_norm === company && k.title_norm && title && k.title_norm === title);
};
// A CRM row that holds whoever it is: opted out, asked to stop, do not contact, a hold or lost status, or a
// coworker's record. "Not this person" is never carried over one: the user answers it again at this event.
const rowHolds = (r, ownerIsUser) =>
  !!r &&
  (r.opted_out ||
    !!r.stop_note ||
    STOP_WORDS.test(r.notes || '') ||
    (r.meanings || []).some((m) => ['do_not_contact', 'hold', 'lost'].includes(m)) ||
    (!!r.owner && !(ownerIsUser || (() => false))(r.owner)));

export function resolveAll(c, contacts, inputs) {
  const resolved = {};
  const carried = earlierMatches(c);
  for (const ct of contacts) {
    const p = c.state.people[ct.id] || {};
    const own = p.matches || [];
    // The latest answer per record wins, and this event's own answer beats any carried one.
    const extra = [
      ...new Map(
        carried
          .filter((k) => {
            const row = inputs.crm?.rows?.[Number(k.ref.slice(4))];
            return (
              sameAttendee(k, ct) &&
              recordKey(row) === k.key &&
              !own.some((m) => m.ref === k.ref) &&
              !(k.group === 'different-person' && rowHolds(row, inputs.ownerIsUser))
            );
          })
          .map((k) => [k.ref, { group: k.group, ref: k.ref, because: `${k.because || k.group} (your answer at ${k.event})`, at: k.at }])
      ).values()
    ];
    resolved[ct.id] = resolve(ct, gatherEvidence(ct, inputs), {
      settings: c.settings,
      today: c.today,
      fit: c.state.fits[ct.id] || null,
      decision: p.decision || null,
      matches: [...extra, ...own],
      ownerIsUser: inputs.ownerIsUser,
      notes: p.notes || [],
      crmPresent: !!inputs.crm,
      bounced: !!p.bounced,
      pastHolds: pastHolds(c.entries, ct.id),
      reachable: (x) => reachable(x, { ...c.settings, no_app: c.event.no_app }, x.channel)
    });
  }
  return resolved;
}

// Every hold floorboss sees now (a do-not-contact or opt-out match, a coworker's), written once per person and
// wording to the ledger (hold_seen): what sticks, and what a send prompt says was later cleared.
export function recordHolds(c, v) {
  const have = new Set((c.entries || []).filter((e) => e.type === 'hold_seen').map((e) => `${e.id}|${e.says}`));
  // Before the user has said which CRM owner is them, every owner reads as a coworker: those holds aren't
  // written (the user's own records would show as a coworker's hold that "cleared" later).
  const ownerUnknown = !c.settings?.crm_user_name && !!v.inputs?.crm;
  for (const [id, r] of Object.entries(v.resolved || {})) {
    if (!/^c\d+$/.test(id)) continue;
    for (const h of r.hold_rungs || []) {
      if (ownerUnknown && h.rung === 'colleague') continue;
      if (have.has(`${id}|${h.says}`)) continue;
      have.add(`${id}|${h.says}`);
      (c.entries ||= []).push(log(c, { type: 'hold_seen', who: 'floorboss', id, rung: h.rung, says: String(h.says) }));
    }
  }
}

// Everything about the event right now: contacts, who they are, the shortlist and the times offered.
export function viewOf(c) {
  const read = readContacts(c);
  const inputs = readInputs(c, read.contacts);
  const resolved = resolveAll(c, read.contacts, inputs);
  // "hold Ana until Dana says yes" holds her company for Dana: nobody else there is written to, and nobody
  // there backfills a place the cap or keep N frees, unless the user decided for that person.
  const holdsAt = read.contacts.flatMap((x) => {
    const d = c.state.people[x.id]?.decision;
    const m = d?.group === 'skip' && /^on hold until (.+?) says yes/.exec(d.because || '');
    return m && x.company_key ? [{ key: x.company_key, until: m[1], name: x.name, company: x.company }] : [];
  });
  if (holdsAt.length)
    for (const ct of read.contacts) {
      const r = resolved[ct.id];
      if (c.state.people[ct.id]?.decision || !ct.company_key || !['reach', 'warm', 'check', 'in_touch', 'unjudged'].includes(r.group)) continue;
      const h = holdsAt.find((y) => y.key === ct.company_key || companyRelated(y.key, ct.company_key));
      if (h)
        resolved[ct.id] = {
          ...r,
          group: 'skip',
          rung: 'company_hold',
          says: `${h.company} is on hold until ${h.until} says yes (you held ${h.name}; "reach <name>" if this one is different)`,
          alternatives: [{ rung: r.rung, would_be: r.group, says: r.says }, ...(r.alternatives || [])]
        };
    }
  // The CRM couldn't be read and the user chose to run without it, confirming each person: nobody is written
  // to on floorboss's word alone. Each person floorboss would reach waits for the user's yes.
  if (c.state.answered.crm_independent?.value === 'confirm_each' && !inputs.crm) {
    for (const ct of read.contacts) {
      const r = resolved[ct.id];
      if (['reach', 'warm'].includes(r.group) && !c.state.people[ct.id]?.decision)
        resolved[ct.id] = {
          ...r,
          group: 'check',
          rung: 'crm_unchecked',
          says: `not checked against your CRM (it couldn't be read, and you chose to confirm each person): would be ${r.group} (${String(r.says).slice(0, 100)})`,
          alternatives: [{ rung: r.rung, would_be: r.group, says: r.says }, ...(r.alternatives || [])]
        };
    }
  }
  const segs = parseSegments(contextFor(c.settings, c.event).whoToMeet || '');
  const mmLines = [
    ...segs.flatMap((s) => (s.must_meet || []).map((m) => ({ text: m, segment: s.slug }))),
    ...(c.settings.must_meet || []).map((m) => ({ text: m, segment: null }))
  ];
  const mm = mustMeetReport(mmLines, read.contacts, resolved);
  // A decision pins only when it was a pick ("reach Ana" at the gate, a rescue); an answer on check-these settles
  // a question and then ranks like anyone else, so dozens of "reach" answers never push known people out of keep N.
  const decisions = Object.fromEntries(
    Object.entries(c.state.people)
      .filter(([, p]) => p.decision && !p.decision.answered_check)
      .map(([id, p]) => [id, p.decision.group])
  );
  // Each company's size (a size column, else Claude's judgement at fit), for the sliding cap.
  const sizes = companySizes({
    contacts: read.contacts,
    crmRows: (inputs.crm?.rows || []).map((r) => ({ ...r, company_key: r.company_key || (r.company ? companyKey(r.company) : null) })),
    fits: c.state.fits
  });
  // Set to reach (or warm) by name in the user's own answer on check-these (a line for that person, not a group
  // line like "everyone else: reach"): a "keep N" that cuts them says so by name.
  const chosen = new Set(
    Object.entries(c.state.people)
      .filter(([, p]) => p.decision?.answered_check && !p.decision.by_group && ['reach', 'warm'].includes(p.decision.group))
      .map(([id]) => id)
  );
  const sl = shortlist({
    contacts: read.contacts,
    resolved,
    fits: c.state.fits,
    settings: { ...c.settings, no_app: c.event.no_app },
    keep: c.state.keep,
    caps: c.state.caps,
    pinned: mm.pinned,
    decisions,
    sizes,
    chosen
  });
  // Times: the ones already quoted in a saved draft, an approved or a sent message stay (a draft that lost its
  // times would have to be rewritten); everyone else is placed in rank order.
  const slots = (readJson(c.paths.slots, { slots: [] }).slots || []).filter((s) => Date.parse(s.start) > c.now.getTime());
  const slotIds = new Set(slots.map((x) => x.id));
  const bookedBy = new Map(
    Object.entries(c.state.people)
      .filter(([, p]) => p.booked && !p.stopped)
      .map(([id, p]) => [p.booked, id])
  );
  const existing = {},
    topUp = [];
  for (const id of sl.ranked) {
    const p = c.state.people[id];
    if (!p) continue;
    const quoted = Object.values(p.touches)
      .filter((t) => t.hash && !t.dropped)
      .flatMap((t) => t.slot_ids || []);
    if (!quoted.length) continue;
    // A booked person holds only their booked time; a time someone else booked since is gone for this person.
    const ok = p.booked ? quoted.filter((x) => x === p.booked) : quoted.filter((x) => slotIds.has(x) && (!bookedBy.has(x) || bookedBy.get(x) === id));
    if (ok.length) existing[id] = [...new Set(ok)];
    if (ok.length && ok.length < new Set(quoted).size && !p.booked) topUp.push(id);
  }
  // Nobody is placed on a time someone has booked, and nobody who replied, booked or stopped needs a time.
  const free = slots.filter((s) => !bookedBy.has(s.id));
  const needTimes = sl.ranked.filter((id) => {
    const p = c.state.people[id];
    return !(p && (p.replied || p.booked || p.stopped));
  });
  const { assignments, openAsk, offers, capacity } = assignSlots(
    needTimes.map((id) => ({ id })),
    free,
    { max_offers: c.settings.max_offers, per_slot: c.settings.per_slot, existing, topUp }
  );
  for (const [id, p] of Object.entries(c.state.people)) if (p.booked && sl.ranked.includes(id)) assignments[id] = [p.booked];
  // A note to the colleague only for someone on-target (a segment, not unsure): the rest are plainly left out.
  const coordinate = read.contacts.filter((x) => resolved[x.id].group === 'colleague' && c.state.fits[x.id]?.segment).map((x) => x.id);
  return { ...read, inputs, resolved, sizes, segments: segs, mustMeet: mm, shortlist: sl, assignments, openAsk, offers, capacity, coordinate, slots };
}

// ---------- what the old readers still expect (event-outreach reads these until it moves to the ledger) ----------

const OLD_GROUP = {
  skip: 'suppressed',
  colleague: 'coordinate',
  warm: 'warm',
  reach: 'cold',
  check: 'check',
  in_touch: 'in_touch',
  unfit: 'not_drafted',
  unjudged: 'not_drafted',
  unreachable: 'not_drafted'
};
// The shapes the drafting step reads (contacts, pre/final groups, the shortlist), from the view.
export function compatOf(c, v) {
  const contacts = v.contacts.map((x) => ({
    id: x.id,
    name: x.name,
    title: x.title,
    company: x.company,
    company_key: x.company_key,
    group_key: x.company_key,
    email: x.email || null,
    emails_seen: x.emails.filter((e) => e !== x.email),
    phone: x.phone,
    profile_url: x.profile_url,
    notes: x.notes,
    booth: x.booth,
    location: x.location,
    attendee_type: x.attendee_type,
    contact_opt_in: x.contact_opt_in,
    source_lines: x.lines,
    researchable: x.researchable
  }));
  const pre = {},
    final = {};
  const rankedSet = new Set(v.shortlist.ranked);
  // Someone the user said to reach whose fit named no group (an "unsure" at check-these): the group whose "Who"
  // shares most words with their title, or the only group. Without one, their drafts had no segment at all.
  const segs = parseSegments(contextFor(c.settings, c.event).whoToMeet || '');
  const words = (t) =>
    new Set(
      String(t || '')
        .toLowerCase()
        .match(/[a-z]{3,}/g) || []
    );
  const guessSegment = (title) => {
    if (!segs.length) return null;
    if (segs.length === 1) return segs[0].slug;
    const tw = words(title);
    const score = (sg) => [...words(`${sg.name} ${sg.who || ''}`)].filter((w) => tw.has(w)).length;
    return [...segs].sort((a, b) => score(b) - score(a))[0].slug;
  };
  for (const ct of v.contacts) {
    const r = v.resolved[ct.id];
    const fit = c.state.fits[ct.id];
    const base = {
      reason: r.says,
      // Which rule placed them: a customer placed by the customer rule gets the user's words for customers.
      rung: r.rung || undefined,
      holder: r.holder || undefined,
      crm: r.crm || null,
      account_note: r.account_note || undefined,
      crm_stale: r.crm_stale || undefined,
      email_old_company: r.email_old_company || undefined,
      mailbox_note: r.mailbox_note || undefined,
      coworker: r.coworker || undefined,
      coworker_warn: r.coworker_warn || undefined,
      coworker_also: r.coworker_also || undefined,
      own_record: r.own_record || undefined,
      segment: fit?.segment || (['reach', 'warm'].includes(r.group) ? guessSegment(ct.title) : null)
    };
    pre[ct.id] = { ...base, group: ['reach', 'unjudged', 'unfit', 'unreachable'].includes(r.group) ? 'open' : OLD_GROUP[r.group] };
    let g = OLD_GROUP[r.group];
    if (r.group === 'reach' && !fit?.segment) g = 'not_drafted';
    const held = v.shortlist.held.find((h) => h.id === ct.id);
    final[ct.id] = {
      ...base,
      group: g,
      ...(r.group === 'warm' ? { warm_because: r.says, reason: fit?.reason || r.says } : {}),
      ...(r.group === 'unreachable' ? { unreachable: true } : {}),
      ...(r.group === 'check' && fit?.unsure ? { unsure: true } : {}),
      ...(held ? (/cap/.test(held.why) ? { over_cap: true } : { below_limit: held.why }) : {})
    };
    if (rankedSet.has(ct.id) && g === 'not_drafted') final[ct.id].group = 'cold';
  }
  const channels = Object.fromEntries(v.contacts.filter((x) => x.channel).map((x) => [x.id, x.channel]));
  const user_notes = Object.fromEntries(
    v.contacts
      .filter((x) => x.notes_from_user.length)
      .map((x) => [x.id, [...new Set(x.notes_from_user.map((n) => noteText(n.text)).filter(Boolean))].join('; ')])
  );
  const user_known = Object.fromEntries(v.contacts.filter((x) => x.known).map((x) => [x.id, true]));
  const removed = Object.entries(c.state.people)
    .filter(([, p]) => p.decision?.group === 'skip')
    .map(([id]) => id);
  const triage = {
    pre,
    final,
    ranked: v.shortlist.ranked,
    fits: c.state.fits,
    channels,
    user_notes,
    user_known,
    removed,
    keep: c.state.keep,
    loaded_at: c.now.toISOString(),
    prefilter: c.state.answered.prefilter?.value || undefined
  };
  const shortlist = {
    approved: v.shortlist.ranked,
    assignments: v.assignments,
    open_ask: v.openAsk,
    coordinate: v.coordinate,
    approved_at: c.state.answered.gate?.at || c.event.created_at || null
  };
  return { contacts, triage, shortlist };
}

export function writeCompat(c, v) {
  const { contacts, triage, shortlist } = compatOf(c, v);
  writeJson(c.paths.contacts, { contacts, visit: v.visit, skipped: v.skipped, registry: { next: 1, byKey: {}, retired: [] } });
  writeJson(c.paths.triage, triage);
  writeJson(c.paths.shortlist, shortlist);
  const order = new Map(v.shortlist.ranked.map((id, i) => [id, i + 1]));
  const rows = v.contacts.map((x) => ({
    id: x.id,
    rank: order.get(x.id) || '',
    group: triage.final[x.id].group,
    name: x.name,
    title: x.title,
    company: x.company,
    email: x.email || '',
    segment: c.state.fits[x.id]?.segment || '',
    reason: v.resolved[x.id].says || '',
    notes: x.notes ? `[from the list, untrusted] ${x.notes}` : ''
  }));
  rows.sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || a.id.localeCompare(b.id));
  writeText(c.paths.triageCsv, toCsv(['id', 'rank', 'group', 'name', 'title', 'company', 'email', 'segment', 'reason', 'notes'], rows));
}

export function writeDerived(c, v) {
  writeJson(join(c.paths.derived, 'contacts.json'), v.contacts);
  // What the view was built from, by count: the flow reads again when the ledger has more input files than this.
  // (By count, not the file's time against the ledger's: the ledger's clock can be moved, FLOORBOSS_NOW.)
  writeJson(join(c.paths.derived, 'resolved-stamp.json'), {
    inputs_added: readLedger(c.paths.ledger).entries.filter((x) => x.type === 'input_added').length,
    at: c.now.toISOString()
  });
  writeJson(
    join(c.paths.derived, 'resolved.json'),
    Object.fromEntries(
      Object.entries(v.resolved).map(([id, r]) => [
        id,
        {
          group: r.group,
          rung: r.rung,
          says: r.says,
          holder: r.holder,
          coworker: r.coworker || undefined,
          coworker_warn: r.coworker_warn || undefined,
          coworker_also: r.coworker_also || undefined,
          own_record: r.own_record || undefined,
          alternatives: r.alternatives,
          account_note: r.account_note,
          crm_stale: r.crm_stale || undefined,
          email_old_company: r.email_old_company || undefined,
          mailbox_note: r.mailbox_note,
          crm: r.crm,
          known_off_target: r.known_off_target || undefined
        }
      ])
    )
  );
  writeJson(join(c.paths.derived, 'shortlist.json'), {
    ranked: v.shortlist.ranked,
    held: v.shortlist.held,
    over_cap: v.shortlist.over_cap,
    pinned_out: v.shortlist.pinned_out,
    must_meet: [...(v.mustMeet?.pinned || [])],
    assignments: v.assignments,
    open_ask: v.openAsk,
    coordinate: v.coordinate,
    at: c.now.toISOString()
  });
  writeCompat(c, v);
}
