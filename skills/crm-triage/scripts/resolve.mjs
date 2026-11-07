// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Who a person is to the sender, decided in one place from the evidence gathered about them. One ladder,
// first rung wins; every later rung that would also have fired is kept as an alternative, so "check these"
// can show everything at once. Fuzzy evidence (a nickname, a lookalike company, an uncertain CRM match)
// never decides: it makes the decision "check", with the alternatives listed.
//
// groups: skip (leave alone) | colleague (a colleague holds them; a note to the colleague) | warm | reach
// (a stranger who fits) | check (the user decides) | unfit (no segment) | unreachable (no email)
import { daysBetween } from '../../../lib/tz.mjs';
import { stripAccents, companyKey, emailDomain, sameName, normPersonName, companyRelated } from '../../../lib/normalize.mjs';
import { STOP_WORDS, noteHistory, CAUTION_WORDS, INSTRUCTION_LIKE } from './sources.mjs';
import { INACTIVE_OWNER } from './evidence.mjs';

// The CRM may spell the user's name differently; crm_user_name may list several spellings with "|".
function nameParts(s) {
  let t = stripAccents(String(s ?? ''))
    .toLowerCase()
    .trim();
  const comma = /^([^,]+),\s*(.+)$/.exec(t);
  if (comma) t = `${comma[2]} ${comma[1]}`;
  return t
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
// Is a (a CRM owner value) the person b names (crm_user_name, several spellings with "|")? "Ines Moreau",
// "Moreau, Ines", "Moreau Ines", "I. Moreau" and "ines.moreau@paylark.example" are one person; case and accents
// never matter. An address counts only at one of domains (own_domains), never when none are given. initials: false leaves
// out the "I. Moreau" spellings (a coworker "Isabelle Moreau" could be written so too).
export function sameHolder(a, b, { domains = [], initials = true } = {}) {
  const raw = String(a ?? '')
    .trim()
    .toLowerCase();
  const mail = /^([^@\s]+)@([^@\s]+)$/.exec(raw);
  // An address is the user's only at one of their own domains; with none set, an address never is (anyone's
  // inbox can be called ines.moreau@…).
  const ownDomain =
    !!mail &&
    domains.some((d) => {
      const x = String(d).toLowerCase().replace(/^@/, '');
      return !!x && (mail[2] === x || mail[2].endsWith(`.${x}`));
    });
  for (const alt of String(b ?? '').split('|')) {
    if (raw && alt.trim().toLowerCase() === raw) return true;
    if (mail && !ownDomain) continue;
    // An address: its local part read as a name ("ines.moreau", "ines_moreau"; "imoreau" as an initial).
    const x = mail ? nameParts(mail[1].replace(/[._+-]+/g, ' ')) : nameParts(a),
      y = nameParts(alt);
    if (!x.length || !y.length) continue;
    if (x.join(' ') === y.join(' ')) return true;
    if (x.length < 2 || y.length < 2) {
      if (mail && initials && x.length === 1 && y.length > 1 && x[0] === `${y[0][0]}${y[y.length - 1]}`) return true;
      continue;
    }
    const [xf, xl, yf, yl] = [x[0], x[x.length - 1], y[0], y[y.length - 1]];
    if (xl === yl && xf === yf) return true;
    // Last name first, without the comma ("Moreau Ines").
    if (x.length === 2 && y.length === 2 && xf === yl && xl === yf) return true;
    if (!initials) continue;
    // "I. Moreau", "I Moreau", "Moreau I.": the first name's initial with the last name.
    const ini = (p, full) => p.length === 1 && full.length > 1 && p === full[0];
    if (xl === yl && (ini(xf, yf) || ini(yf, xf))) return true;
    if (x.length === 2 && xf === yl && ini(xl, yf)) return true;
  }
  return false;
}
// Is this CRM owner the user? Their name as the CRM spells it, or (a sheet that writes first names only) their
// first name, when no colleague they named has the same first name.
// knownOwners: every owner value in the CRM; a full name there with the same first name (a colleague "Sam
// Park" when the user is "Sam Lee") means a bare "Sam" could be either, so it isn't taken as the user.
export function ownerIsUserFor(settings = {}, knownOwners = []) {
  const me = settings.crm_user_name;
  if (!me) return () => false;
  const domains = settings.own_domains || [];
  const myParts = nameParts(String(me).split('|')[0]);
  const myFirst = myParts[0];
  const others = [...(settings.colleagues || []), ...knownOwners.filter((n) => nameParts(n).length > 1 && !sameHolder(n, me, { domains }))];
  const clash = others.some((n) => nameParts(n)[0] === myFirst);
  // "I. Moreau" is the user unless a colleague's name could be written so too (Isabelle Moreau).
  const initialClash = others.some((n) => {
    const x = nameParts(n);
    return x.length > 1 && x[x.length - 1] === myParts[myParts.length - 1] && x[0][0] === myFirst?.[0];
  });
  return (n) => {
    if (sameHolder(n, me, { domains, initials: false })) return true;
    if (!initialClash && sameHolder(n, me, { domains })) return true;
    const x = nameParts(n);
    return x.length === 1 && x[0] === myFirst && !clash;
  };
}

// contact: a merged contact. evidence: from gatherEvidence. ctx: { decision (the user's decide entry for
// this id, or null), fit, settings, today, crmPresent, notes (ledger notes), ownerIsUser(name) }.
// What a fuzzy CRM row would mean if it is this person: shown on check-these, so "same person" is never a
// blind choice and an opted-out or colleague-held row is said out loud.
function recordWouldBe(r) {
  if (r.opted_out || r.stop_note || STOP_WORDS.test(r.notes || '') || (r.meanings || []).includes('do_not_contact'))
    return 'skip (that record opted out or asked not to be contacted)';
  // Said with the meaning the user gave the status in the mapping ("Prospect" means hold), not the bare status.
  // ("skip" stays first: the refusal of a "reach" over a fuzzy match reads it.)
  const mi = (r.meanings || []).findIndex((m) => ['hold', 'lost'].includes(m));
  if (mi >= 0)
    return `skip: "${(r.statuses || [])[mi] || r.meanings[mi]}" means ${r.meanings[mi] === 'hold' ? 'hold (leave alone)' : 'a lost deal'} in your mapping, so they'd be left alone`;
  if (r.owner) return `depends on the owner (${r.owner})`;
  return 'depends on the record';
}

// Holds a user's earlier decision doesn't cover unless they saw them when deciding.
export const HARD_HOLDS = ['do_not_contact', 'off_limits_account', 'opted_out'];
// A coworker holds the record or the account (whatever coworker_contacts says to do about it); "the account is
// a coworker's, but this record is yours" is not a hold.
const isOwnerHold = (r) => r.rung === 'colleague' && (r.group !== 'reach' || !!r.coworker);

// The record's notes as the CRM has them, one line, capped: data a draft may use ("interested in carrier check-in").
const crmNotes = (t) =>
  String(t || '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || null;

// The deal on a record, said in one line: deal "Acme - Dock Scheduling" (Closed Lost).
const dealLine = (r) =>
  r.deal || r.deal_stage
    ? `deal${r.deal ? ` "${crmNotes(r.deal).slice(0, 120)}"` : ''}${r.deal_stage ? ` (${crmNotes(r.deal_stage).slice(0, 60)})` : ''}`
    : null;
// A record's notes that log a real conversation (met, a demo, a call): a fact, so never a cold first contact. A
// note that reads like an instruction to an AI is shown, never used to decide anything.
const historyOf = (r) => {
  const n = crmNotes(r.notes);
  return n && noteHistory(n) && !CAUTION_WORDS.test(n) && !INSTRUCTION_LIKE.test(n) && !STOP_WORDS.test(n) ? n.slice(0, 160) : null;
};
// The first status with a meaning ("Partner - active", "Customer"), else the first there is.
const relationStatus = (r) => {
  const i = (r.meanings || []).findIndex((m) => !['ignore', 'unknown'].includes(m));
  return (r.statuses || [])[i >= 0 ? i : 0] || r.status || '';
};
// What the record makes them: a partner (a live partner label), a customer (a customer status or a won deal), or
// nothing said.
const crmRelation = (r) => {
  const i = (r.meanings || []).indexOf('customer');
  if (i >= 0 && /\bpartner/i.test((r.statuses || [])[i] || '')) return 'partner';
  return i >= 0 || r.won_at || r.deal_state === 'won' ? 'customer' : null;
};

export function resolve(contact, evidence, ctx) {
  const { settings = {}, today, fit = null } = ctx;
  // Match answers (same person / different person) and the user's decision about the person are separate; an
  // older caller may still pass a match answer as the decision.
  const isMatch = (d) => d && (d.group === 'same-person' || d.group === 'different-person' || d.group === 'not-in-crm');
  const matches = [...(ctx.matches || []), ...(isMatch(ctx.decision) ? [ctx.decision] : [])];
  const decision = isMatch(ctx.decision) ? null : ctx.decision || null;
  const ownerIsUser = ctx.ownerIsUser || ownerIsUserFor(settings);
  const exact = evidence.filter((e) => e.sure === 'exact');
  const fuzzy = evidence.filter((e) => e.sure !== 'exact');
  const crm = exact.filter((e) => e.record).map((e) => e.record);
  // Rows from a job they've left (same name, the CRM at another company): linked, but a customer or deal at the
  // old company isn't theirs now.
  const movedRows = new Set(exact.filter((e) => e.record && e.moved).map((e) => e.record));
  const crmFuzzy = fuzzy.filter((e) => e.record);
  const rungs = []; // every rung that fires, in ladder order
  const fire = (rung, group, says, extra = {}) => rungs.push({ rung, group, says, ...extra });

  // 1. The user's decision.
  for (const m of matches) {
    // A settled match: the CRM row they named counts as exact (or not at all); the ladder continues.
    // A bare "different-person" (no CRM row named) settles every uncertain match, as "separate <id>" does; a bare
    // "same-person" settles the one uncertain CRM match there is (with several, the row must be named).
    // "not-in-crm" answers only the lookup that gave no answer: it settles no CRM row.
    const ref =
      m.group === 'not-in-crm'
        ? ''
        : m.ref
          ? String(m.ref).replace(/^crm:/, '')
          : m.group === 'different-person'
            ? 'all'
            : crmFuzzy.length === 1
              ? String(crmFuzzy[0].row)
              : '';
    for (const e of crmFuzzy)
      if (String(e.row) === ref || ref === 'all') {
        if (m.group === 'same-person') {
          if (e.sure !== 'exact') {
            e.sure = 'exact';
            crm.push(e.record);
          }
        } else e.sure = 'dismissed';
      }
    if (m.group === 'different-person' && ref === 'all') for (const e of fuzzy) if (e.from !== 'crm') e.sure = 'dismissed';
    // "Not in the CRM", said for the address they have now: the lookup that gave no answer is settled. Said for an
    // earlier address (before a bounce), it settles nothing.
    // (Someone with no address: the answer recorded with none settles them.)
    if (m.group === 'not-in-crm' && m.email != null && String(m.email).toLowerCase() === String(contact.email || '').toLowerCase())
      for (const e of fuzzy) if (e.unanswered) e.sure = 'dismissed';
  }
  if (decision) {
    fire(
      'user',
      decision.group,
      /^on hold until /.test(decision.because || '')
        ? `you said: ${decision.because}`
        : `you said: ${decision.group}${decision.because ? ` (${decision.because})` : ''}`
    );
  }

  // 2. Do not contact: the list, own company, named colleagues, the event's own opt-in "no".
  for (const e of exact.filter((x) => x.from === 'do-not-contact list')) fire('do_not_contact', 'skip', `on your do-not-contact list: ${e.says}`);
  const own = [].concat(settings.own_domains || []).map((d) => String(d).toLowerCase().replace(/^@/, ''));
  const dom = emailDomain(contact.email);
  if ((dom && own.some((d) => dom === d || dom.endsWith('.' + d))) || (settings.own_company && contact.company_key === companyKey(settings.own_company)))
    fire('do_not_contact', 'skip', 'your own company');
  if ((settings.colleagues || []).some((n) => sameName(n, contact.name) || normPersonName(n) === normPersonName(contact.name)))
    fire('do_not_contact', 'skip', 'a colleague you named');
  const optNo = exact.find((x) => x.opt_in === 'no');
  if (optNo && settings.event_optin_means !== 'app_only')
    fire(
      'do_not_contact',
      'skip',
      settings.event_optin_means === 'no_contact' ? "said no to contact on the event's list" : `${optNo.says} (what that means is your call: event_optin_means)`
    );

  // 3. An off-limits account covers everyone there.
  for (const e of exact.filter((x) => x.account?.off))
    fire('off_limits_account', 'skip', `account ${e.account.label} is off-limits (${e.account.from}${e.account.status ? `: ${e.account.status}` : ''})`);

  // 4. Opted out, or asked to stop, in the CRM, in the user's contacts, at an earlier event, or by email bounce.
  for (const r of crm) {
    if (r.opted_out) fire('opted_out', 'skip', 'opted out in the CRM');
    if (r.stop_note || STOP_WORDS.test(r.notes || '')) fire('opted_out', 'skip', `CRM note: "${(r.stop_note || r.notes).slice(0, 120)}"`);
    if ((r.meanings || []).includes('do_not_contact')) fire('opted_out', 'skip', `CRM status "${r.statuses[r.meanings.indexOf('do_not_contact')]}"`);
  }
  for (const e of exact.filter((x) => x.known?.stopped || x.known?.outcome === 'said stop')) fire('opted_out', 'skip', `asked not to be contacted (${e.says})`);
  if (ctx.bounced) fire('opted_out', 'skip', 'their email bounced and there is no new address');
  // A do-not-contact entry or an opt-out or stop floorboss saw before (a hold_seen line in the ledger) holds
  // even when the file it came from no longer has it: a re-imported list without them is not the user saying
  // they may be written to. Only the user's own decision after seeing it (decide reach or warm, whose
  // seen_holds names it, as for any hold) releases them.
  for (const h of ctx.pastHolds || []) {
    if (rungs.some((r) => r.says === h.says)) continue;
    if (decision && ['reach', 'warm'].includes(decision.group) && (decision.seen_holds || []).includes(h.says)) continue;
    fire(h.rung, 'skip', `${h.says} (seen ${String(h.at).slice(0, 16).replace('T', ' ')}; no longer in the file, still held until you release them)`, {
      sticky: true
    });
  }

  // 5. Rejected or lost, within the window.
  const rejMonths = Number(settings.rejected_months ?? 6);
  const rej = crm
    .map((r) => r.rejected_at)
    .filter(Boolean)
    .sort()
    .pop();
  // rejected_months 0 is the user's "no wait": a lost deal or a rejection holds nobody.
  if (rej && rejMonths > 0 && today && daysBetween(rej, today) <= rejMonths * 30.44)
    fire('rejected_or_lost', 'skip', `rejected on ${rej} (within ${rejMonths} months)`);
  else if (rej)
    fire(
      'rejected_or_lost',
      'reach',
      rejMonths > 0 ? `rejected on ${rej}, more than ${rejMonths} months ago: fair to approach` : `rejected on ${rej}; you said no wait after a rejection`,
      {
        note_only: true
      }
    );
  for (const r of crm) {
    const i = (r.meanings || []).indexOf('hold');
    if (i >= 0) fire('rejected_or_lost', 'skip', `CRM status "${r.statuses[i]}" means leave alone`);
    const lostAt = (r.meanings || []).indexOf('lost');
    // A status nobody gave a meaning to (a value new since the mapping was confirmed) waits for the user.
    const ui = (r.meanings || []).indexOf('unknown');
    if (ui >= 0)
      fire(
        'rejected_or_lost',
        'check',
        `the CRM status "${r.statuses[ui]}" has no meaning yet: say what it means (warm, leave alone, colleague, customer, lost, never contact)`
      );
    // A lost deal reads the same from a status or from the deal's own stage (the deal column, or crm.lookup's deal).
    const lost = lostAt >= 0 ? `CRM status "${r.statuses[lostAt]}"` : !movedRows.has(r) && r.deal_state === 'lost' ? `a lost ${dealLine(r)}` : null;
    if (lost && r.last_contact && today && daysBetween(r.last_contact, today) <= 45)
      fire('rejected_or_lost', 'check', `the CRM says ${lost}, but you were in touch on ${r.last_contact}: write again?`);
    // A lost deal (no rejected date on the row): within the window by its last contact it's left alone, older is
    // fair to approach, and with no date at all it could be last week, so it's left alone too.
    else if (lost && !r.rejected_at) {
      if (!rejMonths) fire('rejected_or_lost', 'reach', `${lost}; you said no wait after a lost deal`, { note_only: true });
      else if (!r.last_contact) fire('rejected_or_lost', 'skip', `${lost} (a lost deal, with no date to say when): left alone`);
      else if (today && daysBetween(r.last_contact, today) <= rejMonths * 30.44)
        fire('rejected_or_lost', 'skip', `${lost}, last contact ${r.last_contact} (a lost deal within ${rejMonths} months)`);
      else
        fire('rejected_or_lost', 'reach', `${lost}, last contact ${r.last_contact}, more than ${rejMonths} months ago: fair to approach`, { note_only: true });
    }
  }

  // 6. A colleague holds them: their own record's owner, else the account's owner. How careful to be is the
  // user's choice (coworker_contacts, or per coworker in coworker_overrides): leave (left alone), ask (check-these),
  // warn (drafted, listed at approval), mine (treated as the user's own). The holds above (do-not-contact,
  // off-limits, opt-out or stop, a recent loss) and the customer rule below apply whatever the choice.
  const ownRecord = crm.some((r) => r.owner && ownerIsUser(r.owner));
  const coworkerMode = (holder) => {
    const o = settings.coworker_overrides || {};
    const k = Object.keys(o).find((n) => holder && n.toLowerCase() === String(holder).toLowerCase());
    return (k && o[k]) || settings.coworker_contacts || 'leave';
  };
  const coworker = (says, holder) => {
    const mode = coworkerMode(holder);
    if (mode === 'ask') return fire('colleague', 'check', `${says}: write to them yourself, or leave them to ${holder || 'the owner'}?`, { holder });
    if (mode === 'warn' || mode === 'mine')
      return fire('colleague', 'reach', `${says} (you chose to write to coworkers' contacts${mode === 'warn' ? ', with a warning before sending' : ''})`, {
        note_only: true,
        coworker: holder || 'a coworker',
        coworker_warn: mode === 'warn'
      });
    return fire('colleague', 'colleague', says, { holder, ...(ownRecord ? { own_record: true } : {}) });
  };
  const ownPartner = (r, ci) => !!(r.owner && ownerIsUser(r.owner) && /^\s*partners?\s*$/i.test(r.statuses[ci] || ''));
  for (const r of crm) {
    const ci = (r.meanings || []).indexOf('coordinate');
    // A bare "Partner" label on a record the user holds is their own partner, not a colleague's contact: it is
    // read with the relationship rungs below. Any other colleague status holds, whoever the record's owner is
    // (owner fields often name whoever imported the records).
    if (ci >= 0 && !ownPartner(r, ci)) coworker(`CRM status "${r.statuses[ci]}"`, r.owner && !ownerIsUser(r.owner) ? r.owner : null);
    if (r.owner && !INACTIVE_OWNER.test(r.owner) && !ownerIsUser(r.owner))
      coworker(settings.crm_user_name ? `${r.owner} holds this relationship` : `${r.owner} holds this record (set crm_user_name if that's you)`, r.owner);
  }
  const ownDeal = crm.some(
    (r) =>
      !movedRows.has(r) &&
      r.owner &&
      ownerIsUser(r.owner) &&
      (r.won_at || r.on_won_deal === true || ['won', 'open'].includes(r.deal_state) || (r.meanings || []).some((m) => ['customer', 'warm'].includes(m)))
  );
  const crmAccountsOff = (a) => a && !a.off && a.from === 'crm' && settings.crm_accounts === 'off';
  for (const e of exact.filter((x) => x.account && !x.account.off && x.account.owner && !x.account.mine && !ownerIsUser(x.account.owner))) {
    // This person's own record is the user's: the coworker's account is a note, unless the coworker has an open
    // or won deal there (a coworker's won deal holds everyone at that company, the user's own contacts included).
    // A deal on this person's own record (the user's customer, or an open deal with them) keeps them the user's,
    // whatever a coworker has there. The user's cold records at a coworker's deal stay held, and the card lists
    // them (own_held).
    if (ownRecord && (!e.account.deal || ownDeal))
      fire(
        'colleague',
        'reach',
        `${e.account.owner} also works the ${e.account.label} account${e.account.deal ? ` (their record there says "${e.account.deal}")` : ''}, but this person's own record is yours${ownDeal ? ', with a deal' : ''}`,
        { note_only: true, coworker_also: e.account.owner }
      );
    // crm_accounts "off": the user said a colleague's records at a company don't cover everyone else there.
    // (An off-limits account from the CRM still holds: that's the account.off check above, not this rule.)
    else if (crmAccountsOff(e.account)) continue;
    else if (e.account.from === 'crm' && settings.crm_accounts !== 'apply')
      fire(
        'colleague',
        'check',
        `${e.account.owner} owns the ${e.account.label} account in the CRM (${e.account.records} records). Account rules from the CRM wait for your OK (crm_accounts: apply)`,
        { holder: e.account.owner }
      );
    else {
      // Their lost deal there: said, with whether it is recent (the lost-deal rule holds the person on that record,
      // not everyone at the company: they're held here as the coworker's account).
      const lost = e.account.lost;
      // No date on the record, but the CRM's note gives one ("Lost on price March 2026"): said, not hidden.
      const noteDate =
        (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d\d\b|\bq[1-4]\s+(?:19|20)\d\d\b|\b(?:19|20)\d\d-[01]\d\b/i.exec(
          `${e.account.owner_note || ''} ${e.account.note || ''}`
        ) || [])[0];
      const lostWhen = lost
        ? !lost.at
          ? noteDate
            ? `a lost deal with no date on the record (date in the note: ${noteDate})`
            : 'a lost deal with no date'
          : rejMonths > 0 && today && daysBetween(lost.at, today) <= rejMonths * 30.44
            ? `a lost deal within ${rejMonths} months`
            : `lost more than ${rejMonths} months ago`
        : null;
      const status = e.account.deal || lost?.status || null;
      // No brackets: the refusal that quotes this puts it in brackets of its own.
      const where =
        e.account.from === 'crm'
          ? status
            ? `: their CRM record says "${status}"`
            : ' in the CRM'
          : ` on your ${e.account.from}${status ? `, which says "${status}"` : ''}`;
      coworker(
        `${e.account.owner} owns the ${e.account.label} account${where}${lost ? `, ${lostWhen}; the lost-deal rule holds only the person on that record, the account holds everyone else there` : ''}${INACTIVE_OWNER.test(e.account.owner) ? '; that owner looks inactive, so check who holds it now' : ''}`,
        e.account.owner
      );
      // On the person's card and in any draft written to them anyway: whose account it is, and what it says.
      const detail = [status, e.account.owner_note].filter(Boolean).join(', ');
      fire('account', 'reach', `at ${e.account.owner}'s account ${e.account.label}`, {
        note_only: true,
        account_note: `at ${e.account.owner}'s account ${e.account.label}${detail ? ` (${detail})` : ''}`
      });
    }
  }

  // 7. No way to reach them (email only on this path): nothing below matters until they have an address.
  const canReach = ctx.reachable ? ctx.reachable(contact) : !!contact.email;
  if (!canReach) fire('unreachable', 'unreachable', contact.email ? 'no way to reach them on the channels you turned on' : 'no email address');
  else if (contact.researchable === false) fire('unreachable', 'unreachable', 'first name only and no email: add a surname or an address');

  // 8. Written to at another of the user's events (within known_days): held as in touch before the customer rule
  // and the warm rungs, so a customer or an open deal there never reads as a fresh warm note while that thread
  // runs. The mock and the real events never see each other (earlierEvents skips them).
  const otherEvent = (x) => x.known && !x.known.stopped && x.known.slug;
  for (const e of exact.filter(otherEvent)) fire('in_touch', 'in_touch', e.says);

  // 8b. The customer rule from onboarding.
  const rule = settings.customer_rule;
  // A won deal makes a customer, whatever the person's own status says.
  const isCustomer = crm.some((r) => !movedRows.has(r) && ((r.meanings || []).includes('customer') || r.won_at || r.deal_state === 'won'));
  const ownAccount = exact.find((x) => x.account && !x.account.off && (x.account.mine || (x.account.owner && ownerIsUser(x.account.owner))));
  // What the user's records say about the company, for a draft to anyone there: the account's status and the
  // account's own CRM note. At a customer account, someone with no record of their own still writes as to a
  // customer from it (fact source "account"), as someone with a record does from the CRM summary.
  const accNote = ownAccount?.account.note ? `; the CRM's note on the account: "${ownAccount.account.note}"` : '';
  const customerAccount =
    ownAccount && /customer|client|won/i.test(ownAccount.account.status || '')
      ? `your customer ${ownAccount.account.label} (CRM: "${ownAccount.account.status}")${accNote}`
      : null;
  // A live partner is said as one ("a partner (CRM status "Partner - active")"), never as a customer or a coworker.
  const partnerRow = crm.find((r) => !movedRows.has(r) && crmRelation(r) === 'partner');
  const customerWord = partnerRow ? `a partner (CRM status "${relationStatus(partnerRow)}")` : 'a customer';
  if (rule && (isCustomer || (ownAccount && /customer|client|won/i.test(ownAccount.account.status || '')))) {
    const won = crm
      .map((r) => r.won_at)
      .filter((d) => d && today && d <= today)
      .sort()
      .pop();
    const recent = won && daysBetween(won, today) <= Number(rule.recent_months) * 30.44;
    const onDeal = crm.some((r) => r.on_won_deal === true);
    const which = !isCustomer ? 'other' : recent ? 'recent' : onDeal ? 'on_deal' : 'other';
    // "Not on the won deal" only when the CRM has a deal column to say so: a connector gives the status alone.
    const dealData = isCustomer && crm.some((r) => typeof r.on_won_deal === 'boolean');
    const why =
      which === 'recent'
        ? `${customerWord} whose deal closed ${won} (within ${rule.recent_months} months)`
        : which === 'on_deal'
          ? `${customerWord}, and on the won deal`
          : `at a customer${won ? ` (deal closed ${won})` : ''}${dealData ? ', but not on the won deal' : ''}`;
    const act = rule[which];
    const cn = customerAccount ? { account_note: customerAccount } : {};
    if (!['warm', 'ask', 'hold', 'cold'].includes(act))
      fire('customer_rule', 'check', `${why}: your customer rule has no valid answer for this case (${which})`, cn);
    else if (act === 'hold') fire('customer_rule', 'skip', `${why}: left alone, as you set`, cn);
    else if (act === 'ask') fire('customer_rule', 'check', `${why}: contact them? (your customer rule says ask)`, cn);
    else if (act === 'warm') fire('customer_rule', 'warm', why, cn);
    else fire('customer_rule', 'reach', `${why}: treated as new, as you set`, { as_new: true, ...cn });
  } else if (isCustomer) {
    const cr = crm.find((r) => (r.meanings || []).includes('customer'));
    const wonDeal = crm.find((r) => r.deal_state === 'won');
    fire(
      'customer_rule',
      'warm',
      partnerRow
        ? customerWord
        : cr
          ? `a customer (CRM status "${cr.statuses[cr.meanings.indexOf('customer')]}")`
          : wonDeal
            ? `a customer (won ${dealLine(wonDeal)})`
            : 'a customer (CRM status "won")',
      customerAccount ? { account_note: customerAccount } : {}
    );
  } else if (ownAccount)
    fire('customer_rule', 'reach', `at your account ${ownAccount.account.label}`, {
      note_only: true,
      account_note: `at your account ${ownAccount.account.label}${ownAccount.account.status ? ` (${ownAccount.account.status})` : ''}${accNote}`
    });

  // 9. Already in touch (your contacts, your mailbox with a reply, an earlier event): held for a warm note.
  for (const e of exact.filter((x) => x.known && !x.known.stopped && !otherEvent(x))) fire('in_touch', 'in_touch', e.says);
  const mb = exact.find((x) => x.mailbox);
  if (mb?.mailbox.they_replied) fire('in_touch', 'in_touch', mb.says);

  // 10. Warm: a two-way CRM status, an open deal (a conversation going on), a note that logs
  // a real conversation, or a two-way last contact. A deal or a note from an old job isn't theirs now.
  for (const r of crm) {
    const wi = (r.meanings || []).indexOf('warm');
    const ci = (r.meanings || []).indexOf('coordinate');
    if (wi >= 0) fire('warm', 'warm', `CRM status "${r.statuses[wi]}"`);
    else if (ci >= 0 && ownPartner(r, ci)) fire('warm', 'warm', `CRM status "${r.statuses[ci]}" on your own record`);
    if (!movedRows.has(r) && r.deal_state === 'open') fire('warm', 'warm', `an open ${dealLine(r)}: a conversation going on`);
    // A stage floorboss doesn't know could be a lost deal by another name: the user says which it is.
    if (!movedRows.has(r) && r.deal_state === 'unclear')
      fire('warm', 'check', `the ${dealLine(r)}: floorboss doesn't know that stage. Is the deal open (warm), won (customer) or lost (leave alone)?`);
    const history = movedRows.has(r) ? null : historyOf(r);
    // A note reads as history, but anyone who can write into the CRM can write one: when the fit is unsure, the
    // user decides with the note in front of them.
    if (history)
      fire(
        'warm',
        fit?.unsure ? 'check' : 'warm',
        fit?.unsure ? `CRM history: "${history}", but the fit is unsure: write to them?` : `CRM history: "${history}"`
      );
    if (
      wi < 0 &&
      r.last_contact &&
      today &&
      !(r.meanings || []).some((m) => ['lost', 'ignore'].includes(m)) &&
      daysBetween(r.last_contact, today) <= (settings.warm_months ?? 12) * 30.44
    )
      fire('warm', 'warm', `last contact ${r.last_contact}`);
  }
  if (ctx.notes?.some((n) => n.known)) fire('warm', 'warm', 'you know them personally', { user_known: true });

  // 11. A stranger who fits, or doesn't.
  if (fit?.segment) fire('fit', 'reach', fit.reason || `fits ${fit.segment}`);
  else if (fit?.unsure) fire('fit', 'check', `unsure: ${fit.reason || 'vague title'}`);
  else if (fit) fire('fit', 'unfit', fit.reason ? `doesn't fit: ${fit.reason}` : "doesn't fit a segment");
  else fire('fit', 'unjudged', ctx.crmPresent === false ? 'not checked against a CRM; not judged yet' : 'not judged yet');

  // Fuzzy evidence that would change the answer goes to the user, unless they already settled it.
  // Fuzzy evidence that can't change the outcome isn't a question: a lookalike of the user's own account, or a
  // colleague's lookalike account when this person's own record is the user's.
  const live = fuzzy.filter(
    (e) =>
      e.sure === 'fuzzy' &&
      !crmAccountsOff(e.account) &&
      !(e.account && !e.account.off && (e.account.mine || (e.account.owner && ownerIsUser(e.account.owner)) || ownRecord))
  );
  // The user's "reach", "warm" or "colleague" wins over the holds they could see when they said it (it records
  // them). A do-not-contact entry, an opt-out or stop, or an off-limits account that appeared since holds again.
  // The holds as they read now, before any "(new since …)" is added: what a decision made now has seen.
  const holds_seen = rungs.filter((r) => (HARD_HOLDS.includes(r.rung) && r.group === 'skip') || isOwnerHold(r)).map((r) => r.says);
  // The same holds with their rung, as the ledger keeps them (hold_seen): what sticks, and what a send prompt
  // says was cleared. A hold that is only sticking from before isn't seen again.
  // A coworker's contact the user chose to write to anyway (warn, mine) is no hold.
  // A hold in the user's own name is no coworker's: never written.
  const hold_rungs = rungs
    .filter(
      (r) =>
        !r.sticky &&
        ((HARD_HOLDS.includes(r.rung) && r.group === 'skip') || (r.rung === 'colleague' && r.group !== 'reach' && !(r.holder && ownerIsUser(r.holder))))
    )
    .map((r) => ({ rung: r.rung, says: r.says }));
  if (decision && ['reach', 'warm', 'colleague'].includes(decision.group)) {
    const seen = new Set(decision.seen_holds || []);
    // A coworker the CRM names as owner counts too: a "reach" said before the CRM was read (a blanket "Chief
    // Digital Officers: reach") never covers a record a coworker holds. The coworker_contacts rule decides again.
    const fresh = rungs.filter(
      (r) => ((HARD_HOLDS.includes(r.rung) && r.group === 'skip') || (decision.group !== 'colleague' && isOwnerHold(r))) && !seen.has(r.says)
    );
    if (fresh.length) {
      const k = rungs.findIndex((r) => r.rung === 'user');
      if (k >= 0) rungs.splice(k, 1);
      fresh[0].says = `${fresh[0].says} (new since you said ${decision.group}${decision.because ? `: "${decision.because}"` : ''})`;
    }
  }
  // Fit first, the relationship second: a CRM record, a customer status or an old thread never puts someone
  // the fit judgement calls off-target (no segment) on the shortlist. They're kept aside, so the card can say
  // "you know them, but they're off-target". The user's own word (a decision, "you know them") still counts.
  const offTarget = fit && !fit.segment && !fit.unsure;
  const knownOff = offTarget
    ? rungs.filter((r) => ['customer_rule', 'in_touch', 'warm'].includes(r.rung) && ['warm', 'reach', 'in_touch'].includes(r.group) && !r.user_known)
    : [];
  for (const r of knownOff) rungs.splice(rungs.indexOf(r), 1);
  // The same for a coworker's contact (no note to the coworker about someone off-target) and for no email (a
  // student with no address is "not a fit", never "fits, but no email"). A user decision keeps both said.
  if (offTarget && !rungs.some((r) => r.rung === 'user'))
    for (const r of rungs.filter((x) => (x.rung === 'colleague' && x.group === 'colleague') || x.rung === 'unreachable')) rungs.splice(rungs.indexOf(r), 1);
  const known_off_target = knownOff.length
    ? knownOff
        .map((r) => r.says)
        .join('; ')
        .slice(0, 200)
    : null;
  let decided = rungs.filter((r) => !r.note_only);
  // A question only matters for someone floorboss would otherwise contact: when the fit says no, or there is
  // no way to reach them, that wins over a check (the check stays as an alternative).
  const settles = decided.find((r) => r.group === 'unfit' || r.group === 'unreachable');
  if (settles && !(decided[0]?.rung === 'user') && (decided[0]?.group === 'check' || (live.length && decided[0]?.group !== 'skip'))) {
    return {
      group: settles.group,
      rung: settles.rung,
      says: settles.says,
      evidence,
      alternatives: [
        ...live.map((e) => ({
          rung: e.record ? 'crm_match' : e.account ? 'account' : e.from,
          would_be: 'depends',
          says: e.says,
          from: e.from,
          ref: e.row != null ? `crm:${e.row}` : undefined
        })),
        ...decided.filter((r) => r !== settles).map(({ rung, group, says, holder }) => ({ rung, would_be: group, says, holder }))
      ],
      holder: null,
      crm: null,
      known_off_target,
      holds_seen,
      hold_rungs
    };
  }
  let first = decided[0];
  // A user decision beats everything; so does an exact skip. Fuzzy evidence turns anything else into check.
  if (!(first && first.rung === 'user') && live.length && !(first && first.group === 'skip')) {
    const alts = live.map((e) => ({
      rung: e.record ? 'crm_match' : e.account ? 'account' : e.from,
      would_be: e.account?.off
        ? 'skip'
        : e.account
          ? 'colleague'
          : e.from === 'do-not-contact list'
            ? 'skip'
            : e.opt_in
              ? 'skip'
              : e.record
                ? recordWouldBe(e.record)
                : 'depends on the record',
      says: e.says,
      from: e.from,
      ref: e.row != null ? `crm:${e.row}` : undefined
    }));
    return {
      group: 'check',
      rung: 'fuzzy',
      says: live.map((e) => e.says).join('; '),
      evidence: evidence,
      alternatives: [...alts, ...decided.slice(0, 3).map(({ rung, group, says, holder }) => ({ rung, would_be: group, says, holder }))],
      holder: first?.holder || null,
      holds_seen,
      hold_rungs
    };
  }
  if (!first) return { group: 'unjudged', rung: 'fit', says: 'not judged yet', evidence, alternatives: [], holds_seen, hold_rungs };
  // 'in_touch' is warm-by-hold: shown as held until the user rescues ("decide warm").
  const notes = rungs.filter((r) => r.note_only);
  // The user said to reach someone a coworker holds ("reach <name> anyway"): the draft knows whose account it is,
  // so it isn't written cold, and the coworker's notes say the user is writing too.
  const overridden =
    first.rung === 'user' && ['reach', 'warm'].includes(first.group) ? rungs.find((r) => r.rung === 'colleague' && r.group === 'colleague' && r.holder) : null;
  // The CRM record is at another company than the list says ("he moved from Hooli to Pied Piper"): the record
  // may describe an old role. The account it names is the old company's, and an address at the old company's
  // domain may be out of date.
  const listCo = contact?.company_key || (contact?.company ? companyKey(contact.company) : null);
  const rowCo = crm[0]?.company ? companyKey(crm[0].company) : null;
  const crmStale = !!(listCo && rowCo && !companyRelated(listCo, rowCo));
  const rowDomain = crmStale ? emailDomain(crm[0].email) : null;
  const accountNote = notes.find((n) => n.account_note)?.account_note || rungs.find((r) => r.rung === 'customer_rule' && r.account_note)?.account_note || null;
  return {
    // "Hold" from the user (check-these, "all of Dana's: hold") keeps the owner the CRM names, so the card shows
    // who to go and ask instead of "owner unknown".
    group: first.group,
    rung: first.rung,
    says: first.says,
    holder:
      first.holder ||
      (first.group === 'colleague' ? decided.find((r) => r.holder)?.holder || crm.find((r) => r.owner && !ownerIsUser(r.owner))?.owner || null : null),
    evidence,
    alternatives: decided.slice(1).map(({ rung, group, says, holder }) => ({ rung, would_be: group, says, holder })),
    account_note:
      (accountNote && !(crmStale && accountNote.toLowerCase().includes(String(crm[0].company).toLowerCase())) ? accountNote : null) ||
      (overridden ? `at ${overridden.holder}'s account ${contact?.company || ''}`.trim() : null),
    crm_stale: crmStale || undefined,
    email_old_company: crmStale && rowDomain && emailDomain(contact?.email) === rowDomain ? crm[0].company : undefined,
    // A coworker's contact the user chose to write to: who holds them, and whether to warn before sending.
    coworker: notes.find((n) => n.coworker)?.coworker || null,
    coworker_warn: notes.some((n) => n.coworker_warn),
    coworker_also: notes.find((n) => n.coworker_also)?.coworker_also || overridden?.holder || null,
    own_record: first.group === 'colleague' && !!first.own_record,
    as_new: !!first.as_new,
    known_off_target,
    holds_seen,
    hold_rungs,
    mailbox_note: exact.find((x) => x.mailbox && !x.mailbox.they_replied)?.says || null,
    crm: crm[0]
      ? {
          // The status that says who they are to the sender (a "Partner - active" label), not a marketing one
          // that means nothing here ("Subscribed").
          status: relationStatus(crm[0]) || null,
          // A customer or a live partner: the relationship the drafter and the company brief go by.
          relation: crmRelation(crm[0]),
          holder: crm[0].owner || null,
          last_contact: crm[0].last_contact || null,
          deal: crm[0].deal ? crmNotes(crm[0].deal).slice(0, 120) : null,
          deal_stage: crm[0].deal_stage ? crmNotes(crm[0].deal_stage).slice(0, 60) : null,
          notes: crmNotes(crm[0].notes),
          crm_id: crm[0].crm_id || null,
          email: crm[0].email || null,
          profile_url: crm[0].profile_url || null,
          company: crm[0].company || null,
          title: crm[0].title || null
        }
      : null
  };
}
