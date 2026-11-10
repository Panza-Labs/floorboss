// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Steps for one place outside email: adding contacts to the CRM and logging to it, reading an inbox in the
// user's browser, a LinkedIn message the user sends themselves, and notes sent in the event app.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { cli, step, node, onToolError, toolDown, errorFile } from './shared.mjs';

// LinkedIn and event-app messages that went out are logged in the CRM (crm_log: browser): one yes opens a
// 20-minute window, then Claude logs every listed message in the CRM's web app in one go. Tasks or the CSV in
// the outbox cover the rest (crm_log: tasks | csv).
// People to add to the CRM before their first email (outreach contact-list): through the create tool one at a
// time (the guard asks before each), or by an import the user makes, after which each is looked up by email.
export function crmContactStep(c, e, cfg) {
  if (!cfg.connectors?.['crm.lookup'] && !cfg.connectors?.['crm.create_contact']) return null;
  const cl = cli('event-outreach', ['contact-list', '--event', e.event.slug], c);
  if (!cl.to_add) return null;
  const items = readJson(cl.file, []);
  const crmName = e.settings.crm_name || 'your CRM';
  const names = cl.people.length > 8 ? `${cl.people.slice(0, 8).join(', ')} and ${cl.people.length - 8} more` : cl.people.join(', ');
  // Let through to the CRM once with no id saved (the answer was lost, or the user said no at the prompt): looked
  // up by email before anything is created again.
  if (items[0].released && cfg.connectors?.['crm.lookup'])
    return step('crm_contact_check', `${items[0].name} may already be in ${crmName}: look them up before adding them again.`, {
      judge: {
        read: cl.file,
        how: `Run the crm.lookup recipe for ${items[0].email}. Found: write their record id. Not found: ask the user whether to add ${items[0].name} now or go on without them, and save that with flow answer --ask crm_contacts as {"answer":"add them now"|"go on without them","ids":["${items[0].id}"]}; only if they said to add them, write them under "retry". If they were added only a moment ago, search once more first: some CRMs take a little while to find a new record.`,
        write: join(e.paths.work, 'crm-ids.json'),
        format: `{"records":[{"id":"${items[0].id}","crm_id":"<the record id>"}]} when found; {"records":[],"retry":["${items[0].id}"]} when not`,
        then: node('event-outreach', 'crm-records', '--event', e.event.slug, '--via', 'check', '--file', join(e.paths.work, 'crm-ids.json')),
        on_error: onToolError(e.event.slug, 'crm.lookup')
      },
      accepts: ['crm_contacts']
    });
  const rec = cfg.connectors?.['crm.create_contact'];
  if (rec && !e.state.tool_failed['crm.create_contact'])
    return step(
      'crm_contact',
      `Add ${items[0].name} to ${crmName} before their first email. ${items.length > 1 ? `${items.length - 1} more after this.` : 'The last one.'} Nothing is sent.`,
      {
        call: {
          task: 'crm.create_contact',
          recipe: { server: rec.server, tool: rec.tool, mcp_name: `mcp__${rec.server}__${rec.tool}`, args: rec.args },
          item: items[0],
          receipt_format: '{"records":[{"id":"<the item id>","crm_id":"<the id the CRM gave the new record>"}]}',
          then: node('event-outreach', 'crm-records', '--event', e.event.slug, '--file', join(e.paths.work, 'receipt.json')),
          on_error: onToolError(e.event.slug, 'crm.create_contact')
        },
        remaining: items.length
      }
    );
  // The create tool failed: retry it or stop for now, as for the CRM task tool; the import stays open to the user.
  if (rec && e.state.tool_failed['crm.create_contact']) {
    const td = toolDown(e, 'crm.create_contact', 'CRM', ['retry', 'later']);
    if (td) return td;
  }
  const asked = e.state.answered.crm_contacts;
  const checked = e.entries.filter((x) => x.type === 'crm_import_checked').pop();
  // Imported: each one is looked up by email for their record id, once per import.
  if (asked?.value === 'imported' && !(checked && Date.parse(checked.at) >= Date.parse(asked.at)) && cfg.connectors?.['crm.lookup'])
    return step('crm_contact_ids', `Look up the ${plural(items.length, 'person', 'people')} the user imported into ${crmName}, for their record ids.`, {
      judge: {
        read: cl.file,
        how: 'Run the crm.lookup recipe for each person by their email. Write the ones found, with the id the CRM shows for the record.',
        write: join(e.paths.work, 'crm-ids.json'),
        format: '{"records":[{"id":"<the item id>","crm_id":"<the record id>"}]} (only people found; [] when none are)',
        then: node('event-outreach', 'crm-records', '--event', e.event.slug, '--via', 'import', '--file', join(e.paths.work, 'crm-ids.json')),
        on_error: onToolError(e.event.slug, 'crm.lookup')
      }
    });
  // The user chose to add them through the CRM connection: find the create tool and make the first record.
  if (asked?.value === 'create')
    return step('crm_contact_setup', `Set up adding people to ${crmName}: ${names}.`, {
      judge: {
        how: `Follow skills/connectors/SKILL.md "Adding people to the CRM": screen the CRM server's tools for crm.create_contact, tell the user which tool it is, and with their yes add the first person on ${cl.file} as its test (test-allow, the call, the user sees the record in ${crmName}, save-recipe), then save that record's id with crm-records. The rest go one by one in the next steps. If no tool fits or it can't be saved after two tries, say what went wrong and ask the user to import ${cl.csv} instead ("imported") or go on without adding them; save that with flow answer --ask crm_contacts.`,
        then: node('connectors', 'status')
      },
      accepts: ['crm_contacts'],
      help: 'skills/connectors/SKILL.md#adding-people-to-the-crm'
    });
  const again = asked?.value === 'imported' && checked && Date.parse(checked.at) >= Date.parse(asked.at);
  return step(
    'crm_contacts',
    `${plural(items.length, 'person', 'people')} about to be emailed ${items.length === 1 ? "isn't" : "aren't"} in ${crmName} yet; they go in first, so their replies are filed where floorboss reads them.`,
    {
      ask: {
        id: 'crm_contacts',
        question: `${again ? `I couldn't find ${names} in ${crmName} after the import.` : `${names} ${items.length === 1 ? "isn't" : "aren't"} in ${crmName} yet.`} They go in before the first email, so their replies land on a record floorboss can read. ${again ? 'Import again and say "imported", or say "go on without them".' : `Add them now through the CRM connection, or import ${cl.csv} yourself and say "imported", or say "go on without them" (then you're asked about their replies).`}`,
        options: ['add them now', 'imported', 'go on without them'],
        answer_format: '"add them now" | "imported" | "go on without them" (their words)'
      },
      help: 'skills/connectors/SKILL.md#adding-people-to-the-crm'
    }
  );
}

export function logStep(c, e) {
  if (e.settings.crm_log !== 'browser') return null;
  const ll = cli('event-outreach', ['log-list', '--event', e.event.slug], c);
  const crmName = e.settings.crm_name || 'your CRM';
  // "Ask me each time": one list per batch of people to create in the CRM.
  if (ll.need_ok?.length)
    return step(
      'crm_create_ok',
      `${ll.need_ok.length} ${ll.need_ok.length === 1 ? "person you messaged isn't" : "people you messaged aren't"} in ${crmName} yet.`,
      {
        ask: {
          id: 'crm_create_ok',
          ids: ll.need_ok.map((x) => x.id),
          question: `Create ${ll.need_ok.length === 1 ? 'this contact' : `these ${ll.need_ok.length} contacts`} in ${crmName} so the messages can be logged? ${ll.need_ok.map((x) => `${x.name} (${x.company})`).join(', ')}. Only new contacts are created (name, company, title, email, LinkedIn URL); nothing existing is changed.`,
          options: ['yes', 'no'],
          answer_format: '{"answer":"yes"|"no","ids":[<the ids listed>]}'
        }
      }
    );
  if (!ll.to_log) return null;
  if (e.state.tool_failed['crm.log']) {
    const td = toolDown(e, 'crm.log', `${crmName} in your browser`, ['retry', 'later']);
    if (td && td.step === 'tool_down') return td;
    if (td) return null;
  }
  const notNow =
    e.state.answered.crm_log_window?.value === 'not now' && String(e.state.answered.crm_log_window.at).slice(0, 10) === c.now.toISOString().slice(0, 10);
  if (notNow) return null;
  const w = readJson(join(c.home, 'crm-log-window.json'), null);
  const open = w && !w.closed && w.event === e.event.slug && Date.parse(w.until) > c.now.getTime();
  if (!open)
    return step('crm_log_window', `${ll.to_log} LinkedIn or app ${ll.to_log === 1 ? 'message goes' : 'messages go'} into ${crmName} as logged activities.`, {
      ask: {
        id: 'crm_log_window',
        question: `Log ${ll.to_log} sent ${ll.to_log === 1 ? 'message' : 'messages'} in ${crmName} now? Open it in your browser and log in first. floorboss logs each one on the contact's record (text and date), and never edits, merges or deletes anything.`,
        options: ['yes, log them now', 'not now'],
        answer_format: '"yes, log them now" | "not now"'
      }
    });
  return step('crm_log', `Log ${ll.to_log} sent ${ll.to_log === 1 ? 'message' : 'messages'} in ${crmName}, in the user's browser, one after another.`, {
    judge: {
      read: ll.file,
      how: `In ${crmName}: search the contact by email (else name and company); for an item with create: true that the search doesn't find, create a new contact with only its name, company, title, email and LinkedIn URL (never edit or merge an existing one), and report result \"created\"; on an existing record, for each field in the item's fill (linkedin, title) that is empty on the record, add the listed value and save, and report it in filled; never change a field that has a value; open their record; Log activity: the LinkedIn-message type if there is one, else a note; paste the body exactly as listed; set the date to sent_on; save. Report what the page said. Never edit, merge or delete anything.`,
      write: join(e.paths.work, 'crm-log-results.json'),
      format:
        '[{"key","result":"logged"|"created"|"not_found"|"logged_out"|"failed","page_says":"<the page\'s words>","ref":"<the activity or record id, if shown>","filled":["linkedin"|"title"]}]',
      then: node('event-outreach', 'crm-log-results', '--event', e.event.slug, '--file', join(e.paths.work, 'crm-log-results.json')),
      on_error: onToolError(e.event.slug, 'crm.log')
    }
  });
}

// Notes sent in the event app, in the user's own browser (sending on for "app"). The user opens a send window
// with their go-ahead; then one note at a time: find the person by link (no typing), check it's them, paste
// the approved note exactly, send, and report what the page said. Claude Code asks before each note is
// typed. The app's own limits (message length, a daily cap, people who turned messages off) come back from
// the page and are recorded; a page that said nothing clear is checked by the user before any retry.
// Reading replies in the user's browser, only where they said yes (inbox_read): LinkedIn messages or the event
// app's inbox, read only. ids: the people whose follow-up waits on it (null: everyone written to there).
export function inboxStep(c, e, where, ids = null) {
  const src = where === 'LinkedIn' ? 'linkedin' : 'app';
  const page = where === 'LinkedIn' ? 'your LinkedIn messages (linkedin.com/messaging)' : `${e.event.app_name || 'the event app'}'s inbox`;
  return step('check_inbox', `Read ${page} for replies, read only, as the user allowed.`, {
    run_first: node('event-outreach', 'sync-list', '--event', e.event.slug, '--channel', src, ...(ids ? ['--ids', ids.join(',')] : [])),
    judge: {
      read: join(e.paths.dir, 'sync-list.json'),
      how: `In the user's browser, read only: open ${page}, find the conversation with each person listed (by name and company), and read every message since their "since" date. Never type, click send or reply. If the page asks you to sign in, stop and report it.`,
      write: join(e.paths.work, `inbox-${src}.json`),
      format:
        '{"people":[{"id","messages":[{"message_id":"<conversation id>-<n>","direction":"out"|"in","at":"<ISO>","text":"<their words, for an in message>","from":"<who wrote it>","intent":"reply|booked|decline|stop|referral|cancelled|ooo","another_time":true (only on a cancellation that asks for another time)}]}]}; a person with no conversation: "messages": []',
      then: node('event-outreach', 'sync', '--event', e.event.slug, '--source', src, '--file', join(e.paths.work, `inbox-${src}.json`)),
      on_error: onToolError(e.event.slug, `inbox.${src}`)
    }
  });
}

// A follow-up waits on a channel other than its own that this person was written to earlier: read that inbox where
// floorboss can, otherwise ask, in one question for everyone waiting on that channel. w.check: the channels still to
// check (from verifySend); others: the other items waiting, each with its own check.
export function otherChannelStep(c, e, cfg, w, others = []) {
  const kind = w.check?.[0];
  if (!kind) return null;
  const name = w.name || (readJson(join(e.paths.derived, 'contacts.json'), []).find((x) => x.id === w.id) || {}).name || w.id;
  const label = kind === 'email' ? 'email' : kind === 'linkedin' ? 'LinkedIn' : e.event.app_name || 'the event app';
  if (kind === 'email') {
    const task = cfg.connectors?.['email.messages'] ? 'email.messages' : cfg.connectors?.['crm.activity'] ? 'crm.activity' : null;
    if (task && e.state.tool_failed[task]) return toolDown(e, task, task === 'email.messages' ? 'mailbox reader' : 'CRM', ['retry', 'ask me', 'later']);
    if (task) {
      const src = task === 'email.messages' ? 'mailbox' : 'crm';
      return step('check_replies_one', `Before ${name}'s next message goes, their email replies are checked, right now.`, {
        run_first: node('event-outreach', 'sync-list', '--event', e.event.slug, '--ids', w.id),
        judge: {
          read: join(e.paths.dir, 'sync-list.json'),
          write: join(e.paths.work, 'sync.json'),
          format: `the ${task} recipe's answer for this one person, as {"people":[{"id","${src === 'mailbox' ? 'messages' : 'activities'}":[…]}]}`,
          then: node('event-outreach', 'sync', '--event', e.event.slug, '--source', src, '--file', join(e.paths.work, 'sync.json')),
          on_error: onToolError(e.event.slug, task)
        }
      });
    }
  } else if (e.settings.inbox_read?.[kind] === true && !e.state.tool_failed[`inbox.${kind}`]) {
    return inboxStep(c, e, kind === 'linkedin' ? 'LinkedIn' : 'app', [w.id]);
  }
  const contacts = readJson(join(e.paths.derived, 'contacts.json'), []);
  const nameOf = (x) => x.name || (contacts.find((y) => y.id === x.id) || {}).name || x.id;
  // One question for everything floorboss can't read: the other channels, and the one the note itself goes on.
  const ownOf = (x) => (x.via === 'browser' ? (x.where === 'LinkedIn' ? 'linkedin' : 'app') : null);
  const canRead = (k) =>
    k === 'email' ? !!(cfg.connectors?.['email.messages'] || cfg.connectors?.['crm.activity']) : e.settings.inbox_read?.[k] === true && !e.state.tool_failed[`inbox.${k}`];
  const members = [...new Map([w, ...others].filter((x) => x.id === w.id || x.check?.includes(kind) || (ownOf(w) && !x.check?.length && ownOf(x) === ownOf(w))).map((x) => [x.id, x])).values()];
  const batch = members.map((x) => ({ id: x.id, name: nameOf(x) }));
  // Every channel anyone in the batch waits on, in the one question.
  const channels = [...new Set(members.flatMap((x) => [...(x.check || []), ownOf(x)]).filter((k) => k && !canRead(k)))];
  const words = (k) => (k === 'email' ? 'email' : k === 'linkedin' ? 'LinkedIn' : e.event.app_name || 'the event app');
  const where = channels.map(words).join(' or ');
  if (batch.length > 1)
    return step('no_reply_check', `${batch.length} people were written to on ${where} earlier, and nothing can read that here, so the user is asked once before their next messages go.`, {
      ask: {
        id: 'no_reply',
        channels,
        people: batch,
        question: `Follow-ups are due for ${batch.map((x) => x.name).join(', ')}. Has anyone replied, booked or said stop on ${where} since your message there? Name them, or say "none".`,
        options: ['none', 'some replied: <names>'],
        answer_format: '{"people":[<every id asked about>],"replied":["<id>"],"stopped":["<id>"],"said":"<the user\'s words>"} (replied and stopped may be empty); everyone in people not named counts as no reply'
      }
    });
  return step('no_reply_check', `${name} was written to on ${where} earlier, and nothing can read that here, so the user is asked before the next message goes.`, {
    ask: {
      id: 'no_reply',
      channels,
      person: { id: w.id, name },
      question: `Has ${name} replied, booked or said stop on ${where} since your message there?`,
      options: ['no reply', 'they replied', 'they asked to stop'],
      answer_format: '{"id":"<id>","answer":"no reply|they replied|they asked to stop","said":"<the user\'s words>"}'
    }
  });
}

export function appStep(c, e, cfg) {
  // LinkedIn messages go through the same browser path: either channel turns it on.
  const chans = e.settings.sending?.channels || [];
  if (!chans.includes('app') && !chans.includes('linkedin')) return null;
  const list = cli('event-outreach', ['send-list', '--event', e.event.slug], c);
  const items = existsSync(list.browser_file) ? readJson(list.browser_file, []).filter((x) => x.via === 'browser') : [];
  const appName =
    items.length && items.every((x) => x.where === 'LinkedIn')
      ? 'LinkedIn'
      : items.some((x) => x.where === 'LinkedIn')
        ? `${e.event.app_name || 'the event app'} and LinkedIn`
        : e.event.app_name || 'the event app';
  const waitingCheck = (list.waiting || []).filter((w) => w.via === 'browser' && w.touch > 1 && /replies weren't checked/.test(w.why));
  // A note whose page said nothing clear: the user looks in the app before anything else.
  // Or one typed in the window (the guard let it through) with no result: the prompt may have been declined.
  const unclear = Object.entries(e.state.people).flatMap(([id, p]) =>
    Object.entries(p.touches)
      .filter(
        ([, x]) => noteUnsettled(x, e.state.answered)
      )
      .map(([t, x]) => ({ id, touch: Number(t), name: p.name, page: x.app_result?.page_says }))
  );
  if (unclear.length) {
    const u = unclear[0];
    return step('app_outcome', `The app didn't confirm the note to ${u.name}${u.page ? ` ("${String(u.page).slice(0, 80)}")` : ''}.`, {
      ask: {
        id: 'app_outcome',
        person: { id: u.id, touch: u.touch, name: u.name },
        question: `Look in ${appName}'s sent messages: did the note to ${u.name} go? ("it went" or "it did not go")`,
        options: ['it went', 'it did not go'],
        answer_format: '{"went":"yes"|"no","said":"<their words>"}'
      }
    });
  }
  // A send window none of whose notes is still listed is closed: inside it the browser opens only those notes'
  // platform, so a reply read offered next would be refused and recorded as a failed inbox.
  const winNow = readJson(join(c.home, 'browser-send.json'), null);
  if (winNow && !winNow.closed && winNow.event === e.event.slug && !items.some((x) => (winNow.ids || []).includes(`${x.id}:${x.touch}`)))
    cli('event-outreach', ['browser-send', '--event', e.event.slug, '--close'], c);
  if (e.state.tool_failed['app.send']) return toolDown(e, 'app.send', `${appName} in your browser`, ['retry', 'later']);
  if (e.state.app_limit_at && String(e.state.app_limit_at).slice(0, 10) === c.now.toISOString().slice(0, 10))
    return step('waiting', `${appName} won't take more messages today (its daily limit). The rest go tomorrow.`, {
      done: false,
      next_check: 'Run again tomorrow.'
    });
  // Follow-ups in the app: nothing can read the app's inbox, so the user is asked before each one.
  // A follow-up waits on their replies: read the inbox when the user allowed it, rather than asking them.
  if (!items.length && waitingCheck.some((w) => w.check?.length)) {
    const w = waitingCheck.find((x) => x.check?.length);
    return otherChannelStep(c, e, cfg, w, waitingCheck);
  }
  if (!items.length && waitingCheck.length) {
    const wantLi = waitingCheck.filter((w) => w.where === 'LinkedIn'),
      wantApp = waitingCheck.filter((w) => w.where !== 'LinkedIn');
    if (wantLi.length && e.settings.inbox_read?.linkedin === true && !e.state.tool_failed['inbox.linkedin'])
      return inboxStep(
        c,
        e,
        'LinkedIn',
        wantLi.map((w) => w.id)
      );
    if (wantApp.length && e.settings.inbox_read?.app === true && !e.state.tool_failed['inbox.app'])
      return inboxStep(
        c,
        e,
        'app',
        wantApp.map((w) => w.id)
      );
  }
  if (!items.length && waitingCheck.length) {
    const w = waitingCheck[0];
    const name = (readJson(join(e.paths.derived, 'contacts.json'), []).find((x) => x.id === w.id) || {}).name || w.id;
    const ownKind = w.where === 'LinkedIn' ? 'linkedin' : 'app';
    const same = waitingCheck.filter((x) => (x.where === 'LinkedIn' ? 'linkedin' : 'app') === ownKind);
    if (same.length > 1) {
      const nameOf = (x) => (readJson(join(e.paths.derived, 'contacts.json'), []).find((y) => y.id === x.id) || {}).name || x.id;
      const people = same.map((x) => ({ id: x.id, name: nameOf(x) }));
      return step('no_reply_check', `Before ${people.length} follow-ups go in ${appName}, the user is asked once whether anyone replied there.`, {
        ask: {
          id: 'no_reply',
          channels: [ownKind],
          people,
          question: `Follow-ups are due in ${appName} for ${people.map((x) => x.name).join(', ')}. Has anyone replied, booked or said no there since your note? Name them, or say "none".`,
          options: ['none', 'some replied: <names>'],
          answer_format: '{"people":[<every id asked about>],"replied":["<id>"],"stopped":["<id>"],"said":"<the user\'s words>"} (replied and stopped may be empty); everyone in people not named counts as no reply'
        }
      });
    }
    return step('no_reply_check', `Before ${name}'s follow-up goes in ${appName}, the user is asked whether they replied there.`, {
      ask: {
        id: 'no_reply',
        channels: [ownKind],
        person: { id: w.id, name },
        question: `Has ${name} replied, booked or said no in ${appName} (or anywhere else) since your note?`,
        options: ['no reply', 'they replied', 'they booked a time', 'they said stop'],
        answer_format: '{"id","answer":"no reply|they replied|they booked a time|they said stop","said":"<their words>"}'
      }
    });
  }
  if (!items.length) return null;
  if (e.state.answered.app_send_window?.value === 'not now' && String(e.state.answered.app_send_window.at).slice(0, 10) === c.now.toISOString().slice(0, 10))
    return step('waiting', `The notes for ${appName} wait until the user is ready to send them.`, { done: false });
  const win = readJson(join(c.home, 'browser-send.json'), null);
  const open =
    win &&
    !win.closed &&
    win.event === e.event.slug &&
    Date.parse(win.until) > c.now.getTime() &&
    items.some((x) => (win.ids || []).includes(`${x.id}:${x.touch}`));
  if (!open)
    return step('app_send_window', `${items.length} approved ${items.length === 1 ? 'note goes' : 'notes go'} in ${appName}, in the user's own browser.`, {
      ask: {
        id: 'app_send_window',
        question: `Ready to send ${items.length} ${items.length === 1 ? 'note' : 'notes'} in ${appName}? Open it in your browser and log in first. Floorboss opens a 20-minute window; Claude Code asks you before each note is typed, naming the person.`,
        options: ['yes, send them now', 'not now'],
        answer_format: "the user's words"
      }
    });
  const it = items.find((x) => (win.ids || []).includes(`${x.id}:${x.touch}`));
  return step(
    'app_send_one',
    `Send the approved ${it.touch > 1 ? `follow-up ${it.touch - 1}` : 'note'} to ${it.name} in ${appName}. Claude Code asks the user before the note is typed.`,
    {
      judge: {
        read: null,
        target: { id: it.id, touch: it.touch, name: it.name, to: it.to, app: appName, app_url: e.settings.app_url || null, body: it.body },
        how: `In the browser: open ${appName}'s people search by its link with their name (don't type into a search box), open the profile that matches the name and company in "to", and stop if none does (result not_found) or the profile says messages are off (messages_off). Paste the body exactly as given into the message box, click send, then read the page and write what it says.`,
        write: join(e.paths.work, 'app-result.json'),
        format:
          '{"id","touch","result":"sent"|"not_found"|"messages_off"|"too_long"|"limit"|"logged_out"|"failed","page_says":"<the page\'s own words after sending>"}',
        then: node('event-outreach', 'app-result', '--event', e.event.slug, '--file', join(e.paths.work, 'app-result.json')),
        on_error: node(
          'event-outreach',
          'app-result',
          '--event',
          e.event.slug,
          '--id',
          it.id,
          '--touch',
          String(it.touch),
          '--result',
          'failed',
          '--page-says-file',
          errorFile(e.event.slug)
        )
      }
    }
  );
}

// An app note whose fate is open: the page said nothing clear and the user hasn't answered since, or the guard let
// it through when typed and no result came back.
export const noteUnsettled = (x, answered) =>
  !x.sent &&
  ((x.app_result?.result === 'failed' && !(answered?.app_outcome && Date.parse(answered.app_outcome.at) >= Date.parse(x.app_result.at))) ||
    (x.released && !x.release_cleared && x.released_via === 'browser'));
// The note an app_outcome answer settles: the person the step asked about. With no step (floorboss's own unit tests,
// saving out of turn), the first the step would ask about.
export function appOutcomeTarget(folded, s) {
  const open = (id, t, x) => ({ id, touch: Number(t), released: !!(x?.released && !x.release_cleared) });
  if (s?.ask?.id === 'app_outcome' && s.ask.person) return open(s.ask.person.id, s.ask.person.touch, folded.people[s.ask.person.id]?.touches?.[s.ask.person.touch]);
  return Object.entries(folded.people).flatMap(([id, p]) =>
    Object.entries(p.touches)
      .filter(([, x]) => noteUnsettled(x, folded.answered))
      .map(([t, x]) => open(id, t, x))
  )[0];
}
// The channels a no_reply question asked about, from the step: a word about one can't stand for another. [null]: no
// step to read them from (the word then carries no channel, as an older one does).
export const askedChannels = (s) => {
  const list = (s?.ask?.channels || []).filter((k) => ['email', 'app', 'linkedin'].includes(k));
  return list.length ? list : [null];
};
