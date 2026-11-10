// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 2 of nextStep.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { todayKeyIn, addDays } from '../../../../lib/tz.mjs';
import { sessionRun, runLedgerMark } from '../../../../lib/scope.mjs';
import { step, node, mappingConfirmed, mappingStep, toolDown, mtime, onToolError } from './shared.mjs';
import { CRM_INDEPENDENT_WARNING } from './wording.mjs';
import { crmLayoutElsewhere } from './counts.mjs';
import { onboardingAsk } from './setup.mjs';

// The lists: a reply that needs a decision comes first; then the attendee list, the CRM read and the mailbox
// history, each with its column mapping, and the questions that come before triage.
export function listSteps(x) {
  const { c, cfg, mock, e } = x;

  // This run, and whether something read in it is out of date (another run, or more than an hour ago).
  const thisRun = sessionRun() || null;
  const readStale = (at, run) => !at || (run || null) !== thisRun || c.now.getTime() - Date.parse(at) > 3600e3;
  // What can see replies, and whether the user is to be asked what came in this run (worked out here, as the
  // reply-action step below takes that answer too).
  const anySent = Object.values(e.state.people).some((p) => !(p.stopped || p.removed || p.dropped) && Object.values(p.touches || {}).some((t) => t.sent));
  const mailOk = !!cfg.connectors?.['email.messages'] && !e.state.tool_failed['email.messages'];
  const crmRead = !!cfg.connectors?.['crm.activity'] && !e.state.tool_failed['crm.activity'] && !readStale(e.state.last?.sync_crm, e.state.last?.sync_crm_run);
  const crmBlind = crmRead
    ? (e.state.last?.sync_crm_blind || []).filter(
        (id) => e.state.people[id] && !(e.state.people[id].replied || e.state.people[id].stopped || e.state.people[id].booked)
      )
    : [];
  const canRead = mailOk || (crmRead && !crmBlind.length);
  const lastAsked = e.state.answered.replies_since;
  // Only once something was sent long enough ago for an answer to have come: not minutes after the user said
  // they sent them all.
  // A send recorded before this run (the ledger as the run first saw it), over an hour ago, or dated two days back or more
  // (sends the user records days after making them).
  const mark = runLedgerMark(e.event.slug, e.entries.length);
  // Two days back: the date is the user's own day, which can be a day behind the event's zone.
  const todayKey = addDays(todayKeyIn(e.event.time_zone, c.now), -1);
  const sentAWhileAgo = e.entries.some(
    (x, i) => x.type === 'sent' && (i < mark || c.now.getTime() - Date.parse(x.at) > 3600e3 || (typeof x.date === 'string' && x.date < todayKey))
  );
  const repliesDue = anySent && sentAWhileAgo && !canRead && !c.agendaWanted && readStale(lastAsked?.at, lastAsked?.run);
  // A reply that asks something of the user (a time they accepted or proposed, someone they pointed to): one
  // question each, before anything else, so a meeting or a lead isn't left sitting in the mailbox.
  const ra = Object.entries(e.state.people)
    .filter(([, p]) => !(p.stopped || p.dropped))
    .flatMap(([id, p]) => (p.reply_actions || []).filter((a) => !a.done).map((a) => ({ id, name: p.name, ...a })))[0];
  if (ra)
    return step(
      'reply_action',
      ra.why === 'cancelled'
        ? `${ra.name} cancelled and asked for another time.`
        : ra.action === 'book'
          ? `${ra.name} wrote back about a time.`
          : `${ra.name} pointed you to someone else.`,
      {
        // Recording what came in (the replies_since question) can raise this step before that question is answered:
        // its answer is taken here too, so it isn't asked again.
        ...(repliesDue ? { accepts: ['replies_since'] } : {}),
        ask: {
          id: 'reply_action',
          person: { id: ra.id, name: ra.name, ext: ra.ext, action: ra.action, time: ra.time || null, referral: ra.referral || null },
          question:
            ra.why === 'cancelled'
              ? `${ra.name} cancelled and asked for another time. Agree a new one with them (you write back yourself; floorboss offers no new times here), then say when, or "not booked yet". (Show their words.)`
              : ra.action === 'book'
                ? `${ra.name} wrote back${ra.time ? ` with ${ra.time}` : ' about a time'}. ${ra.time ? 'Book it?' : 'Is a meeting agreed, and when (the day and time)?'} (Show their words.)`
                : `${ra.name} suggested ${ra.referral?.name || ra.referral?.email}${ra.referral?.title ? `, ${ra.referral.title}` : ''}${ra.referral?.email ? ` (${ra.referral.email})` : ''}. Add them to the list, with a first message that says ${ra.name.split(' ')[0]} pointed you to them?`,
          options:
            ra.action === 'book'
              ? [...(ra.time ? ['yes, book it'] : []), `${ra.time ? 'a different time' : 'booked for'}: <YYYY-MM-DD HH:MM>`, 'not booked yet']
              : ['yes, add them', 'no'],
          answer_format: `{"id":"${ra.id}","ext":${JSON.stringify(ra.ext)},"action":"${ra.action}","answer":"yes"|"no"|"<YYYY-MM-DD HH:MM>",${ra.action === 'add_referral' ? `"referral":${JSON.stringify(ra.referral)},"company":"<their company>"` : `"time":${JSON.stringify(ra.time)}`}}`
        }
      }
    );

  // Inputs and their mappings.
  // Only on a website or in the app, and no browser reading it: build the list from the public page, rather
  // than asking for a file the user said they don't have.
  if (!e.inputs.attendees && c.ob.ans.list_source === 'app' && c.ob.ans.browser_choice !== 'now') {
    const f = join(e.paths.work, 'list-from-page.csv');
    return step('list_from_page', 'The list is only on a website or in the app: build it from the public page.', {
      judge: {
        read: null,
        how: `${c.ob.ans.list_url ? `The page: ${c.ob.ans.list_url}.` : "Ask for the page's link if you don't have it (the event's speakers or attendees page)."} Read it with WebFetch, every page of it (follow page links or "load more" where the site has them), and write one row per person: Name,Title,Company,LinkedIn (blank if not shown). Public pages only, never log in. Then say how many people it found; if it lists only speakers, say plainly that it is a thin source for their goal.`,
        write: f,
        format: 'a CSV with the header Name,Title,Company,LinkedIn',
        then: node('crm-triage', 'inputs', '--event', e.event.slug, '--kind', 'attendees', '--file', f)
      }
    });
  }
  if (!e.inputs.attendees)
    return step('attendee_list', 'floorboss needs the attendee list (a CSV export) before anyone can be judged.', {
      ask: { id: 'attendee_list', question: 'Where is the attendee list? Give the path to the CSV file.', answer_format: 'a file path' }
    });
  if (mappingConfirmed(e, 'attendees') === false) return mappingStep(c, e, 'attendees');
  const crmChoice = c.ob.ans.crm_choice;
  // A CRM layout confirmed at an earlier event is used again when the file has the same columns: the opt-out
  // column (or that there is none) isn't asked about again.
  const layoutAt = crmChoice === 'export' && !e.inputs.crm ? crmLayoutElsewhere(e) : null;
  if (crmChoice === 'export' && !e.inputs.crm && !c.ob.ans.crm_export_skipped)
    return step('crm_export', 'The CRM export tells floorboss who is already a customer, who a colleague holds and who opted out.', {
      ask: {
        id: 'crm_export',
        question: layoutAt
          ? `Where is the CRM export? The same export as for ${layoutAt} is fine: its columns, and what you said about opt-outs, are used again when the layout is the same. Give the path, or say you can't get one.`
          : "Where is the CRM export (a CSV with owner, status and the opt-out field)? Give the path, or say you can't get one.",
        answer_format: 'a file path, or the word skip'
      }
    });
  // An export given as well doesn't stand in for the lookup: both are read (crm-triage readCrm), the export filling
  // the notes, deals and labels a lookup tool often doesn't return. An export given instead of a CRM that stopped
  // answering skips the lookup (crm_lookup_skipped).
  if (crmChoice === 'connector' && !e.inputs['crm-records'] && cfg.connectors?.['crm.lookup'] && !c.ob.ans.crm_lookup_skipped) {
    // "Run independently" is never one click: the risks are spelled out and the user confirms, choosing
    // between confirming each person themselves or going ahead.
    const td = e.state.answered.crm_choice_after_failure;
    if (e.state.tool_failed['crm.lookup'] && td?.value === 'independent_pending' && Date.parse(td.at) >= Date.parse(e.state.tool_failed['crm.lookup'].at))
      return step(
        'crm_independent',
        'The user asked to run without their CRM. Show the warning word for word and get their confirmation before anything else.',
        {
          ask: {
            id: 'crm_independent',
            question: CRM_INDEPENDENT_WARNING,
            options: [
              'run independently, but I confirm each person myself before anything is drafted (safer)',
              'run independently and go ahead',
              'go back (retry the CRM, or give an export)'
            ],
            answer_format: "one of the options, in the user's words"
          }
        }
      );
    if (e.state.tool_failed['crm.lookup']) return toolDown(e, 'crm.lookup', 'CRM', ['retry', 'export', 'independent']);
    const list = join(e.paths.derived, 'crm-lookup-list.json');
    if (!existsSync(list) || mtime(list) < mtime(e.inputs.attendees))
      return step('crm_lookup_list', 'Who to look up in the connected CRM.', { run: node('crm-triage', 'lookup-list', '--event', e.event.slug) });
    return step('crm_lookup', 'Look each person up in the CRM through the crm.lookup recipe and translate the answers.', {
      judge: {
        read: list,
        write: join(e.paths.work, 'crm-records.json'),
        format:
          '{"records":[{name,email,company,title,holder,status,last_contact,opted_out,notes,crm_id,profile_url,deal,deal_stage}], "not_found":["<email or name>"]}, one record per CRM match, not_found for every person the CRM has nothing on. notes: the record\'s notes and latest logged notes or activities as written (stop requests are usually there); read them even when it takes a second call. deal and deal_stage: their deal and where it stands (won, lost, or its stage), when the CRM has one',
        // An export the user handed over too is read with the lookup, never dropped in silence.
        also: e.inputs.crm
          ? 'The CRM export the user gave is read too: it fills in notes, deals and labels the lookup does not return, and a stop in either one holds. Tell the user so in one line.'
          : `If the user also gave a CRM export file, give it too (crm-triage inputs --event ${e.event.slug} --kind crm --file <it>): floorboss reads both, the export filling in notes, deals and labels the lookup does not return. Tell the user in one line that both are read.`,
        then: node('crm-triage', 'inputs', '--event', e.event.slug, '--kind', 'crm-records', '--file', join(e.paths.work, 'crm-records.json')),
        on_error: onToolError(e.event.slug, 'crm.lookup')
      }
    });
  }
  if (e.inputs.crm && mappingConfirmed(e, 'crm') === false) return mappingStep(c, e, 'crm');
  if (c.ob.ans.mailbox_choice === 'yes' && cfg.connectors?.['email.history'] && !e.inputs['mail-history'] && !c.ob.ans.mail_history_skipped) {
    if (e.state.tool_failed['email.history']) return toolDown(e, 'email.history', 'mailbox search', ['retry', 'skip']);
    const list = join(e.paths.derived, 'mail-lookup-list.json');
    if (!existsSync(list) || mtime(list) < mtime(e.inputs.attendees))
      return step('mail_list', 'Which addresses to look for in the mailbox: anyone already written to is not pitched cold.', {
        run: node('crm-triage', 'mail-list', '--event', e.event.slug)
      });
    return step('mail_history', 'Search the mailbox for each address with the email.history recipe.', {
      judge: {
        read: list,
        write: join(e.paths.work, 'mail-history.json'),
        format: '{"people":[{"email","threads":<n>,"they_replied":true|false,"last_at":"<ISO>"}]}',
        then: node('crm-triage', 'inputs', '--event', e.event.slug, '--kind', 'mail-history', '--file', join(e.paths.work, 'mail-history.json')),
        on_error: onToolError(e.event.slug, 'email.history')
      }
    });
  }

  // Load, judge, decide, gate.
  // Onboarding, triage phase: the CRM is read now, so its questions carry real names and counts.
  const ask2 = !mock && onboardingAsk(c, 'triage');
  if (ask2) return ask2;
  Object.assign(x, { readStale, anySent, mailOk, crmBlind, lastAsked, repliesDue });
}
