// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// check(): the decision for one MCP call, before it runs. It brings the other files' rules together: the run
// lock, the recipe, lookups, the browser, sends and staged drafts.
import { isBrowserServer, isBrowserTool, isScriptTool, isBrowserReadTool, URL_CAP, sameServer } from '../../lib/security.mjs';
import { bareToolName, screenTool, checkRecipe, TASKS } from '../../skills/connectors/scripts/tasks.mjs';
import { nowMs as clockNow } from '../../lib/clock.mjs';
import { leaves, recent, fold } from './shared.mjs';
import { lockNote } from './run.mjs';
import { isBrowser, argRefusal, runReads, browserServerKnown, givenServer, readsOnly, foundServer, templateFits } from './connectors.mjs';
import { enrichServerTool, enrichRefusal } from './lookups.mjs';
import { inboxRefusal, navRefusal, logNavRefusal, windowSiteRefusal, windowRefusal } from './browser.mjs';

export function check(
  input,
  {
    config,
    stageItems,
    taskItems = [],
    contactItems = [],
    sendItems = [],
    active = false,
    browserSend = null,
    crmLog = null,
    sent = [],
    enrichWindow = null,
    enrichUsed = [],
    hosts = [],
    pages = [],
    asks = [],
    tasks = [],
    contacts = [],
    staged = []
  }
) {
  const name = String(input?.tool_name || '');
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const browser = isBrowser(m[1], m[2]);
  // Inboxes are private: LinkedIn messages and an event app's inbox are opened only if the user said yes
  // (inbox_read), whether or not a floorboss run is going on.
  if (browser || isBrowserServer(m[1]) || isBrowserTool(m[2])) {
    const why = inboxRefusal(input.tool_input || {}, config);
    if (why) return why;
  }
  const run = active === true ? { active: true } : active || { active: false };
  // Script in a web page: never while floorboss runs or a browser window is open.
  if ((browser || isBrowserServer(m[1])) && isScriptTool(m[2]) && (run.active || browserSend || crmLog))
    return `${m[2]} runs script in a web page, and ${run.active ? 'a floorboss run is under way' : 'a floorboss browser window is open'}: floorboss never lets a page run script then.${lockNote(run)}`;
  const recipes = Object.entries(config?.connectors || {}).filter(([, r]) => r && bareToolName(r.tool) === m[2] && (!r.server || sameServer(m[1], r.server)));
  // A recipe whose tool no longer passes floorboss's screen (an edited config.json) is never honoured.
  // A recipe that writes (a send, a staged draft, a new CRM contact, a CRM task) must pass the whole recipe check
  // (its test seen by the user, the tool's fingerprint, only its own placeholders), not just its name: a
  // config.json written by anything else is refused.
  for (const [task, r] of recipes)
    if ((TASKS[task]?.kind === 'send' || ['stage_draft', 'crm.create_contact', 'crm.create_task'].includes(task)) && checkRecipe(task, r).length)
      return `config.json's ${task} recipe isn't one floorboss saved (${checkRecipe(task, r)[0]}). Re-run discovery in /floorboss:event-setup.`;
  for (const [task, r] of recipes)
    if (!screenTool(task, r.tool).ok)
      return `config.json maps ${task} to ${r.tool}, which floorboss's screen refuses (${screenTool(task, r.tool).reason}). Re-run discovery in /floorboss:event-setup.`;
  if (!recipes.length) {
    // Another tool on the people-data server: the lookup window holds it, run or not; during a run it also
    // gets no links or key paths, and must be a read or a lookup.
    const er = enrichServerTool(config, m[1], m[2]);
    if (er) {
      if (run.active) {
        const arg = argRefusal(m[2], m[1], input.tool_input || {});
        if (arg) return `${arg}${lockNote(run)}`;
      }
      if (!runReads(m[2]) && !screenTool('enrich.person', m[2]).ok)
        return `${m[2]} on ${m[1]} isn't the lookup tool floorboss set up (${er.tool}) and isn't a read or a single lookup: floorboss doesn't let it run on the server it uses for paid lookups. If you, the user, want it, turn the floorboss plugin off for that session.`;
      return enrichRefusal(
        er,
        m[1],
        m[2],
        enrichWindow,
        asks,
        enrichUsed,
        false,
        leaves(input.tool_input || {})
          .map(([, v]) => v)
          .filter((v) => typeof v === 'string')
      );
    }
    const windowOpen = !!(browserSend || crmLog);
    if (!run.active && !(windowOpen && browser)) return null;
    const note = lockNote(run);
    // During a run, nothing anywhere may send, reply or delete: an instruction hidden in an attendee note or a
    // web page can't reach the user's mail, chat or CRM through any server, given to floorboss or not.
    // The browser does only reads during a run (no clicks, typing or form filling on a page), except inside a
    // send window the user's approval opened (outreach browser-send), for its listed messages, or the CRM log
    // window (outreach open-log-window), for logging listed messages in the CRM's web app; and it opens only
    // pages floorboss has a reason to (navRefusal).
    // During a run a browser_* tool on a server not known to be a browser is that server's: the rules below decide it.
    if (browser && (!run.active || browserServerKnown(m[1], m[2]))) {
      const nav = navRefusal(m[2], input.tool_input || {}, hosts, pages, asks);
      if (nav) return `${nav}${lockNote(run, hosts)}`;
      const logNav = crmLog && !browserSend ? logNavRefusal(m[2], input.tool_input || {}) : null;
      if (logNav) return logNav;
      const siteNav = browserSend ? windowSiteRefusal(m[2], input.tool_input || {}, browserSend) : null;
      if (siteNav) return `${siteNav}${lockNote(run, hosts)}`;
      if (run.active && isBrowserReadTool(m[2]) && leaves(input.tool_input || {}).some(([, v]) => typeof v === 'string' && (v.length > URL_CAP || /[\r\n]/.test(v))))
        return `${m[2]} was called with a value that is long or spans lines, and a floorboss run is under way: the browser's reads take short values only then.${note}`;
      if (windowOpen) return windowRefusal(m[2], input.tool_input || {});
      // Read tools keep their name with or without an _mcp suffix (tabs_context_mcp reads the open tabs).
      return isBrowserReadTool(m[2])
        ? null
        : `${m[2]} acts in the browser, and a floorboss run is under way: the browser only reads while floorboss runs.${note}`;
    }
    const arg = argRefusal(m[2], m[1], input.tool_input || {});
    if (arg) return `${arg}${note}`;
    // The connectors floorboss was given are held to floorboss's own read screens.
    // A tool name with a further "__" (mcp__hubspot__get__contacts) can come from a server named "hubspot__get":
    // it is never taken for the given or found server's.
    if (!m[2].includes('__') && givenServer(m[1], config, run))
      return readsOnly(m[2])
        ? null
        : `${m[2]} on ${m[1]} isn't a read-only tool, and a floorboss run is using this connector, so floorboss holds it to reads.${note}`;
    // Every other server: only tools that plainly read. A list of send words always misses one (a Resend
    // "emails.create", "add contacts to sequence", a Zapier action, an HTTP or webhook tool), so during a run
    // anything that isn't clearly a read waits until the run ends.
    // A connector setup found or the user chose (the scan's inventory, the onboarding answers): reads only, held
    // to floorboss's own read screens, as a given one is. Any other server (a workspace, a chat, a search or
    // DNS tool) gets nothing while floorboss runs: a read there can carry what this session read, in its query.
    // Another session, while a run is live (it didn't read the run's text): reads pass, as before.
    if (!run.session && !run.subagent) {
      if (runReads(m[2])) return null;
      return `${m[2]} on ${m[1]} isn't plainly a read, and a floorboss run is under way: while floorboss runs, tools on any server may only read (anything that could send, write or call out waits until the run ends).${note}`;
    }
    if (!m[2].includes('__') && foundServer(m[1]))
      return readsOnly(m[2])
        ? null
        : `${m[2]} on ${m[1]} isn't a read floorboss uses, and a floorboss run is under way: while floorboss runs, a connector it hasn't set up yet may only be read with the tools floorboss checks for.${note}`;
    return `${m[2]} is on ${m[1]}, which floorboss wasn't given and didn't find at setup, and a floorboss run is under way: while floorboss runs, it calls only the connectors it uses (anything else could carry what this session read). ${m[1]} is available again when the run ends.${note}`;
  }
  const args = input.tool_input || {};
  const got = leaves(args);
  for (const [task, r] of recipes) {
    // The recipe's leaves by path; a path may hold several values (a list of fields), any of which is fine.
    const template = new Map();
    for (const [p, v] of leaves(r.args || {})) template.set(p, [...(template.get(p) || []), v]);
    for (const [p, v] of got) {
      const allowed = template.get(p);
      if (!allowed) return `${m[2]} was called with "${p}", which isn't in floorboss's ${task} recipe.`;
      const fits = allowed.some((t) =>
        typeof t === 'string' && /\{[a-z_]+\}/.test(t) ? /^\{[a-z_]+\}$/.test(t) || templateFits(t, String(v ?? '')) : t === v
      );
      if (!fits) return `${m[2]}: "${p}" must be as in the recipe (${allowed.map((t) => JSON.stringify(t)).join(' or ')}).`;
    }
    // A people-data lookup spends the user's credits: only inside the window their yes opened, and no more
    // lookups than they agreed to.
    if (task === 'enrich.person') {
      // The values at the recipe's placeholders (its literals are checked above, as written).
      const placeheld = got.filter(([p]) => (template.get(p) || []).some((t) => typeof t === 'string' && /\{[a-z_]+\}/.test(t))).map(([, v]) => v);
      const why = enrichRefusal(
        r,
        m[1],
        m[2],
        enrichWindow,
        asks,
        enrichUsed,
        true,
        placeheld.filter((v) => typeof v === 'string')
      );
      if (why) return why;
      continue;
    }
    if (task === 'crm.create_task') {
      const v = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, x]) => String(x ?? ''));
      const title = v('{title}'),
        body = v('{body}'),
        ref = v('{contact_ref}'),
        due = v('{due}');
      if (!title.length || !body.length) return 'a task needs its title and body, exactly as floorboss listed them.';
      if (ref.length > 1) return 'a task goes on one contact only.';
      // A due date is a date (2026-10-30, or with a time: 2026-10-30T09:00:00Z), never a line of text: it goes
      // in the prompt as it is.
      if (!due.every((d) => !d.trim() || /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z?)?$/.test(d.trim())))
        return "a task's due date is the date floorboss listed (YYYY-MM-DD), nothing else.";
      // Listed in the last 30 minutes: a list made before someone said stop can't be used after.
      // floorboss's clock (FLOORBOSS_NOW in tests and simulations), else the real one.
      const nowMs = clockNow();
      const fresh = (x) => !x.listed_at || recent(x.listed_at, nowMs, 30 * 60 * 1000);
      const item = (taskItems || [])
        .filter((x) => x && typeof x === 'object' && fresh(x))
        .find(
          (x) =>
            title.every((t) => t.trim() === String(x.title).trim()) &&
            body.every((b) => b.trim() === String(x.body).trim()) &&
            (x.contact_ref ? ref.every((r) => r.trim().toLowerCase() === String(x.contact_ref).toLowerCase()) : ref.every((r) => !r.trim())) &&
            due.every((d) => !x.due || d.slice(0, 10) === String(x.due).slice(0, 10) || Math.abs(Date.parse(d) - Date.parse(x.due)) < 36 * 3600000)
        );
      if (!item)
        return 'this task isn\'t one floorboss listed in the last 30 minutes (title, body, contact and due date must match an item in task-list.json). Run "outreach task-list" again and use its text as written.';
      // A task is a write in the user's CRM: they see what goes in before it does (the list is a file a
      // session could write, like the send list).
      tasks.push({
        server: r.server || m[1],
        tool: m[2],
        title: title[0],
        body: body[0],
        contact: ref[0] || null,
        due: due[0] || null,
        name: item.name || item.id || null,
        id: item.id || null,
        key: item.key || null,
        _event: item._event || null
      });
      continue;
    }
    // A new CRM record: one person floorboss listed in the last 30 minutes, with their own name, email,
    // company and title exactly as listed. The user sees it whole before it goes in.
    if (task === 'crm.create_contact') {
      const v = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, x]) => String(x ?? '').trim());
      const email = v('{email}');
      if (email.length !== 1) return 'a new CRM record carries exactly one address, the listed one.';
      const nowMs = clockNow();
      const same = (vals, want) => vals.every((x) => !x || x === String(want ?? '').trim());
      const item = (contactItems || [])
        .filter((x) => x && typeof x === 'object' && recent(x.listed_at, nowMs, 30 * 60 * 1000))
        .find(
          (x) =>
            fold(email[0]) === fold(x.email) &&
            same(v('{name}'), x.name) &&
            same(v('{first_name}'), x.first_name) &&
            same(v('{last_name}'), x.last_name) &&
            same(v('{company}'), x.company) &&
            same(v('{title}'), x.title)
        );
      if (!item)
        return 'this person isn\'t one floorboss listed to add to your CRM in the last 30 minutes (name, email, company and title must match an item in contact-list.json). Run "outreach contact-list" again and use its values as written.';
      contacts.push({
        server: r.server || m[1],
        tool: m[2],
        name: item.name,
        email: item.email,
        company: item.company || '',
        title: item.title || '',
        id: item.id,
        _event: item._event,
        // What the call itself carries, shown as sent: the prompt never shows only the list's version.
        args: got.map(([p, x]) => `${p}: ${String(x ?? '').slice(0, 120)}`)
      });
      continue;
    }
    if (TASKS[task]?.kind === 'send') {
      // A send: exactly one approved message from today's send list, listed in the last 30 minutes, to its own
      // recipient with its own text, and not sent before (each item goes once).
      const value = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, v]) => String(v ?? ''));
      const to = value('{to}'),
        subject = value('{subject}'),
        body = value('{body}');
      if (!to.length || !body.length) return 'a send needs its recipient and body, exactly as floorboss listed them.';
      const nowMs = clockNow();
      const item = (sendItems || [])
        .filter((x) => x && typeof x === 'object' && x.via === task && recent(x.listed_at, nowMs, 30 * 60 * 1000))
        .find(
          (x) =>
            to.every((t) => fold(t) === fold(x.to)) &&
            body.every((b) => b.trim() === String(x.body).trim()) &&
            subject.every((v) => v.trim() === String(x.subject || '').trim())
        );
      if (!item)
        return 'this message isn\'t one floorboss listed to send in the last 30 minutes (recipient, subject and body must match an item in send-list.json exactly, and each goes once). Run "outreach send-list" and send its items as written.';
      // The thread: a follow-up goes in the thread of the message before it, and only that one. A thread
      // argument holding anything else (another person's conversation) is refused; one left out is refused
      // when floorboss knows the thread and the tool can take it.
      const threads = [...value('{thread_id}'), ...value('{reply_in_thread}')].map((t) => t.trim()).filter(Boolean);
      const replyTo = value('{reply_to_message_id}')
        .map((t) => t.trim())
        .filter(Boolean);
      if (replyTo.some((t) => t !== String(item.reply_to_message_id || '')))
        return `the reply-to argument must be the listed one (${item.reply_to_message_id || 'none'}).`;
      const canThread = [...template.values()].flat().some((t) => t === '{thread_id}' || t === '{reply_in_thread}');
      if (threads.some((t) => t !== String(item.thread_id || '')))
        return `the thread argument must be the listed one (${item.thread_id || 'none: a first message starts a new thread'}).`;
      if (canThread && item.thread_id && !threads.length) return `this follow-up goes in the thread of the message before it: pass thread ${item.thread_id}.`;
      sent.push(item);
      continue;
    }
    if (task !== 'stage_draft') continue;
    const value = (ph) => got.filter(([p]) => (template.get(p) || []).includes(ph)).map(([, v]) => String(v ?? ''));
    const to = value('{to}'),
      subject = value('{subject}'),
      body = value('{body}');
    if (!to.length || !body.length) return 'a staged draft needs its recipient and body, exactly as floorboss listed them.';
    const same = (x) =>
      to.every((t) => fold(t) === fold(x.to)) &&
      body.every((b) => b.trim() === String(x.body).trim()) &&
      subject.every((s) => s.trim() === String(x.subject || '').trim());
    const item = (stageItems || []).filter((x) => x && typeof x === 'object' && !x._why).find(same);
    // Listed and approved, but the record says no now (a stop, a reply, removed, or listed too long ago).
    const held = !item && (stageItems || []).filter((x) => x && typeof x === 'object' && x._why).find(same);
    if (held) return `the draft for ${held.id} can't be staged now: ${held._why}.`;
    if (!item)
      return 'this draft isn\'t one floorboss listed to stage (recipient, subject and body must match an item in stage-list.json exactly). Run "outreach stage-list" and use its text as written.';
    // The thread, as for a send: only the listed one (the draft before it with this person), never another
    // conversation; and no reply-to of its own.
    {
      const threads = [...value('{thread_id}'), ...value('{reply_in_thread}')].map((t) => t.trim()).filter(Boolean);
      if (threads.some((t) => t !== String(item.reply_in_thread || '')))
        return `the thread argument must be the listed one (${item.reply_in_thread || 'none: a first message starts a new thread'}).`;
      if (value('{reply_to_message_id}').some((t) => t.trim() && t.trim() !== String(item.reply_to_message_id || '')))
        return `the reply-to argument must be the listed one (${item.reply_to_message_id || 'none'}).`;
    }
    staged.push({ ...item, server: r.server || m[1], tool: m[2] });
  }
  return null;
}
