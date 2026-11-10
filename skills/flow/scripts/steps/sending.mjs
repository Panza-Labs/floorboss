// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 8 of nextStep, the last.
import { lastReplyCheck, readersOf, withFallbacks, userWordCounts, REPLY_CHECK_SECONDS } from '../../../../lib/sendcheck.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { touchBefore } from '../../../../lib/route.mjs';
import { cli, step, node, onToolError, toolDown, sendRecipe, errorFile, summaryOf } from './shared.mjs';
import { crmContactStep, otherChannelStep, appStep, logStep } from './channels.mjs';

// After approval: CRM contacts and tasks, sending and follow-ups on each channel, logging to the CRM, done.
export function sendSteps(x) {
  const { c, cfg, mock, e, mailOk, gaveUp, heldMustNote } = x;

  // With a CRM connected, everyone about to get a first email is in it before that email goes: the CRM files
  // replies only on people it has, and floorboss reads them there by record id.
  if (!mock && !c.agendaWanted) {
    const add = crmContactStep(c, e, cfg);
    if (add) return add;
  }

  // CRM tasks: with a create-task tool connected, every LinkedIn or event-app message the user sends by hand
  // (and anything floorboss needs them for) goes into the CRM as a task, one call at a time, through the guard.
  const taskRecipe = cfg.connectors?.['crm.create_task'];
  if (taskRecipe && !e.state.tool_failed['crm.create_task']) {
    const tl = cli('event-outreach', ['task-list', '--event', e.event.slug], c);
    const tasks = existsSync(tl.file) ? readJson(tl.file, []) : [];
    if (tasks.length) {
      const it = tasks[0];
      return step(
        'crm_task',
        `Log in your CRM: "${it.title}". ${tasks.length > 1 ? `${tasks.length - 1} more after this.` : 'The last one.'} A task is a reminder in your CRM: nothing is sent.`,
        {
          call: {
            task: 'crm.create_task',
            recipe: { server: taskRecipe.server, tool: taskRecipe.tool, mcp_name: `mcp__${taskRecipe.server}__${taskRecipe.tool}`, args: taskRecipe.args },
            item: it,
            receipt_format: '{"tasks":[{"key":"<the item key>","task_id":"<the CRM id>"}]}',
            then: node('event-outreach', 'tasks-created', '--event', e.event.slug, '--file', join(e.paths.work, 'receipt.json')),
            on_error: onToolError(e.event.slug, 'crm.create_task')
          },
          remaining: tasks.length
        }
      );
    }
  }
  if (e.state.tool_failed['crm.create_task'] && taskRecipe) {
    const td = toolDown(e, 'crm.create_task', 'CRM task tool', ['retry', 'later']);
    if (td && td.step === 'tool_down') return td;
  }

  // Sending (email, through the MCP tool, with the guard and the prompt).
  if ((e.settings.sending?.channels || []).includes('email')) {
    const list = cli('event-outreach', ['send-list', '--event', e.event.slug], c);
    const items = existsSync(list.file) ? readJson(list.file, []) : [];
    // A send that may or may not have gone (its call failed or never answered) is settled before anything else.
    const unclear = Object.entries(e.state.people).flatMap(([id, p]) =>
      Object.entries(p.touches)
        .filter(([, x]) => x.released && !x.sent && !x.release_cleared && x.released_via !== 'browser')
        .map(([t, x]) => ({ id, touch: Number(t), x, name: p.name, email: p.email_override || p.email }))
    );
    if (unclear.length) {
      const u = unclear[0];
      const lookedAlready = String(e.state.answered.sent_check?.value || '') === `not found:${u.id}:${u.touch}`;
      if (cfg.connectors?.['email.messages'] && !e.state.tool_failed['email.messages'] && !lookedAlready)
        return step(
          'check_sent',
          `The send to ${u.name} didn't confirm${u.x.unclear_send?.error ? ` (${u.x.unclear_send.error})` : ''}. Look in the mailbox for it before anything is sent again.`,
          {
            judge: {
              read: null,
              target: { id: u.id, touch: u.touch, email: u.email, since: String(u.x.released_at || '').slice(0, 10) },
              write: join(e.paths.work, 'sent-check.json'),
              format:
                '{"id","touch","went":"yes"|"no","message_id","thread_id"}: from the email.messages recipe for that address since the release; "yes" only with the sent message\'s id',
              then: node('event-outreach', 'send-outcome', '--event', e.event.slug, '--from', 'mailbox', '--file', join(e.paths.work, 'sent-check.json')),
              on_error: onToolError(e.event.slug, 'email.messages')
            }
          }
        );
      return step(
        'send_outcome',
        `The send to ${u.name} didn't confirm${u.x.unclear_send?.error ? ` (${u.x.unclear_send.error})` : ''}. Nothing more goes to them until the user has looked.`,
        {
          ask: {
            id: 'send_outcome',
            person: { id: u.id, touch: u.touch, name: u.name, email: u.email },
            question: `The email to ${u.name} (${u.email}) may not have gone${lookedAlready ? ", and the mailbox doesn't show it yet" : ''}. Please look in your Sent folder: is it there? ("it went" or "it did not go")`,
            options: ['it went', 'it did not go'],
            answer_format: '{"id","touch","went":"yes"|"no","said":"<their words>"}'
          }
        }
      );
    }
    if (
      e.state.tool_failed['email.send'] &&
      !(e.state.answered.tool_down?.value === 'later' && String(e.state.answered.tool_down.at).slice(0, 10) === c.now.toISOString().slice(0, 10))
    )
      return toolDown(e, 'email.send', 'email send tool', ['retry', 'later']);
    const firsts = items.filter((x) => x.touch <= 1);
    // Follow-ups the list holds back only for their reply check (or a round approval) are next too: the check
    // is what lets them onto the list, so it has to come first.
    const nameOf = (id) => (readJson(join(e.paths.derived, 'contacts.json'), []).find((x) => x.id === id) || {}).name || id;
    const listed = items.filter((x) => x.touch > 1);
    const needsCheck = (list.waiting || [])
      .filter((w) => w.via !== 'browser' && w.touch > 1 && /replies weren't checked|can look at their replies/.test(w.why))
      .map((w) => ({ ...w, name: nameOf(w.id), unlisted: true }));
    const roundWait = (list.waiting || []).filter((w) => /approve the round/.test(w.why));
    const notNow =
      e.state.answered.approve_round?.value === 'not now' && String(e.state.answered.approve_round.at).slice(0, 10) === c.now.toISOString().slice(0, 10);
    if (!firsts.length && !listed.length && roundWait.length && !notNow) {
      const touch = roundWait[0].touch;
      const who = roundWait.filter((w) => w.touch === touch);
      return step(
        'approve_round',
        `Follow-up ${touch - 1} is due for ${who.length} ${who.length === 1 ? 'person' : 'people'}. You chose to approve each round before it goes.`,
        {
          show: who.map((w) => ({ id: w.id, name: nameOf(w.id) })),
          ask: {
            id: 'approve_round',
            touch,
            question: `Send follow-up ${touch - 1} to ${who
              .map((w) => nameOf(w.id))
              .slice(0, 8)
              .join(', ')}${who.length > 8 ? ` and ${who.length - 8} more` : ''}? Say yes, or which of them to leave out.`,
            answer_format: '{"touch":<n>,"said":"<their words>","ids":[…] (optional: only these)}'
          }
        }
      );
    }
    const follow = listed.length ? listed : needsCheck;
    if (firsts.length) {
      const it = firsts[0];
      return step(
        'send_one',
        `Send the approved ${it.touch === 0 ? 'confirmation' : 'first message'} to ${it.name}. Claude Code asks the user before it goes.`,
        {
          call: {
            task: 'email.send',
            recipe: sendRecipe(c),
            item: { id: it.id, touch: it.touch, to: it.to, subject: it.subject, body: it.body, thread_id: it.thread_id || null },
            then: node('event-outreach', 'sent', '--event', e.event.slug, '--receipts-file', join(e.paths.work, 'receipt.json')),
            on_error: node(
              'event-outreach',
              'send-failed',
              '--event',
              e.event.slug,
              '--id',
              it.id,
              '--touch',
              String(it.touch),
              '--error-file',
              errorFile(e.event.slug)
            ),
            receipt_format: '{"sends":[{"id","touch","message_id","thread_id"}]}'
          },
          remaining: items.length
        }
      );
    }
    if (follow.length) {
      const it = follow[0];
      const elsewhere = otherChannelStep(c, e, cfg, it, follow);
      if (elsewhere) return elsewhere;
      // The guard's own rule: a mailbox check, or (with nothing that can read replies) the user's word.
      // A reader that failed is asked about (retry, or the user answers instead); the user's word counts only
      // once they chose that, after the latest failure.
      const failedAt = e.state.tool_failed['email.messages'] ? Date.parse(e.state.tool_failed['email.messages'].at) : null;
      const sentOf = (x) => Date.parse(e.state.people[x.id]?.touches?.[touchBefore(e.state.people[x.id], x.touch)]?.sent_at || 0) || 0;
      // A CRM read of this person just now showed the CRM hasn't seen their email: the user is asked instead.
      const crmBlindNow = (x) =>
        e.entries.some(
          (y) =>
            y.type === 'checked' &&
            y.id === x.id &&
            y.source === 'crm' &&
            y.sees_email === false &&
            Date.parse(y.at) >= sentOf(x) &&
            c.now.getTime() - Date.parse(y.at) <= REPLY_CHECK_SECONDS * 1000
        );
      // A failed mailbox reader is asked about only once the CRM can't do the check instead (it isn't
      // connected, it failed too, or it just came back unable to see this person): the guard still counts the
      // mailbox as readable until the user says "ask me", so their word alone wouldn't get the send through.
      const crmOk = !!cfg.connectors?.['crm.activity'] && !e.state.tool_failed['crm.activity'];
      if (failedAt != null && cfg.connectors?.['email.messages'] && !gaveUp('email.messages') && (!crmOk || crmBlindNow(it)))
        return toolDown(e, 'email.messages', 'mailbox reader', ['retry', 'ask me', 'later']);
      if (!mailOk && e.state.tool_failed['crm.activity'] && cfg.connectors?.['crm.activity'] && !gaveUp('crm.activity'))
        return toolDown(e, 'crm.activity', 'CRM', ['retry', 'ask me', 'later']);
      const readerDown = failedAt != null;
      const rdr = {
        ...withFallbacks(readersOf({ connectors: cfg.connectors || {} }), e.state),
        ...(readerDown ? { email: false } : {}),
        ...(e.state.tool_failed['crm.activity'] ? { crm: false } : {})
      };
      const sentAt = sentOf(it);
      const at = lastReplyCheck(e.entries, it.id, 'email.send', rdr, sentAt);
      const noReader = readerDown || !cfg.connectors?.['email.messages'];
      const fresh = at && at >= sentAt && c.now.getTime() - at <= REPLY_CHECK_SECONDS * 1000;
      const check = at ? { at: new Date(at).toISOString() } : null;
      if (!fresh && cfg.connectors?.['email.messages'] && !readerDown)
        return step('check_replies_one', `Before ${it.name}'s follow-up goes, their replies are checked, right now.`, {
          run_first: node('event-outreach', 'sync-list', '--event', e.event.slug, '--ids', it.id),
          judge: {
            read: join(e.paths.dir, 'sync-list.json'),
            write: join(e.paths.work, 'sync.json'),
            format: 'the email.messages recipe\'s answer for this one person, as {"people":[{"id","messages":[…]}]}',
            then: node('event-outreach', 'sync', '--event', e.event.slug, '--source', 'mailbox', '--file', join(e.paths.work, 'sync.json')),
            on_error: onToolError(e.event.slug, 'email.messages')
          }
        });
      // No mailbox to read: the CRM, which logs it, is read for this person instead.
      if (!fresh && rdr.crm && (readerDown || !cfg.connectors?.['email.messages']) && !crmBlindNow(it))
        return step('check_replies_one', `Before ${it.name}'s follow-up goes, the CRM is read for their replies, right now.`, {
          run_first: node('event-outreach', 'sync-list', '--event', e.event.slug, '--ids', it.id),
          judge: {
            read: join(e.paths.dir, 'sync-list.json'),
            write: join(e.paths.work, 'sync-crm.json'),
            format: 'the crm.activity recipe\'s answer for this one person, as {"people":[{"id","activities":[…]}]}',
            then: node('event-outreach', 'sync', '--event', e.event.slug, '--source', 'crm', '--file', join(e.paths.work, 'sync-crm.json')),
            on_error: onToolError(e.event.slug, 'crm.activity')
          }
        });
      // Nothing can read replies: ask once about everyone whose follow-up is due and not freshly checked (a
      // batched answer counts for each person for the same 90 seconds; whoever is left after that is asked again).
      if (!fresh && noReader && (!rdr.crm || crmBlindNow(it))) {
        const due = follow.filter((x) => {
          if (!userWordCounts(e.entries, x.id, 'email.send', rdr, sentOf(x))) return false;
          const a2 = lastReplyCheck(e.entries, x.id, 'email.send', rdr, sentOf(x));
          const s2 = sentOf(x);
          return !(a2 && a2 >= s2 && c.now.getTime() - a2 <= REPLY_CHECK_SECONDS * 1000);
        });
        if (due.length > 1)
          return step(
            'no_reply_check',
            `${readerDown ? "The mailbox can't be read right now" : 'Nothing connected can see replies'}: one question for the ${due.length} people whose follow-up is due.`,
            {
              ask: {
                id: 'no_reply',
                channels: ['email'],
                people: due.map((x) => ({ id: x.id, name: x.name || nameOf(x.id) })),
                question: `Follow-ups are due for ${due.map((x) => x.name || nameOf(x.id)).join(', ')}. Has anyone replied, booked or asked you to stop since your last message? Name them, or say "none".`,
                options: ['none', 'some replied: <names>'],
                answer_format:
                  '{"people":[<every id asked about>],"replied":["<id>"],"stopped":["<id>"],"said":"<the user\'s words>"} (replied and stopped may be empty); everyone in people not named counts as no reply'
              }
            }
          );
      }
      if (!fresh && noReader && (!rdr.crm || crmBlindNow(it)))
        return step(
          'no_reply_check',
          `${readerDown ? "The mailbox can't be read right now" : 'Nothing connected can see'} ${it.name}'s replies, so the user is asked, right before the follow-up goes.`,
          {
            ask: {
              id: 'no_reply',
              channels: ['email'],
              person: { id: it.id, name: it.name },
              question: `Has ${it.name} replied (or booked, or asked you to stop) since your last message?`,
              options: ['no reply', 'they replied', 'they asked to stop'],
              answer_format: '{"id":"<id>","answer":"no reply|they replied|they asked to stop","said":"<the user\'s words>"}'
            }
          }
        );
      return step(
        'send_one',
        `Send follow-up ${it.touch - 1} to ${it.name} (their replies were checked ${check ? Math.round((c.now.getTime() - Date.parse(check.at)) / 1000) : '?'} seconds ago). Claude Code asks the user before it goes.`,
        {
          call: {
            task: 'email.send',
            recipe: sendRecipe(c),
            item: { id: it.id, touch: it.touch, to: it.to, subject: it.subject, body: it.body, thread_id: it.thread_id || null },
            then: node('event-outreach', 'sent', '--event', e.event.slug, '--receipts-file', join(e.paths.work, 'receipt.json')),
            on_error: node(
              'event-outreach',
              'send-failed',
              '--event',
              e.event.slug,
              '--id',
              it.id,
              '--touch',
              String(it.touch),
              '--error-file',
              errorFile(e.event.slug)
            ),
            receipt_format: '{"sends":[{"id","touch","message_id","thread_id"}]}'
          },
          remaining: items.length
        }
      );
    }
    const app = appStep(c, e, cfg);
    if (app) return app;
    {
      const lg = logStep(c, e);
      if (lg) return lg;
    }
    if (list.waiting?.length)
      return step('waiting', 'Some approved messages wait: follow-ups not yet due, or something to settle first.', {
        show: list.waiting,
        done: false,
        next_check: 'Run again on the day the first follow-up is due.',
        ...heldMustNote,
        ...summaryOf(c, e)
      });
  }
  if (!(e.settings.sending?.channels || []).includes('email')) {
    const app = appStep(c, e, cfg);
    if (app) return app;
  }

  {
    const lg = logStep(c, e);
    if (lg) return lg;
  }
  // Who couldn't be logged in the CRM (not a contact there): said once in the summary, with what to do.
  const notLogged = e.settings.crm_log === 'browser' ? cli('event-outreach', ['log-list', '--event', e.event.slug], c) : null;
  return step('done', 'Nothing to do right now.', {
    done: true,
    ...heldMustNote,
    ...summaryOf(c, e),
    ...(notLogged?.not_in_crm ? { crm_not_logged: notLogged.not_in_crm, crm_not_logged_note: notLogged.not_in_crm_note } : {})
  });
}
