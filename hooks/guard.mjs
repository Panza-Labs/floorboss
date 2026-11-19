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
// First import: floorboss's own process, which reads settings as Claude Code does (lib/harness.mjs).
import '../lib/own-process.mjs';
import { existsSync, unlinkSync, openSync, closeSync, mkdirSync, writeFileSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { home, recordFile } from '../lib/paths.mjs';
import { readRun, readRunAnySession, stampRun, lockPath, endSession, touchSession, ranBefore } from '../lib/runlock.mjs';
import { bareBrowserTool, readUrl, looksLikeUrl } from '../lib/security.mjs';
import { eventRecord, oldestReplyCheck, eventDay, addressBusyToday, busyWhy } from '../lib/sendcheck.mjs';
import { readLedger } from '../lib/ledger.mjs';
import { withLock, withLocks } from '../lib/lock.mjs';
import { loadEvent } from '../lib/event.mjs';
import { randomBytes } from 'node:crypto';
import { appendLine, writeText } from '../lib/jsonio.mjs';
import { isMain } from '../lib/main.mjs';
import { nowMs as clockNow } from '../lib/clock.mjs';
import { readJsonStrict, fold, leaves, squash } from './guard/shared.mjs';
import { dayMarker, sendLocks, ownerOf, takeMarker, dropMarkers, dayResetsOf } from './guard/daymark.mjs';
// How long a draft's call into the mailbox counts as going in now: a second call for it in that time is refused.
const STAGE_IN_FLIGHT_MS = 30 * 1000;
// A send's lock per address is broken as stale only past this age: well over the guard's own deadline and Claude
// Code's hook timeout (30 seconds), so only a guard that died holding it loses it, never one still checking.
const SEND_LOCK_STALE_MS = 60 * 1000;
// What a call is told while another call holds a lock for one of the person's addresses (a lock left by a guard that
// died holds it until it is a minute old).
const SEND_BUSY = 'another call to this person, at this address or another of theirs, is being checked at this moment, or one stopped while it was: try again in a minute.';
import { isSubagent, inheritedRun, transcriptRanFloorboss, CHECKED_TOOLS, QUIET_TOOLS } from './guard/run.mjs';
import { ask, allow, allowUnattended, blockedSaid, promptId, promptPerson, promptAddr, promptLine, personName, holdHistory, letThroughBefore } from './guard/prompts.mjs';
import { isBrowser, givenServer } from './guard/connectors.mjs';
import { testOnItsServer, testContactItem, testPasses, markOnce, nameOfStaged } from './guard/test-calls.mjs';
import { callNote, enrichNotes, windowUsed, windowAllowed, lookupsGone, enrichPendingDir } from './guard/lookups.mjs';
import { listed, listedSends, refusedSends, fullText, stageBatch, recipientShown } from './guard/sends.mjs';
import { openWindow, openLogWindow, callId, windowKey, browserItems, logItems, KEY_OK, logTyping, noteWhy } from './guard/browser.mjs';
import { READ_TOOLS, WRITE_TOOLS, fileRefusal, runWriteRefusal, schedulePathRefusal } from './guard/files.mjs';
import { recordSearchHosts, WEB_TOOLS, webRefusal, knownEventSites, isResearcher, seenHosts, companyHosts } from './guard/web.mjs';
import { bashRefusal, floorbossScriptCall, connectorChange, scheduleRefusal, mcpScheduleRefusal, unattendedCall, shellWords } from './guard/shell.mjs';
import { check } from './guard/check.mjs';
import { afterCall, afterCallFailure, noteStageCall, hasCallId, NO_CALL_ID } from './guard/after-call.mjs';
import { sessionStart as unattendedStart, unattendedSession, unattendedMcp, bashCall as unattendedBash, afterBash, afterMcp as unattendedAfterMcp, afterMcpFailure as unattendedAfterMcpFailure, runToken, stopHere } from './guard/unattended.mjs';
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
export { floorbossScriptCall, bashRefusal, scheduleRefusal, mcpScheduleRefusal, plainlyReads, unattendedCall } from './guard/shell.mjs';
export { afterCall } from './guard/after-call.mjs';

// recordFile (the records only floorboss's scripts write) lives in lib/paths.mjs: script --out paths use it too.
export { recordFile };

// The floorboss script calls an unattended run makes, and no others: its flow's next step (--unattended), its run-end,
// and the CRM judgement the flow asks for.
const runStep = (call, command) =>
  (call.skill === 'flow' && ((call.sub === 'next' && shellWords(command).includes('--unattended')) || call.sub === 'run-end')) || (call.skill === 'event-outreach' && call.sub === 'crm-judge');

// Well inside the hook timeout in hooks.json (30 seconds), so a slow check ends blocked rather than timed out.
// Two things hold it: a timer, for a check that is waiting; and, because a timer can't fire while a check holds
// the thread, the clock is read again at the moment the guard answers, and an answer that comes after the
// deadline is a refusal whatever it would have been. A check that never returns at all relies on onFailure:
// "block" in hooks.json (Claude Code 2.1.295 or later; older versions let a timed-out call through).
export const GUARD_DEADLINE_MS = 20000;
// A send is checked against the deadline again just before its release is written, this much short of it, so the
// little left to do after the release can't carry the answer past the deadline (a refusal then would leave a release
// for a call that never ran).
const RELEASE_MARGIN_MS = 1000;
const TOO_LONG = 'its guard took too long to check it. Try again; if it keeps happening, this is for you, the user, to look at.';

if (isMain(import.meta.url)) {
  // A check that hangs while waiting blocks the call before Claude Code's own hook timeout (hooks.json) would.
  setTimeout(() => {
    process.stderr.write(`floorboss blocked this call: ${TOO_LONG}\n`);
    process.exit(2);
  }, GUARD_DEADLINE_MS).unref();
  // (The deadline is shorter only under floorboss's own tests.)
  const startedAt = Date.now();
  const testDeadline = process.env.FLOORBOSS_TEST === '1' ? Number(process.env.FLOORBOSS_GUARD_DEADLINE_MS) : NaN;
  const deadline = Number.isFinite(testDeadline) ? testDeadline : GUARD_DEADLINE_MS;
  // Whether a send's release would now come too close to the deadline (see RELEASE_MARGIN_MS).
  const late = () => Date.now() - startedAt >= Math.max(0, deadline - Math.min(RELEASE_MARGIN_MS, deadline));
  // Only a call that is being judged can be blocked: not what is recorded after a call ran, nor a session's start or end.
  let judging = process.argv[2] !== 'post' && process.argv[2] !== 'start' && process.argv[2] !== 'end';
  process.on('exit', (code) => {
    if (code !== 0 || !judging || Date.now() - startedAt <= deadline) return;
    try {
      writeSync(2, `floorboss blocked this call: ${TOO_LONG}\n`);
    } catch {
      /* the exit code says it */
    }
    process.exitCode = 2;
  });
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
    if (['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd'].includes(String(input?.hook_event_name || ''))) judging = false;
    const toolName = String(input?.tool_name || '');
    const session = typeof input?.session_id === 'string' ? input.session_id : null;
    // Inside a subagent (agent_id set), held to any live run lock: the docs don't say its session_id is the parent's.
    // Any agent_id that isn't empty counts, whatever its type (a number or an object is not the main session).
    const subagent = isSubagent(input);
    // In a ticketed unattended run, any refusal stops the run (design section 9.4: the first failure or unexpected result
    // ends it), whichever rule below refused: the run's stop mark is written as the guard exits, with what it said.
    if (judging && runToken()) {
      let said = '';
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => {
        said = String(chunk);
        return write(chunk, ...rest);
      };
      process.on('exit', (code) => {
        if (code !== 2 && process.exitCode !== 2) return;
        try {
          if (unattendedSession(input, clockNow(), subagent).ok) stopHere(session, String(blockedSaid.text || said || 'a call in the run was refused').replace(/^floorboss blocked this call: /, '').trim().slice(0, 300));
        } catch {
          /* refused either way */
        }
      });
    }
    // A call that failed after it was let through (PostToolUseFailure): in an unattended run, the guard notes it as
    // what it is (a read it couldn't read, a draft that may or may not be in), and the run stops. With the user there,
    // a staged draft's failed call is noted as one that may or may not have gone in (its call mark's .failed), so no
    // unattended draft of that step follows until the user says; nothing else is recorded: a failed call confirmed
    // nothing.
    if (input?.hook_event_name === 'PostToolUseFailure') {
      try {
        if (!subagent && /^mcp__/.test(toolName)) {
          if (runToken()) unattendedAfterMcpFailure(input, clockNow());
          else afterCallFailure(input, clockNow());
        }
      } catch {
        /* unattended: the run's next step finds the draft's result missing, and stops there */
      }
      process.exit(0);
    }
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
      // A floorboss script call that asked to turn unattended drafts on, to authorise follow-ups, or to let an unattended
      // draft that isn't in the drafts folder go in again: recorded only now, once it ran after the user allowed it
      // (hooks/guard/unattended.mjs).
      if (toolName === 'Bash') {
        try {
          if (!subagent) afterBash(input, clockNow());
        } catch {
          /* not recorded: nothing is turned on or authorised */
        }
        process.exit(0);
      }
      try {
        // In an unattended run, what the guard reads for itself in the answer (and the draft's result); else the usual.
        if (!subagent) {
          if (runToken()) unattendedAfterMcp(input, clockNow());
          else afterCall(input);
        }
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
      // A scheduled run's session: its ticket is bound only at a fresh startup of the session the launcher named.
      try {
        unattendedStart(input, clockNow());
      } catch {
        /* unbound: every call in it is refused */
      }
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
      // An unattended run uses floorboss's scripts and three connected-tool calls, nothing else.
      if (runToken() && !QUIET_TOOLS.has(toolName) && !(toolName === 'Skill' && /^floorboss:/.test(String(input.tool_input?.skill ?? input.tool_input?.name ?? '')))) {
        process.stderr.write(`floorboss blocked this call: an unattended run doesn't use ${toolName || 'this tool'}.\n`);
        process.exit(2);
      }
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
      if (runToken()) {
        process.stderr.write('floorboss blocked this call: an unattended run starts no agents.\n');
        process.exit(2);
      }
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
      if (runToken()) {
        process.stderr.write(`floorboss blocked this call: an unattended run runs only floorboss's own scripts.\n`);
        process.exit(2);
      }
      // What floorboss runs on its own is set up from the user's terminal only (scheduleRefusal), in any session.
      {
        let sched = null;
        try {
          sched = scheduleRefusal(input.tool_input?.command);
        } catch (e) {
          sched = `its guard couldn't check this command (${String(e.message).slice(0, 80)}).`;
        }
        if (sched) {
          process.stderr.write(`floorboss blocked this call: ${sched}\n`);
          process.exit(2);
        }
      }
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
        // Then, in any session: nothing that installs, loads, changes or switches on what floorboss runs on its own.
        why = bashRefusal(input.tool_input?.command) || scheduleRefusal(input.tool_input?.command);
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
      // In an unattended run: a ticketed session runs floorboss's own scripts only, and the scripts that turn unattended
      // drafts on or authorise follow-ups ask the user (hooks/guard/unattended.mjs).
      {
        const nowU = clockNow();
        const un = runToken() ? unattendedSession(input, nowU, subagent) : { on: false };
        // Turning unattended runs off (or looking at them) only reduces what can happen: allowed even here.
        if (un.on && !un.ok && !unattendedCall(input.tool_input?.command)) {
          process.stderr.write(`floorboss blocked this call: this unattended run can't go on: ${un.why}.\n`);
          process.exit(2);
        }
        if (un.on && !call && !unattendedCall(input.tool_input?.command)) {
          stopHere(session, 'a shell command that is not one of floorboss\'s scripts');
          process.stderr.write("floorboss blocked this call: an unattended run runs only floorboss's own scripts.\n");
          process.exit(2);
        }
        const mine = call && ((call.skill === 'connectors' && call.sub === 'unattended-on') || (call.skill === 'event-outreach' && ['authorise-unattended', 'crm-judge', 'draft-missing'].includes(call.sub)));
        if (mine || (un.on && call && ['unattended-on', 'authorise-unattended'].includes(call.sub))) {
          let u = null;
          try {
            u = unattendedBash(input, call, { config: readJsonStrict(join(home(), 'config.json'), {}), nowMs: nowU, un });
          } catch (e) {
            u = { refuse: `its guard couldn't check this call (${String(e?.message).slice(0, 120)}).` };
          }
          if (u?.refuse) {
            if (un.on && un.ok) stopHere(session, u.refuse);
            process.stderr.write(`floorboss blocked this call: ${u.refuse}\n`);
            process.exit(2);
          }
          if (u?.ask) ask(u.ask);
        }
        // And of floorboss's scripts, only the run's own steps: flow next --unattended, flow run-end and crm-judge.
        if (un.on && call && !runStep(call, input.tool_input?.command)) {
          process.stderr.write(`floorboss blocked this call: an unattended run runs only its own steps (flow next --unattended, flow run-end and crm-judge), not ${String(call.skill || 'this script').slice(0, 40)} ${String(call.sub || '').slice(0, 40)}.\n`);
          process.exit(2);
        }
      }
      // The session that ran floorboss (and any subagent while a run is live) has read text from lists, CRM
      // notes, pages and replies: there, a shell command other than floorboss's own scripts could send that text
      // anywhere, or rewrite floorboss's records. Refused until the session ends (/clear or a new session).
      // (Turning unattended runs off, or asking their status, is allowed there too: it only reduces what can happen.)
      if (!call && !unattendedCall(input.tool_input?.command)) {
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
        if (call && session && !['run-end', 'record', 'unattended-status'].includes(call.sub)) stampRun({ session, transcript: input.transcript_path });
      } catch {
        /* best effort */
      }
      allow();
    }
    try {
      if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
        const fileRun = subagent ? readRunAnySession(Date.now()) : readRun(Date.now(), session);
        // A ticketed unattended run writes its CRM judgement files only (and nothing at all unbound).
        let why = null;
        if (runToken() && WRITE_TOOLS.has(toolName)) {
          const un = unattendedSession(input, clockNow(), subagent);
          why = runWriteRefusal(toolName, input.tool_input, un.ok ? un.ticket : null);
        }
        why ||= fileRefusal(toolName, input.tool_input, fileRun);
        if (why) {
          process.stderr.write(`floorboss blocked this call: ${why}\n`);
          process.exit(2);
        }
        // The session that ran floorboss is still at work: its limits hold SESSION_LOCK_HOURS from now.
        if (fileRun.session) touchSession(session);
        process.exit(0);
      }
      if (WEB_TOOLS.has(toolName)) {
        if (runToken()) {
          process.stderr.write('floorboss blocked this call: an unattended run reads nothing on the web.\n');
          process.exit(2);
        }
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
      // A connected tool that runs commands or writes files (a terminal, a file-system server, a tool that types):
      // what floorboss runs on its own is still installed and switched on from the user's terminal only. One cheap
      // pass over the input (mcpScheduleRefusal); what it can't check, for a tool that isn't plainly a read, is refused.
      {
        const sched = mcpScheduleRefusal(String(toolName).replace(/^mcp__.+?__/, ''), input.tool_input, schedulePathRefusal);
        if (sched) {
          process.stderr.write(`floorboss blocked this call: ${sched}\n`);
          process.exit(2);
        }
      }
      const nowMs = clockNow();
      const run = subagent ? { ...readRunAnySession(Date.now()), subagent: true } : readRun(Date.now(), session);
      const config = readJsonStrict(join(home(), 'config.json'), {});
      const server = /^mcp__(.+?)__/.exec(input.tool_name)[1];
      const toolPart = String(input.tool_name).replace(/^mcp__.+?__/, '');
      const browserCall = isBrowser(server, toolPart);
      // An unattended run (a token in this Claude Code process's environment): its own rules, and the one "allow" floorboss
      // gives. A call that fails them is refused and the run stops; nothing here ever asks.
      if (runToken()) {
        let out;
        try {
          out = unattendedMcp(input, { config, run, nowMs, subagent });
        } catch (e) {
          out = { refuse: `its guard couldn't check this call (${String(e?.message).slice(0, 120)})` };
          try {
            stopHere(session, out.refuse);
          } catch {
            /* refused either way */
          }
        }
        if (!out?.allow) {
          process.stderr.write(`floorboss blocked this call: ${out?.refuse || 'an unattended run could not check it'}\n`);
          process.exit(2);
        }
        allowUnattended(out.allow);
      }
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
        // Each draft call is noted by Claude Code's id for it, so its post hook marks that call's own mark however late
        // its prompt is answered, and a failed one as maybe in: a call with no id is refused.
        if (!hasCallId(input)) {
          process.stderr.write(`floorboss blocked this call: ${NO_CALL_ID}.\n`);
          process.exit(2);
        }
        const evDir = join(home(), 'events', it._event);
        const batch = stageBatch(evDir);
        const marker = readJsonStrict(join(evDir, 'stage-asked.json'), null);
        const key = `${fold(it.to)}|${it.id}|${it.touch ?? 1}`;
        // One draft per person per step in a batch, even with calls at the same moment: each call takes the next
        // numbered marker for that draft with wx (stage-call-<id>-<touch>-<batch>-<n>), and a call is refused while the
        // one before it is under STAGE_IN_FLIGHT_MS old (it may be going in now, or it was declined or failed: the guard
        // can't tell). After that it can be tried again; one that went in is marked by the PostToolUse hook and refused
        // below for the whole batch.
        mkdirSync(join(evDir, 'released'), { recursive: true, mode: 0o700 });
        const wentIn = marker?.batch === batch && existsSync(join(evDir, 'released', `stage-${it.id}-${it.touch ?? 1}-${batch}`));
        const callMark = (n) => join(evDir, 'released', `stage-call-${it.id}-${it.touch ?? 1}-${batch}-${n}`);
        let inFlight = false;
        const takeCallMark = () => {
          let n = 0;
          while (existsSync(callMark(n + 1))) n++;
          if (n > 0) {
            const was = Date.parse(readFileSync(callMark(n), 'utf8'));
            // Done once the PostToolUse hook saw that call run (it writes <marker>.done).
            inFlight = !existsSync(`${callMark(n)}.done`) && (!Number.isFinite(was) || nowMs - was < STAGE_IN_FLIGHT_MS);
          }
          if (!inFlight && !wentIn) {
            try {
              writeFileSync(callMark(n + 1), new Date(nowMs).toISOString(), { flag: 'wx', mode: 0o600 });
            } catch (e) {
              if (e.code !== 'EEXIST') throw e;
              inFlight = true;
            }
            // Noted for this call, so its post hook marks this mark done however late its prompt is answered, also once the
            // list is out of date or written again (hooks/guard/after-call.mjs).
            if (!inFlight) noteStageCall(String(input.tool_use_id), { event: it._event, id: it.id, touch: it.touch ?? 1, mark: `stage-call-${it.id}-${it.touch ?? 1}-${batch}-${n + 1}` }, nowMs);
          }
        };
        // One message a day to a person across all your events, for a draft too: checked again under the send locks for
        // the person's addresses (hooks/guard/daymark.mjs sendLocks), so a send at another event that is between its
        // check and its release is waited for and counted. (A draft writes no release: one staged here holds nothing at
        // another event. You send it yourself.) The step itself is read again under them too, and its call mark is taken
        // under them: an unattended draft of the same step takes the same locks, writes its release under them and reads
        // the call marks under them (hooks/guard/unattended.mjs), so of the two only one gets through.
        if ((it.touch ?? 1) !== 0) {
          let why = null;
          try {
            why = withLocks(
              sendLocks(evDir, it.id, it.to),
              () => {
                const busy = addressBusyToday(evDir, it.to, nowMs, it.id);
                if (busy) return busyWhy(busy, promptPerson(nameOfStaged(evDir, it), it.id), it.to);
                const x = eventRecord(evDir).folded?.people?.[it.id]?.touches?.[it.touch ?? 1];
                if (x?.sent) return 'it was already sent';
                if (x?.staged) return 'its draft is already in your drafts';
                if (x?.stage_released) return 'its draft already went into your drafts on its own (an unattended run): check your drafts folder';
                takeCallMark();
                return null;
              },
              { staleMs: SEND_LOCK_STALE_MS }
            );
          } catch (e) {
            if (/^another floorboss process is busy with send-/.test(String(e?.message))) why = SEND_BUSY;
            else throw e;
          }
          if (why) {
            process.stderr.write(`floorboss blocked this call: the draft can't go into your drafts now: ${why}\n`);
            process.exit(2);
          }
        } else takeCallMark();
        if (inFlight && !wentIn) {
          process.stderr.write(
            `floorboss blocked this call: a call to put the draft to ${promptPerson(nameOfStaged(evDir, it), it.id)} in your drafts started under ${STAGE_IN_FLIGHT_MS / 1000} seconds ago (it may still be going in, or it was declined or failed). If the draft is there, save its receipt (outreach staged); if not, try again after ${STAGE_IN_FLIGHT_MS / 1000} seconds.\n`
          );
          process.exit(2);
        }
        // The batch's yes covers each draft once: a draft that already went in (the PostToolUse hook marks it once the
        // call ran) waits for its receipt. A call that failed or was declined is never marked as gone in, so it can be
        // tried again once STAGE_IN_FLIGHT_MS has passed since it started.
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
      // The one check floorboss's files can't fake: Claude Code asks the user before every send, even when the
      // tool is set to "always allow". Every file the checks above read is one a session could write, so the
      // record catches mistakes and drift, and the person at the prompt is the boundary. No send skips it.
      // (The prompt is put together before the release below, so nothing that can fail or take time comes after it.)
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
        // so: the user is the one who can tell whether the first one went. (Its release for this call isn't written yet.)
        const releases = eventRecord(join(home(), 'events', it._event)).entries.filter((e) => e.id === it.id && e.touch === it.touch && e.type === 'send_released');
        const again = letThroughBefore(it, releases);
        ask(
          `floorboss: send ${it.touch > 1 ? `follow-up ${it.touch - 1}` : it.touch === 0 ? 'the meeting confirmation' : 'the first message'} to ${promptPerson(name, it.id, callTo)} via ${it.via}.${again}${checked}${held}\n\nThe text you approved, as it goes:\n${fullText(it.subject, it.body)}\n\nAllow only if this is the approved message to the right person.`
        );
      }
      // An allowed call to a connector floorboss was given keeps its run open, so a long research step can't
      // outlast the lock. Calls blocked before this point and calls to other servers don't touch it. (Stamped before
      // the release below, so nothing that can fail comes after a release.)
      if (run.active && givenServer(server, config, run)) stampRun({ session });
      // Each approved send goes once: an exclusive marker per message (created or refused, never both), then the
      // release in the event's log before the call runs. Two calls at once can't both get through. A browser note goes
      // through the same: it is released when it is typed. The release is the last thing written before the answer.
      for (const it of [...sent, ...typedNotes]) {
        const evDir = join(home(), 'events', it._event);
        // (One day rule with the unattended draft: hooks/guard/daymark.mjs DAY_RESETS.)
        const resets = dayResetsOf(eventRecord(evDir).entries, it.id, it.touch);
        const mdir = join(evDir, 'released');
        mkdirSync(mdir, { recursive: true, mode: 0o700 });
        const own = join(mdir, `${it.id}-${it.touch}-${resets}`);
        try {
          closeSync(openSync(own, 'wx', 0o600));
        } catch (e) {
          if (e.code === 'EEXIST') {
            process.stderr.write(
              `floorboss blocked this call: the message to ${promptPerson(it.name, it.id)} was already let through once (it may have gone): check, then record it, or resend with the user's words.\n`
            );
            process.exit(2);
          }
          throw e;
        }
        // Every marker this call takes is given back if anything after this fails or refuses, so a call that wrote no
        // release leaves nothing that holds this message or this person on a later day.
        const took = [own];
        let refusal = null;
        try {
          // One message a day to a person across all your events, and at this event (in its time): the check of every
          // event's ledger is made again under a lock for the address this message goes to and each address the person
          // has alone here (taken in one sorted order), and the person's day marker and the release are taken under them
          // too, so two calls at the same moment can't both pass, whatever their events' zones, and whichever of the
          // person's addresses each goes to when their two events share one (lib/sendcheck.mjs addressBusyToday;
          // hooks/guard/daymark.mjs sendLocks). A lock is never broken while a live guard holds it: a
          // guard answers within its deadline, far under SEND_LOCK_STALE_MS. A meeting confirmation (touch 0) answers
          // the person's own booking and takes no day (lib/sendcheck.mjs says why).
          refusal = withLocks(
            sendLocks(evDir, it.id, it.to),
            ({ owned }) => {
              if (late()) return 'late';
              // This step read again under the lock: when another call for the same message was let through since this
              // call's marker was taken (a resend or "it didn't go" recorded while that call was still going), this one
              // is refused, so that message isn't let through a second time.
              {
                const mineNow = readLedger(join(evDir, 'ledger.jsonl')).entries.filter(
                  (e) => e.id === it.id && e.touch === it.touch && ['send_released', 'release_cleared', 'bounced'].includes(e.type)
                );
                if (mineNow[mineNow.length - 1]?.type === 'send_released')
                  return `the message to ${promptPerson(it.name, it.id)} was let through a moment ago by another call (it may have gone): check, then record it, or resend with the user's words.`;
              }
              if (it.touch !== 0) {
                const busy = addressBusyToday(evDir, it.to, nowMs, it.id);
                if (busy) return `${busyWhy(busy, promptPerson(it.name, it.id), it.to)}. One message a day to one person, across all your events.`;
                const day = eventDay(evDir, nowMs) || new Date(nowMs).toISOString().slice(0, 10);
                const cleared = (o) => dayResetsOf(eventRecord(join(home(), 'events', o.slug)).entries, o.id, o.touch);
                const got = takeMarker(dayMarker(evDir, it, day), ownerOf(it._event, it, resets), cleared);
                if (!got) return `another message to ${promptPerson(it.name, it.id)} already went or is going today. One message a day to one person.`;
                took.push(got);
              }
              // (Under floorboss's own tests only: the lock is held a moment here, between the check and the release, so a
              // test can show that a second call at the same moment waits for it and is refused.)
              const hold = process.env.FLOORBOSS_TEST === '1' ? Number(process.env.FLOORBOSS_SEND_HOLD_MS) : 0;
              if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(hold, 3000));
              // An answer after the deadline is a refusal: checked again just before the release, so a send refused for
              // time leaves no release and no marker, and trying again works.
              if (late()) return 'late';
              // And every lock must still be this call's (lib/lock.mjs: a lock broken as stale under it is never given back).
              if (!owned()) return 'busy';
              // appendLine: starts on a fresh line after a torn one and syncs, so a release is never glued onto a
              // broken line. If it can't be written, the markers go (below): the call is blocked, and nothing is held.
              appendLine(
                join(evDir, 'ledger.jsonl'),
                `${JSON.stringify({ at: new Date(nowMs).toISOString(), type: 'send_released', who: 'guard', id: it.id, touch: it.touch, hash: it.hash || null, via: it.via, to: it.to, ...(it.where ? { where: it.where } : {}) })}\n`
              );
              return null;
            },
            { staleMs: SEND_LOCK_STALE_MS }
          );
        } catch (e) {
          dropMarkers(took);
          if (/^another floorboss process is busy with send-/.test(String(e?.message))) refusal = 'busy';
          else throw e;
        }
        if (refusal) {
          dropMarkers(took);
          process.stderr.write(`floorboss blocked this call: ${refusal === 'late' ? TOO_LONG : refusal === 'busy' ? SEND_BUSY : refusal}\n`);
          process.exit(2);
        }
      }
      allow();
    } catch (e) {
      process.stderr.write(
        `floorboss blocked this call: its guard couldn't check it (${String(e.message).slice(0, 120)}). This is for you, the user, to look at (the file it names, or the run lock at ${lockPath()}); Claude must not edit or delete floorboss's files to get past it.\n`
      );
      process.exit(2);
    }
  });
}
