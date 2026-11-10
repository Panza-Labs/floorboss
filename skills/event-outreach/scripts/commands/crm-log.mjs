// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// CRM logging: contacts to add, records read back, what to log for each sent message, and the export.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { allowedPath, home } from '../../../../lib/paths.mjs';
import { need } from '../../../../lib/args.mjs';
import { readJson, writeJson, writeText } from '../../../../lib/jsonio.mjs';
import { toCsv } from '../../../../lib/csv.mjs';
import { wallParts, pad } from '../../../../lib/tz.mjs';
import { awayUntil } from '../../../../lib/ledger.mjs';
import { validateCreated } from '../../../connectors/scripts/tasks.mjs';
import { loadConfig } from '../../../../lib/config.mjs';
import { ctxOf, crmPending, crmIdOf, led } from './context.mjs';
import { recordText } from './saved-drafts.mjs';

// Everyone messaged at this event, for the CRM (import it so the next export knows) and for teammates (they
// load it with --known, so nobody on the team pitches the same person cold).
export function exportContacted(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const rows = [];
  for (const [id, s] of Object.entries(c.state)) {
    // A note to a colleague isn't contact with the attendee: only touches whose draft was a message count. A meeting
    // confirmation (touch 0) is a message to them, so it counts.
    const sent = Object.entries(s.sent || {})
      .filter(([t]) => s.touches?.[t]?.kind !== 'coordinate')
      .sort((a, b) => a[1].localeCompare(b[1]));
    const f = c.folded.people[id] || {};
    // A bounce with no new address leaves its send unsent, but they were written to: listed, as bounced.
    if (!sent.length && !s.stopped && !f.bounced) continue;
    const ct = c.byId[id] || {};
    const back = awayUntil(f, c.today);
    // A no read from the mailbox or CRM folds as declined; one the user recorded, as a reply whose outcome is declined.
    // Most telling first: a stop overrides everything (nobody may contact them); a meeting that stands is where
    // things are now; a no, or a meeting called off and not booked again, is final for this event; then any other
    // reply; a bounce (the address is dead); an out-of-office, while they're still away (a reply says more); else
    // no reply yet.
    const outcome = s.stopped
      ? 'asked not to be contacted'
      : s.booked
        ? 'meeting booked'
        : f.declined || f.outcome === 'declined'
          ? 'declined'
          : f.cancelled
            ? 'cancelled'
            : s.replied
              ? 'replied'
              : f.bounced
                ? 'bounced'
                : back
                  ? `away until ${back}`
                  : 'no reply yet';
    const start = s.booked ? s.booked_start || c.slotById[s.booked]?.start : null;
    const w = start ? wallParts(new Date(start), c.event.time_zone) : null;
    rows.push({
      name: ct.name || '',
      email: ct.email || '',
      company: ct.company || '',
      event: c.event.name,
      messages_sent: sent.length,
      last_contacted: sent.length ? sent[sent.length - 1][1] : '',
      outcome,
      unsubscribed: s.stopped ? 'yes' : 'no',
      owner: c.settings.crm_user_name || '',
      meeting_time: w ? `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.hh)}:${pad(w.mm)}` : ''
    });
  }
  const file = join(c.paths.dir, 'contacted.csv');
  // New columns go at the end: CRM imports set up on the old ones keep working.
  writeText(file, toCsv(['name', 'email', 'company', 'event', 'messages_sent', 'last_contacted', 'outcome', 'unsubscribed', 'owner', 'meeting_time'], rows));
  return {
    file,
    people: rows.length,
    note: 'Import this into your CRM (unsubscribed = opt-out), and send it to teammates: they load it with --known so nobody pitches these people cold.'
  };
}

// contact-list --event <slug>: people about to get (or already sent) an email who aren't in the connected CRM.
// They're added before their first message, so the CRM's mailbox sync files their replies on a record floorboss
// reads by id. Written to contact-list.json (the guard lets a create through only for an item there, as
// written) and crm-new-contacts.csv (for an import when no create tool is connected).
export function contactList(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  c.config = loadConfig();
  const items = [];
  for (const [id, s] of Object.entries(c.state)) {
    const ct = c.byId[id];
    if (!crmPending(c, id)) continue;
    if (s.stopped || s.removed || s.dropped || c.blocked(id)) continue;
    // An approved or sent email message (a note to a colleague isn't contact with them).
    const emailed = Object.entries(s.touches || {}).some(
      ([t, x]) =>
        Number(t) > 0 &&
        x.kind !== 'coordinate' &&
        ((x.approved && /@/.test(x.approved.to || '')) || (x.sent && !/linkedin|app|grip|brella|swapcard/i.test(x.sent.channel || '')))
    );
    if (!emailed) continue;
    const [first, ...rest] = String(ct.name || '')
      .trim()
      .split(/\s+/);
    items.push({
      key: id,
      id,
      name: ct.name,
      first_name: first || '',
      last_name: rest.join(' '),
      email: ct.email,
      company: ct.company || '',
      title: ct.title || '',
      listed_at: c.now.toISOString(),
      // Let through to the CRM once already (the guard's marker), with no id saved: looked up, never created again.
      ...(existsSync(join(c.paths.dir, 'released', `crm-${id}`)) ? { released: true } : {})
    });
  }
  const file = join(c.paths.dir, 'contact-list.json');
  writeJson(file, items);
  const csv = join(c.paths.dir, 'crm-new-contacts.csv');
  writeText(
    csv,
    toCsv(
      ['first_name', 'last_name', 'email', 'company', 'title', 'source'],
      items.map((x) => ({ ...x, source: `floorboss: ${c.event.name}` }))
    )
  );
  const recipe = c.config.connectors?.['crm.create_contact'] || null;
  return {
    to_add: items.length,
    people: items.map((x) => `${x.name} (${x.company})`),
    file,
    csv,
    connected: recipe ? `${recipe.server} · ${recipe.tool}` : null,
    rule: recipe
      ? 'Create one record per item with the crm.create_contact recipe, the values exactly as listed. Never update, merge or delete a record. Then save the ids with crm-records.'
      : 'No create tool is connected: the user imports crm-new-contacts.csv into their CRM, then each person is looked up by email (crm.lookup) and the ids are saved with crm-records --via import.'
  };
}

// crm-records --event <slug> --file <json> [--via create|import|check]: the CRM ids of the people on contact-list.json,
// from the create tool's answers or from looking them up after the user's import.
export function crmRecords(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const wanted = readJson(join(c.paths.dir, 'contact-list.json'), []);
  const data = readJson(allowedPath(opts.file));
  const r = validateCreated(data, new Set(wanted.map((w) => w.id)));
  if (r.errors.length) return { saved: 0, errors: r.errors };
  // A created record is someone the guard let through to the create tool; and no two people share a CRM record,
  // or one person's replies, stops and cancellations would be read for the other.
  const viaCreate = !['import', 'check'].includes(opts.via);
  const others = new Map();
  for (const id of new Set([...Object.keys(c.triage.pre || {}), ...Object.keys(c.folded.people || {})])) {
    const ref = crmIdOf(c, id);
    if (ref) others.set(String(ref), id);
  }
  const seen = new Map();
  const bad = [];
  for (const x of r.records) {
    if (viaCreate && !existsSync(join(c.paths.dir, 'released', `crm-${x.id}`)))
      bad.push(`${x.id} was never let through to the create tool: look them up (--via check) instead`);
    const ref = String(x.crm_id);
    const owner = others.get(ref) ?? seen.get(ref);
    if (owner && owner !== x.id) bad.push(`${x.id}: CRM record ${ref} is already ${owner}'s; one record per person`);
    seen.set(ref, x.id);
  }
  if (bad.length) return { saved: 0, errors: bad };
  // "retry": people let through once whom the CRM, looked up by email just now, doesn't have (the create never
  // ran, or the user said no at the prompt): their marker goes, so they can be added.
  // Only on the user's own "add them" given after the marker was made: a "no" at the prompt is never undone by a
  // look-up alone.
  const yeses = c.entries.filter((e) => e.type === 'answered' && e.ask === 'crm_contacts' && e.value === 'create');
  const okSince = (id) => {
    const m = join(c.paths.dir, 'released', `crm-${id}`);
    const at = existsSync(m) ? Date.parse(readFileSync(m, 'utf8').trim()) || 0 : NaN;
    return yeses.some((e) => Date.parse(e.at) > at && (!Array.isArray(e.ids) || e.ids.includes(id)));
  };
  const asked =
    ['import', 'check'].includes(opts.via) && Array.isArray(data?.retry)
      ? data.retry.map(String).filter((id) => wanted.some((w) => w.id === id && w.released))
      : [];
  const retry = asked.filter(okSince);
  if (asked.length > retry.length)
    return {
      saved: 0,
      errors: [`Ask the user first whether to add ${asked.filter((id) => !okSince(id)).join(', ')} now (flow answer --ask crm_contacts), then save the retry.`]
    };
  for (const id of retry) rmSync(join(c.paths.dir, 'released', `crm-${id}`), { force: true });
  for (const x of r.records) led(c, { type: 'crm_created', id: x.id, crm_ref: x.crm_id, via: ['import', 'check'].includes(opts.via) ? opts.via : 'create' });
  // After an import, the look-up ran once for this list: whoever wasn't found is asked about again, not looked up in a loop.
  if (opts.via === 'import') led(c, { type: 'crm_import_checked', ids: wanted.map((w) => w.id) });
  // What's recorded leaves the list, so the guard can't let the same person be created twice.
  const done = new Set(r.records.map((x) => x.id));
  const left = wanted.filter((w) => !done.has(w.id));
  writeJson(join(c.paths.dir, 'contact-list.json'), left);
  return { saved: r.records.length, still_to_add: left.map((w) => `${w.name} (${w.company})`) };
}

// LinkedIn and event-app messages that went out but aren't logged in the CRM yet. Written to crm-log-list.json;
// the guard only lets a CRM log (connector call or typing in the CRM's web app) through for an item there,
// with its text as written. Email isn't listed: a mailbox the CRM syncs logs itself.
export function logList(opts) {
  need(opts, 'event');
  const c = ctxOf(opts.event, opts);
  const items = [];
  // Searched once and not in the CRM, or failed twice: off the list (the user is told; the outbox CSV has them).
  const tries = {};
  for (const e of c.entries)
    if (e.type === 'crm_log_result') {
      const k = `${e.id}:${e.touch}`;
      tries[k] ||= { not_found: 0, failed: 0 };
      if (e.result === 'not_found') tries[k].not_found++;
      else if (e.result === 'failed') tries[k].failed++;
    }
  const notInCrm = [],
    gaveUp = [],
    needOk = [];
  for (const [id, p] of Object.entries(c.folded.people)) {
    for (const [t, x] of Object.entries(p.touches || {})) {
      if (!x.sent || p.crm_logged?.[t]) continue;
      const tr = tries[`${id}:${t}`];
      // Not in the CRM: create them when the user said yes (always, or for this person), else list them.
      let create = false;
      if (tr?.not_found) {
        const mode = c.settings.crm_create_contacts || 'no';
        // The latest answer about this person decides: a no outranks the general yes and any older yes.
        const said = c.entries.filter((e) => ['crm_create_ok', 'crm_create_declined'].includes(e.type) && (e.ids || []).includes(id)).pop();
        const declined = said?.type === 'crm_create_declined';
        const ok = said?.type === 'crm_create_ok';
        if (!declined && (mode === 'yes' || (mode === 'ask' && ok))) create = true;
        else if (mode === 'ask' && !declined) {
          needOk.push({ id, name: c.byId[id]?.name, company: c.byId[id]?.company });
          continue;
        } else {
          notInCrm.push({ id, name: c.byId[id]?.name, company: c.byId[id]?.company });
          continue;
        }
        if ((tr.failed || 0) >= 2) {
          gaveUp.push({ id, name: c.byId[id]?.name });
          continue;
        }
      }
      if (tr?.failed >= 2) {
        gaveUp.push({ id, name: c.byId[id]?.name });
        continue;
      }
      const ct = c.byId[id];
      if (!ct) continue;
      const channel = x.sent.channel || (x.sent.via === 'email.send' ? 'email' : null);
      if (!channel || /^e-?mail$/i.test(channel) || x.sent.via === 'email.send') continue;
      // The text that went: what the user reported sending, else the approved draft (its write-once file,
      // named by its hash), and only then the working copy. The guard asks before any of it is typed, and says
      // when it isn't the approved draft.
      const d = recordText(c, x.approved?.hash) || recordText(c, x.sent.hash) || {};
      const body = x.sent.text || d.body || '';
      if (!body) continue;
      items.push({
        key: `${id}:${t}`,
        id,
        touch: Number(t),
        name: ct.name,
        company: ct.company,
        title: ct.title || null,
        email: ct.email || null,
        profile_url: ct.profile_url || null,
        crm_ref: crmIdOf(c, id),
        channel,
        sent_on: x.sent.date || String(x.sent_at || '').slice(0, 10),
        body,
        listed_at: c.now.toISOString(),
        ...(create ? { create: true } : {}),
        ...(c.settings.crm_fill_blanks === 'yes' && !create
          ? {
              fill: Object.fromEntries(
                [
                  ['linkedin', ct.profile_url],
                  ['title', ct.title]
                ].filter(([, v]) => v)
              )
            }
          : {})
      });
    }
  }
  // Replies read in LinkedIn or the app, when the user asked for them to be logged too.
  if (c.settings.log_replies === true)
    for (const [id, p] of Object.entries(c.folded.people))
      for (const r of p.received || []) {
        if (p.replies_logged?.[r.ext]) continue;
        const ct = c.byId[id];
        if (!ct) continue;
        items.push({
          key: `${id}:r:${r.ext}`,
          id,
          touch: null,
          reply_ext: r.ext,
          received: true,
          name: ct.name,
          company: ct.company,
          title: ct.title || null,
          email: ct.email || null,
          profile_url: ct.profile_url || null,
          crm_ref: crmIdOf(c, id),
          channel: r.source === 'linkedin' ? 'LinkedIn (received)' : `${c.event.app_name || 'event app'} (received)`,
          sent_on: String(r.at).slice(0, 10),
          body: r.text
        });
      }
  const file = join(c.paths.dir, 'crm-log-list.json');
  writeJson(file, items);
  return {
    to_log: items.length,
    file,
    how: c.settings.crm_log || null,
    ...(notInCrm.length
      ? {
          not_in_crm: notInCrm,
          not_in_crm_note: "Not in your CRM, so nothing was logged for them: add them as contacts (then they log next time), or use the outbox's CRM log CSV."
        }
      : {}),
    ...(gaveUp.length ? { gave_up: gaveUp } : {}),
    ...(needOk.length ? { need_ok: [...new Map(needOk.map((x) => [x.id, x])).values()] } : {})
  };
}

// crm-logged --event <slug> --key <id:touch> [--via connector|browser|user] [--ref <the CRM's id for the activity>]
export function crmLogged(opts) {
  need(opts, 'event', 'key');
  const c = ctxOf(opts.event, opts);
  const wanted = readJson(join(c.paths.dir, 'crm-log-list.json'), []);
  const it = wanted.find((w) => w.key === String(opts.key));
  if (!it) throw new Error(`${opts.key} isn't on the CRM log list: run log-list again.`);
  led(c, {
    type: 'crm_logged',
    id: it.id,
    touch: it.touch,
    via: String(opts.via || 'browser').slice(0, 20),
    crm_ref: opts.ref ? String(opts.ref).slice(0, 80) : null
  });
  writeJson(
    join(c.paths.dir, 'crm-log-list.json'),
    wanted.filter((w) => w.key !== it.key)
  );
  return { logged: it.key };
}

// open-log-window --event <slug> --said "<the user's yes>": 20 minutes to log the listed messages in the CRM's
// web app. Only the listed items' own text and details can be typed, and the user is asked before each
// message's text goes in; the browser opens only the CRM's contact, record, search and task pages.
export function openLogWindow(opts) {
  need(opts, 'event', 'said');
  const c = ctxOf(opts.event, opts);
  const items = readJson(join(c.paths.dir, 'crm-log-list.json'), []);
  if (!items.length) throw new Error('Nothing to log: run log-list first.');
  const until = new Date(c.now.getTime() + 20 * 60000).toISOString();
  led(c, { type: 'crm_log_opened', until, keys: items.map((x) => x.key), said: String(opts.said).slice(0, 200) });
  // One window at a time: an open send window ends here (its rules would refuse the log text).
  if (existsSync(join(home(), 'browser-send.json')))
    writeJson(join(home(), 'browser-send.json'), { ...readJson(join(home(), 'browser-send.json'), {}), closed: true });
  writeJson(join(home(), 'crm-log-window.json'), { event: c.event.slug, until, keys: items.map((x) => x.key) });
  return {
    open_until: until,
    items: items.length,
    rule: "In the CRM in the user's browser: find each contact (by email, else name and company), open their record, log the message as the CRM's LinkedIn-message activity (else a note) with its text exactly as listed and its sent date, save, and report what the page said. For an item with create: true that the search doesn't find, create a new contact with only its listed details first. For each field in an item's fill that is empty on the record, add the listed value. Never change a field that has a value, and never edit, merge or delete anything else. Type only the listed values (the message, the person's name, company, email, profile link, title, date); Claude Code asks the user before each message's text is typed."
  };
}

// crm-log-results --event <slug> --file <json>: [{"key","result":"logged"|"not_found"|"logged_out"|"failed","page_says","ref"}]
export function crmLogResults(opts) {
  need(opts, 'event', 'file');
  const c = ctxOf(opts.event, opts);
  const wanted = readJson(join(c.paths.dir, 'crm-log-list.json'), []);
  const rows = readJson(allowedPath(opts.file), []);
  const out = { logged: 0, not_found: 0, other: 0 };
  for (const r of Array.isArray(rows) ? rows : rows.results || []) {
    const it = wanted.find((w) => w.key === String(r.key));
    if (!it) continue;
    const result = ['logged', 'created', 'not_found', 'logged_out', 'failed'].includes(r.result) ? r.result : 'failed';
    // created: a new contact (only for an item listed with create), then the message logged on it.
    if (result === 'created' && !it.create) {
      led(c, { type: 'crm_log_result', id: it.id, touch: it.touch, result: 'failed', page_says: "created a contact floorboss didn't ask for" });
      out.other++;
      continue;
    }
    if (result === 'created') led(c, { type: 'crm_created', id: it.id, crm_ref: r.ref ? String(r.ref).slice(0, 80) : null });
    // Fields filled on an existing contact: only ones listed in its fill (and only when they were empty).
    const filled = (Array.isArray(r.filled) ? r.filled : []).map(String).filter((k) => it.fill && Object.prototype.hasOwnProperty.call(it.fill, k));
    if (filled.length && result === 'logged') led(c, { type: 'crm_filled', id: it.id, fields: filled });
    led(c, {
      type: 'crm_log_result',
      id: it.id,
      touch: it.touch,
      result,
      page_says: String(r.page_says || '').slice(0, 200),
      ...(it.reply_ext ? { reply_ext: it.reply_ext } : {})
    });
    if (result === 'logged' || result === 'created') {
      led(c, {
        type: 'crm_logged',
        id: it.id,
        touch: it.touch,
        via: 'browser',
        crm_ref: r.ref ? String(r.ref).slice(0, 80) : null,
        ...(it.reply_ext ? { reply_ext: it.reply_ext } : {})
      });
      out.logged++;
    } else if (result === 'not_found') out.not_found++;
    else out.other++;
    if (result === 'logged_out') led(c, { type: 'tool_failed', who: 'floorboss', task: 'crm.log', error: r.page_says || 'the CRM asks to log in' });
  }
  const done = new Set(
    (Array.isArray(rows) ? rows : rows.results || []).filter((r) => r.result === 'logged' || r.result === 'created').map((r) => String(r.key))
  );
  writeJson(
    join(c.paths.dir, 'crm-log-list.json'),
    wanted.filter((w) => !done.has(w.key))
  );
  try {
    writeJson(join(home(), 'crm-log-window.json'), { closed: true });
  } catch {
    /* best effort */
  }
  return out;
}
