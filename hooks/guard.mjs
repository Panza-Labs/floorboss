#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// PreToolUse guard for MCP calls, for Claude's own file tools (Read, Grep, Glob, Write, Edit, MultiEdit,
// NotebookEdit), and for the shell and subagent tools (Bash, PowerShell, Monitor, Agent, Task: see the main path);
// also binds the run lock to the session running floorboss (Bash) and ends it (SessionEnd).
// Run with "post" (PostToolUse), it records what a call that ran had asked about: a lookup counted, a staged
// batch confirmed (afterCall).
// - A tool floorboss has a recipe for may be called only with the recipe's own arguments, and stage_draft only
//   with a message floorboss listed to stage, word for word, to its own recipient.
// - While a floorboss run is under way (lib/runlock.mjs: for the session that ran floorboss, until it ends;
//   for others, until run-end or RUN_LOCK_MINUTES after the last refresh), every MCP tool on every server
//   must plainly read (runReads) and gets no links, the connectors floorboss was given must pass its stricter
//   read screens, and the browser only reads, opens only pages floorboss has a reason to, and never runs
//   script: an instruction hidden in an attendee note, a web page or a tool description can't send, write or
//   call out anywhere. Outside a run, tools floorboss has no recipe for are the user's own business.
// - Claude's own file tools: never a read of keys, credentials, shell histories or browser profiles; never a
//   write to floorboss's own records (only its scripts write those); and while a run is under way, no write
//   outside floorboss's data folder and the temp folder.
// - Claude Code's WebFetch and WebSearch, while a run is under way: no address or query past WEB_CAP or with a
//   line break, and WebFetch only to the sites the browser may open (webRefusal).
// - Any failure inside the guard blocks the call (fail closed).
// This file is the entry point: it reads the hook's input and decides, and holds the rules for Bash and agents
// during a run and the ask-once logic. The other rules are in guard/, one topic per file (SECURITY.md lists them
// under "Reading the guard").
import { existsSync, unlinkSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { home, recordFile } from '../lib/paths.mjs';
import { readRun, readRunAnySession, stampRun, lockPath, endSession, touchSession, ranBefore } from '../lib/runlock.mjs';
import { bareBrowserTool, readUrl, looksLikeUrl } from '../lib/security.mjs';
import { eventRecord, oldestReplyCheck } from '../lib/sendcheck.mjs';
import { withLock } from '../lib/lock.mjs';
import { loadEvent } from '../lib/event.mjs';
import { randomBytes } from 'node:crypto';
import { appendLine, writeText } from '../lib/jsonio.mjs';
import { isMain } from '../lib/main.mjs';
import { nowMs as clockNow } from '../lib/clock.mjs';
import { readJsonStrict, fold, leaves, squash } from './guard/shared.mjs';
import { isSubagent, inheritedRun, transcriptRanFloorboss, CHECKED_TOOLS, QUIET_TOOLS } from './guard/run.mjs';
import { ask, allow, promptId, promptPerson, promptAddr, promptLine, personName, holdHistory, letThroughBefore } from './guard/prompts.mjs';
import { isBrowser, givenServer } from './guard/connectors.mjs';
import { testOnItsServer, testContactItem, testPasses, markOnce, nameOfStaged } from './guard/test-calls.mjs';
import { callNote, enrichNotes, windowUsed, windowAllowed, lookupsGone, enrichPendingDir } from './guard/lookups.mjs';
import { listed, listedSends, refusedSends, fullText, stageBatch, recipientShown } from './guard/sends.mjs';
import { openWindow, openLogWindow, callId, windowKey, browserItems, logItems, KEY_OK, logTyping, noteWhy } from './guard/browser.mjs';
import { READ_TOOLS, WRITE_TOOLS, fileRefusal } from './guard/files.mjs';
import { recordSearchHosts, WEB_TOOLS, webRefusal, knownEventSites, isResearcher, seenHosts, companyHosts } from './guard/web.mjs';
import { bashRefusal, floorbossScriptCall, connectorChange } from './guard/shell.mjs';
import { check } from './guard/check.mjs';
import { afterCall } from './guard/after-call.mjs';
export { leaves, recent } from './guard/shared.mjs';
export { runReads, sendsOrDeletes, plainServerRead, foundServer, givenServer } from './guard/connectors.mjs';
export { testPasses, testArgProblems, testContactItem, testOnItsServer } from './guard/test-calls.mjs';
export { enrichServerTool, windowUsed, windowOpen, windowAllowed, enrichArgRefusal, lookupsGone } from './guard/lookups.mjs';
export { inboxRefusal, browserItems, logItems, logTyping } from './guard/browser.mjs';
export { check } from './guard/check.mjs';
export { holdHistory, personName, scrub, promptName, promptPerson } from './guard/prompts.mjs';
export { listedSends, listed, stageRefusal, approvedText, fullText, recipientShown } from './guard/sends.mjs';
export { globForms, globSeeksSecrets, fileRefusal } from './guard/files.mjs';
export { WEB_TOOLS, WEB_CAP, isResearcher, webRefusal, seenHosts, recordSearchHosts, companyHosts, knownEventSites } from './guard/web.mjs';
export { CHECKED_TOOLS, QUIET_TOOLS, transcriptRanFloorboss, inheritedRun, isSubagent } from './guard/run.mjs';
export { floorbossScriptCall, bashRefusal } from './guard/shell.mjs';
export { afterCall } from './guard/after-call.mjs';

// recordFile (the records only floorboss's scripts write) lives in lib/paths.mjs: script --out paths use it too.
export { recordFile };

// Well inside the hook timeout in hooks.json (30 seconds), so a slow async check ends blocked rather than timed out.
// Synchronous work that hangs can't reach this timer; that case relies on onFailure: "block" in hooks.json
// (Claude Code 2.1.295 or later; older versions let a timed-out call through).
export const GUARD_DEADLINE_MS = 20000;

if (isMain(import.meta.url)) {
  // A check that hangs while waiting blocks the call before Claude Code's own hook timeout (hooks.json) would.
  setTimeout(() => {
    process.stderr.write(
      'floorboss blocked this call: its guard took too long to check it. Try again; if it keeps happening, this is for you, the user, to look at.\n'
    );
    process.exit(2);
  }, GUARD_DEADLINE_MS).unref();
  let raw = '';
  process.stdin.on('data', (d) => {
    raw += d;
  });
  process.stdin.on('end', () => {
    let input = {};
    // A call it can't read is a call it can't check: blocked (after a call has run, nothing is blocked).
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      if (process.argv[2] === 'post') process.exit(0);
      process.stderr.write("floorboss blocked this call: its guard couldn't read it. This is for you, the user, to look at.\n");
      process.exit(2);
    }
    const toolName = String(input?.tool_name || '');
    const session = typeof input?.session_id === 'string' ? input.session_id : null;
    // Inside a subagent (agent_id set), held to any live run lock: the docs don't say its session_id is the parent's.
    // Any agent_id that isn't empty counts, whatever its type (a number or an object is not the main session).
    const subagent = isSubagent(input);
    // PostToolUse ("post"): records what a call that ran had asked about; never blocks anything.
    if (process.argv[2] === 'post' || input?.hook_event_name === 'PostToolUse') {
      // A web search while floorboss runs (the researcher's, usually): the hosts it turned up are the ones the
      // researcher may then open.
      if (toolName === 'WebSearch') {
        try {
          if (readRunAnySession(Date.now()).active)
            recordSearchHosts(input.tool_response ?? input.tool_output, Date.now(), String(input.tool_input?.query ?? ''));
        } catch {
          /* not recorded: those pages stay closed */
        }
        process.exit(0);
      }
      try {
        if (!subagent) afterCall(input);
      } catch {
        /* not recorded: the next call asks again */
      }
      process.exit(0);
    }
    // A forked session carries a run it never stamped: found in its transcript before its first call is judged.
    if (process.argv[2] !== 'start' && input?.hook_event_name !== 'SessionEnd' && !subagent && session && !readRun(Date.now(), session).session)
      inheritedRun(session, input.transcript_path);
    // SessionStart: a session resumed (or compacted) that ran floorboss before still holds that run's text in its
    // transcript, so the run's limits come back with it.
    if (input?.hook_event_name === 'SessionStart') {
      try {
        // Resumed, compacted or forked (a fork has a new id): known by its id or transcript, or by a floorboss script
        // call in the transcript it carries over.
        if (
          ['resume', 'compact', 'fork'].includes(String(input.source || '')) &&
          (ranBefore([session, input.transcript_path]) || transcriptRanFloorboss(input.transcript_path))
        )
          stampRun({ session, transcript: input.transcript_path });
      } catch {
        /* best effort */
      }
      process.exit(0);
    }
    // The catch-all hook ("other"): the tools the two hooks above already check are left to them; any other tool
    // in the session that ran floorboss (or a subagent while a run is live) is refused unless it's one that only
    // plans, asks or keeps a to-do list. A new tool (publishing a page, a scheduled or remote agent, a message to
    // another session) can't carry the run's text out before floorboss knows what it does.
    if (process.argv[2] === 'other') {
      if (/^mcp__/.test(toolName) || CHECKED_TOOLS.has(toolName)) process.exit(0);
      const otherRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
      if (!(otherRun.active && (otherRun.session || subagent))) process.exit(0);
      if (QUIET_TOOLS.has(toolName)) process.exit(0);
      // How a subagent hands its result to the session that started it: nothing leaves this session, and without it a
      // researcher, writer or critic does its work and can't say what it found.
      if (subagent && toolName === 'SubagentHandback') process.exit(0);
      if (toolName === 'Skill' && /^floorboss:/.test(String(input.tool_input?.skill ?? input.tool_input?.name ?? ''))) process.exit(0);
      process.stderr.write(
        `floorboss blocked this call: this session ran floorboss and read text from your lists, CRM and the web, so ${toolName || 'this tool'} waits until the session ends (floorboss can't check what it sends). Start a new session (or /clear) to use it.\n`
      );
      process.exit(2);
    }
    // SessionEnd: a session that ran floorboss is over, and with it the run's text.
    if (input?.hook_event_name === 'SessionEnd') {
      try {
        endSession(session);
      } catch {
        /* nothing to end */
      }
      process.exit(0);
    }
    // The run lock is stamped in real time (lib/runlock.mjs), so every read of it below uses the real clock, not
    // floorboss's movable one.
    // A subagent started in the session that ran floorboss (or while a run is live) reads what that session
    // read: only floorboss's own agents, and the drafter the user chose, may be started then.
    if (toolName === 'Agent' || toolName === 'Task') {
      const agentRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
      if (agentRun.active && (agentRun.session || subagent)) {
        const type = String(input.tool_input?.subagent_type || '');
        // The drafter counts only as an agent the scan found reading at most (the same rule its setting is
        // saved under): a skill, an "instructions" file or an agent that could send or write starts nothing here.
        let drafter = null;
        try {
          const d = readJsonStrict(join(home(), 'config.json'), {})?.drafter;
          const inv = readJsonStrict(join(home(), 'inventory.json'), {});
          const seen = (inv?.items || []).find((x) => x.type === 'agent' && x.name === d?.invoke);
          drafter = d?.type === 'agent' && seen && ['none', 'reads'].includes(seen.tools_risk) ? d.invoke : null;
        } catch {
          drafter = null;
        }
        // An agent run elsewhere (a cloud environment) is out of this machine's guard: its web and tool limits
        // would not hold there. Only an agent run here (or in a local worktree) starts.
        const isolation = input.tool_input?.isolation;
        if (isolation != null && isolation !== '' && isolation !== 'worktree') {
          process.stderr.write(
            `floorboss blocked this call: while floorboss runs, agents run on this machine, where its checks hold, not with isolation "${String(isolation).slice(0, 20)}".\n`
          );
          process.exit(2);
        }
        // The researcher is the one agent with the open web: its brief is floorboss's own (a company, the people's
        // names and titles), never an email address or a pasted export.
        if (type === 'floorboss:attendee-researcher') {
          const brief = String(input.tool_input?.prompt ?? '');
          if (brief.length > 8000 || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(brief)) {
            process.stderr.write(
              "floorboss blocked this call: the researcher's brief is floorboss's own input for the step (a company, people's names and titles), never an email address or more than a few thousand characters, since the researcher reads and fetches on the open web.\n"
            );
            process.exit(2);
          }
        }
        if (!(type.startsWith('floorboss:') || (drafter && type === drafter))) {
          process.stderr.write(
            `floorboss blocked this call: this session ran floorboss, so the only agents it starts are floorboss's own and the drafter you chose${drafter ? ` (${drafter})` : ''}, not "${type || 'a general agent'}". Start a new session (or /clear) for other agents.\n`
          );
          process.exit(2);
        }
      }
      process.exit(0);
    }
    // Other tools that run shell commands (PowerShell on Windows, a background Monitor): none runs a floorboss
    // script, so in the session that ran floorboss (or a subagent while a run is live) they're refused like any
    // other shell command; elsewhere they're left to Claude Code's own prompt.
    if (toolName === 'PowerShell' || toolName === 'Monitor') {
      const shellRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
      if (shellRun.active && (shellRun.session || subagent)) {
        process.stderr.write(
          `floorboss blocked this call: this session ran floorboss and read text from your lists, CRM and the web, so it can't run ${toolName} commands until the session ends. Start a new session (or /clear) for other commands.\n`
        );
        process.exit(2);
      }
      process.exit(0);
    }
    // Bash: a floorboss script with anything but plain words and quotes is refused (bashRefusal). In the session
    // that ran floorboss, or a subagent while a run is live, so is any command that isn't a floorboss script call
    // (floorbossScriptCall: a skill's cli.mjs, or the mock event's load.mjs). A script call other than run-end or
    // record, from a hook input with a session id, ties the run lock to this session.
    if (toolName === 'Bash') {
      let why = null;
      try {
        why = bashRefusal(input.tool_input?.command);
      } catch (e) {
        why = `its guard couldn't check this command (${String(e.message).slice(0, 80)}).`;
      }
      if (why) {
        process.stderr.write(`floorboss blocked this call: ${why}\n`);
        process.exit(2);
      }
      let call = null;
      try {
        call = floorbossScriptCall(input.tool_input?.command);
      } catch {
        call = null;
      }
      // The session that ran floorboss (and any subagent while a run is live) has read text from lists, CRM
      // notes, pages and replies: there, a shell command other than floorboss's own scripts could send that text
      // anywhere, or rewrite floorboss's records. Refused until the session ends (/clear or a new session).
      if (!call) {
        const bashRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        if (bashRun.active && (bashRun.session || subagent)) {
          process.stderr.write(
            "floorboss blocked this call: this session ran floorboss and read text from your lists, CRM and the web, so its shell commands are limited to floorboss's own scripts until the session ends. Start a new session (or /clear) for other commands.\n"
          );
          process.exit(2);
        }
      }
      if (call?.skill === 'connectors' && ['save-recipe', 'forget'].includes(call.sub)) {
        // A throw here is a refusal: only exit 2 stops the call.
        let change;
        try {
          const connRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
          const held = !!(connRun.active && (connRun.session || subagent));
          change = connectorChange(input.tool_input?.command, call.sub, { held, subagent, config: readJsonStrict(join(home(), 'config.json'), {}) });
        } catch (e) {
          change = { refuse: `its guard couldn't check this connection change (${String(e?.message).slice(0, 80)}).` };
        }
        if (change.refuse) {
          process.stderr.write(`floorboss blocked this call: ${change.refuse}\n`);
          process.exit(2);
        }
        if (change.ask) ask(change.ask);
      }
      try {
        if (call && session && !['run-end', 'record'].includes(call.sub)) stampRun({ session, transcript: input.transcript_path });
      } catch {
        /* best effort */
      }
      allow();
    }
    try {
      if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
        const fileRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        const why = fileRefusal(toolName, input.tool_input, fileRun);
        if (why) {
          process.stderr.write(`floorboss blocked this call: ${why}\n`);
          process.exit(2);
        }
        // The session that ran floorboss is still at work: its limits hold SESSION_LOCK_HOURS from now.
        if (fileRun.session) touchSession(session);
        process.exit(0);
      }
      if (WEB_TOOLS.has(toolName)) {
        const webRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        const why = webRun.active
          ? webRefusal(
              toolName,
              input.tool_input,
              webRun,
              knownEventSites().hosts,
              subagent && isResearcher(input) ? { researcher: true, seen: seenHosts(), companies: companyHosts() } : {}
            )
          : null;
        if (why) {
          process.stderr.write(`floorboss blocked this call: ${why}\n`);
          process.exit(2);
        }
        process.exit(0);
      }
      if (!/^mcp__/.test(toolName)) process.exit(0);
      const nowMs = clockNow();
      const run = subagent ? { ...readRunAnySession(Date.now()), subagent: true } : readRun(Date.now(), session);
      const config = readJsonStrict(join(home(), 'config.json'), {});
      const server = /^mcp__(.+?)__/.exec(input.tool_name)[1];
      const toolPart = String(input.tool_name).replace(/^mcp__.+?__/, '');
      const browserCall = isBrowser(server, toolPart);
      const pendingPath = join(home(), 'test-pending.json');
      if (!subagent && existsSync(pendingPath)) {
        const pending = readJsonStrict(pendingPath, null);
        const offServer = !!(run.active && run.session && pending && !testOnItsServer(pending, config));
        // The first new contact passes only while that person is still on the list to add, as listed: once their
        // record is saved they're off it, so a test pass left over from setup can't create them again.
        const firstContact = pending?.task === 'crm.create_contact' ? testContactItem(input.tool_input, pending, listed('contact-list.json'), nowMs) : null;
        if (!offServer && testPasses(input, pending, nowMs) && (pending.task !== 'crm.create_contact' || firstContact)) {
          unlinkSync(pendingPath);
          // The first new contact is a listed person: marked let through, as every later one is, so a lost answer
          // never leads to creating them twice.
          if (pending.task === 'crm.create_contact')
            for (const x of listed('contact-list.json').filter((x) => fold(x.email) === fold(pending.to))) {
              const mdir = join(home(), 'events', x._event, 'released');
              mkdirSync(mdir, { recursive: true, mode: 0o700 });
              try {
                markOnce(join(mdir, `crm-${promptId(x.id)}`), nowMs);
              } catch (e) {
                if (e.code !== 'EEXIST') throw e;
                process.stderr.write(
                  `floorboss blocked this call: ${promptPerson(x.name, x.id, x.email)} was already let through to your CRM once: run flow next, which looks them up first.\n`
                );
                process.exit(2);
              }
            }
          // A test call is a real write, and the file that allows it is one a session can write: the user is
          // asked every time, and the prompt shows what goes where.
          const args = leaves(input.tool_input || {})
            .map(([p, v]) => `${p}: ${String(v ?? '').slice(0, 300)}`)
            .join('\n')
            .slice(0, 1500);
          const what =
            {
              'email.send': 'TEST email',
              'chat.send': 'TEST chat message',
              stage_draft: 'TEST draft in your mailbox',
              'crm.create_task': 'TEST task in your CRM',
              'crm.create_contact': 'first new contact in your CRM'
            }[pending.task] || `TEST ${pending.task}`;
          ask(
            pending.task === 'crm.create_contact'
              ? `floorboss: the ${what}, for ${promptAddr(pending.to)}, via ${pending.server}/${pending.tool}, with:\n${args}\n\nAllow only if this is a person you agreed to add to your CRM.`
              : `floorboss: a ${what}${pending.to ? ` to ${pending.to}` : ''} via ${pending.server}/${pending.tool}, with:\n${args}\n\nAllow only if ${pending.to ? 'that is your own address or number and ' : ''}this is the test you agreed to.`
          );
          allow();
        }
      }
      // A subagent never gets a send, a task, a staged draft, a test call or a window (browser send, CRM log,
      // lookups): the user approves those in the main conversation, never inside an Agent call.
      const sendItems = subagent ? [] : listedSends();
      const browserSend = subagent ? null : openWindow(nowMs);
      const crmLog = browserSend || subagent ? null : openLogWindow(nowMs);
      const { hosts, pages } = knownEventSites();
      const asks = [];
      const sent = [];
      const typedNotes = [];
      const enrichPath = join(home(), 'enrich-window.json');
      const enrichWindow = !subagent && existsSync(enrichPath) ? readJsonStrict(enrichPath, null) : null;
      const enrichUsed = [];
      const tasks = [],
        contacts = [],
        staged = [];
      const why0 = check(input, {
        config,
        stageItems: subagent ? [] : listed('stage-list.json', nowMs),
        taskItems: subagent ? [] : listed('task-list.json'),
        contactItems: subagent ? [] : listed('contact-list.json'),
        sendItems,
        active: run,
        browserSend,
        crmLog,
        sent,
        enrichWindow,
        enrichUsed,
        hosts,
        pages,
        asks,
        tasks,
        contacts,
        staged
      });
      const why =
        why0 && subagent
          ? `${why0} (This call comes from a subagent: floorboss lets sends, tasks, drafts, lookups and browser windows happen only in the main conversation, where you approve them.)`
          : why0;
      if (why) {
        const vals = leaves(input.tool_input || {}).map(([, v]) => String(v ?? '').trim());
        const near = refusedSends.find((r) => vals.includes(r.to.trim()) && vals.includes(r.body.trim()));
        process.stderr.write(`floorboss blocked this call: ${near ? `the message to ${promptPerson(near.name, near.id)} can't go now: ${near.why}` : why}\n`);
        process.exit(2);
      }
      for (const a of asks) ask(a);
      // A CRM task: the user sees it whole, as with a send. The task it matched is noted for this call, so the
      // post hook marks that one (an approval given late, or the same text listed at two events, can't move it).
      if (tasks[0]?.key && tasks[0]._event && input.tool_use_id) {
        mkdirSync(join(home(), 'task-pending'), { recursive: true, mode: 0o700 });
        writeText(
          join(home(), 'task-pending', callNote(input.tool_use_id)),
          JSON.stringify({ key: tasks[0].key, event: tasks[0]._event, at: new Date(nowMs).toISOString() })
        );
      }
      for (const t of tasks)
        ask(
          `floorboss: create a task in your CRM via ${t.server}/${t.tool}${t.name ? `, about ${promptPerson(t.name, t.id)}` : ''}.\n\nThe task as floorboss listed it:\nTitle: ${promptLine(t.title)}\nContact: ${t.contact ? promptAddr(t.contact) : 'none'}\nDue: ${t.due || 'none'}\n\n${fullText(null, t.body)}\n\nAllow only if this is a task you want in your CRM.`
        );
      // A new CRM record: who goes in, field by field.
      // Each person is let through once: an exclusive marker per person (created or refused, never both), so a
      // create whose answer was lost isn't made twice; floorboss looks them up instead (contact-list's "released").
      for (const x of contacts) {
        const mdir = join(home(), 'events', x._event, 'released');
        mkdirSync(mdir, { recursive: true, mode: 0o700 });
        try {
          markOnce(join(mdir, `crm-${promptId(x.id)}`), nowMs);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          process.stderr.write(
            `floorboss blocked this call: ${promptPerson(x.name, x.id, x.email)} was already let through to your CRM once (the record may be there): run flow next: it looks them up by email before anything is created again.\n`
          );
          process.exit(2);
        }
      }
      for (const x of contacts)
        ask(
          `floorboss: add ${promptPerson(x.name, x.id, x.email)} to your CRM as a new contact via ${x.server}/${x.tool}, so their replies are filed on a record floorboss can read.\n\nName: ${promptLine(x.name)}\nEmail: ${promptAddr(x.email)}\nCompany: ${promptLine(x.company || 'none')}\nTitle: ${promptLine(x.title || 'none')}\n\nThe call, as it goes:\n${x.args.map(promptLine).join('\n').slice(0, 1200)}\n\nNothing is sent. Allow only if you want this person in your CRM.`
        );
      // Staged drafts: once per batch (one stage-list.json, as floorboss wrote it), with everyone in it. The
      // marker (stage-asked.json, a record Claude's Write can't touch) is written only by the PostToolUse hook,
      // once a draft of the batch went in after this prompt: until then every draft asks, so a "no" stops the
      // rest. This hook writes only stage-pending.json (the batch it asked about), which only that hook reads.
      for (const it of staged.slice(0, 1)) {
        const evDir = join(home(), 'events', it._event);
        const batch = stageBatch(evDir);
        const marker = readJsonStrict(join(evDir, 'stage-asked.json'), null);
        const key = `${fold(it.to)}|${it.id}|${it.touch ?? 1}`;
        // The batch's yes covers each draft once: a draft that already went in (the PostToolUse hook marks it once the
        // call ran) waits for its receipt. A call that failed or was declined marks nothing, so it can be tried again.
        if (marker?.batch === batch) {
          if (existsSync(join(evDir, 'released', `stage-${it.id}-${it.touch ?? 1}-${batch}`))) {
            process.stderr.write(
              `floorboss blocked this call: the draft to ${promptPerson(nameOfStaged(evDir, it), it.id)} already went into your drafts in this batch. If it's there, save its receipt (outreach staged); if it isn't, run stage-list again.\n`
            );
            process.exit(2);
          }
          continue;
        }
        const all = listed('stage-list.json', nowMs).filter((x) => x._event === it._event && !x._why);
        const nameOf = (x) => x.name || personName(evDir, x.id);
        const who = all
          .map((x) => `- ${promptPerson(nameOf(x), x.id, x.to)}`)
          .join('\n')
          .slice(0, 1500);
        const entries = eventRecord(evDir).entries;
        const history = all.flatMap((x) => holdHistory(entries, x.id, nameOf(x)));
        ask(
          `floorboss: put ${all.length} approved draft${all.length === 1 ? '' : 's'} in your mailbox's drafts folder via ${it.server}/${it.tool}. Nothing is sent: they wait there for you. This one is to ${promptPerson(nameOf(it), it.id, it.to)}. The batch:\n${who}\n\n${history.length ? `Held before:\n${history.join('\n')}\n\n` : ''}Allowing this lets the rest of this batch go into your drafts without asking again. If you decline, nothing is staged and floorboss asks again at the next draft.`
        );
        writeText(join(evDir, 'stage-pending.json'), JSON.stringify({ batch, first: key, at: new Date(nowMs).toISOString(), ...callId(input) }));
      }
      // A lookup let through: counted by the PostToolUse hook once it ran, against this window only (the
      // window's end, noted here, must still be the one in enrich-window.json then).
      // Each lookup let through leaves its own note (several at once are several), used by its own post. The
      // count is checked again under the lock as the note is written, so lookups started at once can't each see
      // the last free one.
      if (enrichUsed.length && enrichWindow) {
        const call = String(input?.tool_use_id || '');
        const over = withLock('enrich', () => {
          const w = readJsonStrict(join(home(), 'enrich-window.json'), null);
          if (!w || w.until !== enrichWindow.until) return 'the lookup window changed while this lookup was checked; run it again.';
          const notes = enrichNotes(w.until, nowMs);
          const used = windowUsed(w);
          // (A note this same call left already, from a pre hook run again, isn't another lookup.)
          const others = notes.filter((x) => !(call && x.call === call)).length;
          if (used + others >= windowAllowed(w)) return lookupsGone(windowAllowed(w), used, others);
          mkdirSync(enrichPendingDir(), { recursive: true, mode: 0o700 });
          writeText(
            join(enrichPendingDir(), callNote(call || `${input?.session_id || ''}:${nowMs}:${randomBytes(8).toString('hex')}`)),
            JSON.stringify({ until: w.until, at: new Date(nowMs).toISOString(), call })
          );
          return null;
        });
        if (over) {
          process.stderr.write(`floorboss blocked this call: ${over}\n`);
          process.exit(2);
        }
      }
      const meta = /^(action|coordinate|url|selector|ref|tabid|tab_id|element|uid|index|tab|start_coordinate)$/i;
      const action = String(input.tool_input?.action || '');
      const bt = bareBrowserTool(toolPart);
      const pressing = ['key', 'press_key', 'keyboard_press'].includes(bt) || action === 'key';
      const typing =
        !pressing &&
        (['type', 'fill', 'fill_form', 'form_input', 'keyboard_type', 'insert_text'].includes(bt) || action === 'type' || (!!crmLog && bt === 'select_option'));
      // What a call types: its value or text fields (Playwright's fill_form also names each field and its
      // type), else every value but the ones that only point at an element.
      const typed = () => {
        const all = leaves(input.tool_input || {}).map(([k, v]) => [k.split('.').pop().replace(/\[\]$/, ''), String(v ?? '')]);
        const vals = all.filter(([k]) => /^(value|values|text)$/i.test(k));
        return (vals.length ? vals : all.filter(([k]) => !meta.test(k))).map(([, v]) => v).filter((v) => v.trim());
      };
      const isUrlText = (t) => looksLikeUrl(t) || (!!readUrl(t)?.host && !/\s/.test(t.trim()));
      // A window lifts the run's "the browser only reads" rule for 20 minutes, and it opens on words the session
      // wrote. So its first browser call asks the user, naming what the window lets the browser do; the PostToolUse
      // hook marks the window as allowed only once that call ran. Until then every call in it asks.
      const win = browserSend ? { kind: 'send', w: browserSend } : crmLog ? { kind: 'log', w: crmLog } : null;
      if (win && browserCall) {
        const key = windowKey(win.kind, win.w);
        const marker = readJsonStrict(join(home(), 'window-asked.json'), null);
        if (marker?.key !== key) {
          const what =
            win.kind === 'send'
              ? `send your approved notes in ${[...new Set(browserItems(win.w.event).filter((x) => (win.w.ids || []).includes(`${x.id}:${x.touch}`)).map((x) => promptLine(x.where || 'the event app')))].join(' and ') || 'the event app or LinkedIn'} (${(win.w.ids || []).length || 'the listed'} people)`
              : `log your sent messages in your CRM's web app (${logItems(win.w.event).length} listed)`;
          ask(
            `floorboss: open a browser window until ${String(win.w.until).slice(11, 16)} UTC to ${what} for ${promptLine(win.w.event)}. In it the browser may click and type the listed people's details without asking again; each message's text still asks.\n\nAllow only if you asked floorboss to do this now.`
          );
          writeText(join(home(), 'window-pending.json'), JSON.stringify({ key, at: new Date(nowMs).toISOString(), ...callId(input) }));
        }
      }
      // In either browser window, only the keys KEY_OK allows (no paste; the one
      // shortcut is a modifier with Enter).
      if ((browserSend || crmLog) && browserCall && pressing) {
        const keys = typed().join(' ').split(/\s+/).filter(Boolean);
        if (keys.some((k) => !KEY_OK.test(k))) {
          process.stderr.write(
            `floorboss blocked this call: in the browser window only plain keys are pressed (Enter, Tab, arrows), not ${JSON.stringify(keys.join(' ').slice(0, 40))}.\n`
          );
          process.exit(2);
        }
      }
      // Inside the CRM log window, as strict as the send window: every value typed is a listed item's own
      // (its message, or its person's name, company, email, profile link, title, date or fill values), and
      // before a message's text goes into the page the user is asked, with the whole text.
      if (crmLog && browserCall && typing) {
        const texts = typed();
        const items = logItems(crmLog.event);
        const r = logTyping(texts, items, hosts);
        if (r.why) {
          process.stderr.write(`floorboss blocked this call: ${r.why}\n`);
          process.exit(2);
        }
        if (r.bodies.length) {
          const [hit] = r.bodies[0];
          const vouch = r.bodies.every(([it]) => it._approved)
            ? 'This is the text you approved.'
            : hit.received
              ? 'This is a reply floorboss read on the page, not a message of yours: check it is what they wrote.'
              : "floorboss can't match this text to a draft you approved (it was reported as sent, or the list was changed): check it is what you sent.";
          ask(
            `floorboss: the browser is about to type this into your CRM as a logged activity on the record of ${promptPerson(hit.name, hit.id, hit.to)}${/^\d{4}-\d{2}-\d{2}$/.test(String(hit.sent_on || '')) ? ` (${hit.sent_on})` : ''}. ${vouch}\n\n${r.bodies.every(([it]) => it._approved) ? 'The text you approved:' : 'The text it is typing:'}\n${fullText(null, r.bodies.map(([, t]) => t).join('\n\n'))}\n\nAllow only if this page is that person's record and this is the message to log.`
          );
        }
      }
      // Inside a browser send window: what is typed must be a listed note, exactly (whitespace and case aside),
      // and the user is asked, with the text actually typed; or a listed person's name or company (a search
      // box). Anything else is refused: the window is for the listed notes only.
      if (browserSend && browserCall && typing) {
        const texts = typed();
        const whyNot = noteWhy(browserSend, nowMs);
        const items = browserItems(browserSend.event).map((it) => {
          const r = whyNot(it);
          return { ...it, _why: r.why || null, hash: r.hash || null };
        });
        // Every value is checked before anything is asked; a typed link is text like any other (refused).
        const hits = [];
        for (const t of texts) {
          const same = !isUrlText(t) ? items.filter((it) => squash(t) === squash(it.body)) : [];
          const hit = same.find((it) => !it._why);
          if (hit) {
            hits.push([hit, t]);
            continue;
          }
          if (same.length) {
            process.stderr.write(`floorboss blocked this call: the note to ${promptPerson(same[0].name, same[0].id, same[0].to)} can't be typed: ${same[0]._why}.\n`);
            process.exit(2);
          }
          if (!isUrlText(t) && items.some((it) => !it._why && [it.name, it.company].some((x) => x && squash(t) === squash(x)))) continue;
          process.stderr.write(
            `floorboss blocked this call: the browser send window is for the listed notes only, typed exactly as listed (or a listed person's name, to find them), and ${JSON.stringify(t.slice(0, 80))} isn't one of them.\n`
          );
          process.exit(2);
        }
        if (hits.length > 1) {
          process.stderr.write('floorboss blocked this call: one listed note per call, so the prompt can name the person it goes to.\n');
          process.exit(2);
        }
        if (hits.length) {
          const [hit] = hits[0];
          for (const [it] of hits) typedNotes.push({ ...it, _event: browserSend.event });
          const before = eventRecord(join(home(), 'events', browserSend.event)).entries.filter((e) => e.id === hit.id && e.touch === hit.touch && e.type === 'send_released');
          ask(
            `floorboss: the browser is about to send the ${hit.touch > 1 ? `follow-up ${hit.touch - 1}` : 'note'} to ${promptPerson(hit.name, hit.id, hit.to)} in ${promptLine(hit.where || 'the event app')}.${letThroughBefore({ ...hit, _event: browserSend.event }, before)}\n\nThe text you approved, as it is typed:\n${fullText(null, texts.join('\n\n'))}\n\nAllow only if this page is that person's and this is the approved note.`
          );
        }
      }
      // Each approved send goes once: an exclusive marker per message (created or refused, never both), then
      // the release in the event's log before the call runs. Two calls at once can't both get through.
      // A browser note goes through the same: it is released when it is typed.
      for (const it of [...sent, ...typedNotes]) {
        const evDir = join(home(), 'events', it._event);
        const resets = eventRecord(evDir).entries.filter(
          (e) => e.id === it.id && e.touch === it.touch && ['release_cleared', 'bounced'].includes(e.type)
        ).length;
        const mdir = join(evDir, 'released');
        mkdirSync(mdir, { recursive: true, mode: 0o700 });
        try {
          closeSync(openSync(join(mdir, `${it.id}-${it.touch}-${resets}`), 'wx', 0o600));
        } catch (e) {
          if (e.code === 'EEXIST') {
            process.stderr.write(
              `floorboss blocked this call: the message to ${promptPerson(it.name, it.id)} was already let through once (it may have gone): check, then record it, or resend with the user's words.\n`
            );
            process.exit(2);
          }
          throw e;
        }
        // appendLine: starts on a fresh line after a torn one and syncs, so a release is never glued onto a broken line.
        // If the release can't be written, the marker goes too: the call is blocked, and nothing is held as sent.
        try {
          appendLine(
            join(evDir, 'ledger.jsonl'),
            `${JSON.stringify({ at: new Date(nowMs).toISOString(), type: 'send_released', who: 'guard', id: it.id, touch: it.touch, hash: it.hash || null, via: it.via, to: it.to, ...(it.where ? { where: it.where } : {}) })}\n`
          );
        } catch (e) {
          try {
            unlinkSync(join(mdir, `${it.id}-${it.touch}-${resets}`));
          } catch {
            /* gone */
          }
          throw e;
        }
      }
      // The one check floorboss's files can't fake: Claude Code asks the user before every send, even when the
      // tool is set to "always allow". Every file the checks above read is one a session could write, so the
      // record catches mistakes and drift, and the person at the prompt is the boundary. No send skips it.
      const it = sent[0];
      if (it) {
        // The address shown is the one the call carries, not the list's: what the user allows is what goes.
        const callTo = recipientShown(input.tool_input || {}, config.connectors?.[it.via], it.to);
        // A follow-up says when that person's replies were last checked, so a reply that came in since can be
        // caught at the click: floorboss can't close that gap itself.
        let checked = '';
        if (it.touch > 1) {
          let settings = {};
          try {
            settings = { ...loadEvent(it._event).settings, connectors: config.connectors || {} };
          } catch {
            /* the prompt still goes */
          }
          // The oldest of the checks this send needs (its own inbox and every other one they were written to).
          const at = oldestReplyCheck(it, { evDir: join(home(), 'events', it._event), settings, entries: eventRecord(join(home(), 'events', it._event)).entries });
          if (at) checked = ` Their replies were checked ${Math.max(0, Math.round((nowMs - at) / 1000))} seconds ago (the oldest check, of every inbox they were written to); if anything came in since, decline.`;
        }
        const name = it.name || personName(join(home(), 'events', it._event), it.id);
        const history = holdHistory(eventRecord(join(home(), 'events', it._event)).entries, it.id, name);
        const held = history.length ? ` Held before: ${history.join(' ')}` : '';
        // A message floorboss already let through once (then cleared to go again, on words the session wrote) says
        // so: the user is the one who can tell whether the first one went.
        const releases = eventRecord(join(home(), 'events', it._event)).entries.filter((e) => e.id === it.id && e.touch === it.touch && e.type === 'send_released');
        const again = letThroughBefore(it, releases.slice(0, -1));
        ask(
          `floorboss: send ${it.touch > 1 ? `follow-up ${it.touch - 1}` : it.touch === 0 ? 'the meeting confirmation' : 'the first message'} to ${promptPerson(name, it.id, callTo)} via ${it.via}.${again}${checked}${held}\n\nThe text you approved, as it goes:\n${fullText(it.subject, it.body)}\n\nAllow only if this is the approved message to the right person.`
        );
      }
      // An allowed call to a connector floorboss was given keeps its run open, so a long research step can't
      // outlast the lock. Blocked calls and calls to other servers don't touch it.
      if (run.active && givenServer(server, config, run)) stampRun({ session });
      allow();
    } catch (e) {
      process.stderr.write(
        `floorboss blocked this call: its guard couldn't check it (${String(e.message).slice(0, 120)}). This is for you, the user, to look at (the file it names, or the run lock at ${lockPath()}); Claude must not edit or delete floorboss's files to get past it.\n`
      );
      process.exit(2);
    }
  });
}
