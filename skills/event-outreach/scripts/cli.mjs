#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Draft: status paste-back, drafting jobs, checks, critic input and verdicts, the gate, the outbox.
import { run } from '../../../lib/args.mjs';
import { todo } from './commands/todo.mjs';
import { revise, briefs, redraft, batchCheck, saveDraft, saveDrafts } from './commands/drafting.mjs';
import { skipReview, criticInput, criticBatch, verdict, verdicts } from './commands/review.mjs';
import { openOutbox, render } from './commands/cards.mjs';
import { approveRound, gate } from './commands/approval.mjs';
import { appResult, sendFailed, sendOutcome, toolFailed, toolBack, sendList, sentReceipts, browserSendCmd, stageList, staged } from './commands/sending.mjs';
import { record, sync, syncList, status, summary } from './commands/outcomes.mjs';
import { logList, crmLogged, openLogWindow, crmLogResults, contactList, crmRecords, exportContacted } from './commands/crm-log.mjs';
import { taskList, tasksCreated, taskStatus } from './commands/tasks.mjs';
import { agendaDataCmd, agendaNews, agendaSave, agendaFacts, calendarBookings } from './commands/calendar.mjs';
import { rateSet, rate, voiceSave } from './commands/ratings.mjs';
import { authoriseUnattended, crmJudge, draftMissing } from './commands/unattended.mjs';
import { reportCmd } from './commands/report.mjs';
export { blockReason, sendingOn } from './commands/context.mjs';

run({
  report: reportCmd,
  'agenda-data': agendaDataCmd,
  'agenda-news': agendaNews,
  'agenda-save': agendaSave,
  'agenda-facts': agendaFacts,
  'log-list': logList,
  'crm-logged': crmLogged,
  'open-log-window': openLogWindow,
  'crm-log-results': crmLogResults,
  'app-result': appResult,
  'send-failed': sendFailed,
  'send-outcome': sendOutcome,
  'tool-failed': toolFailed,
  'tool-back': toolBack,
  'rate-set': rateSet,
  rate,
  'voice-save': voiceSave,
  record,
  revise,
  briefs,
  'send-list': sendList,
  sent: sentReceipts,
  'approve-round': approveRound,
  'browser-send': browserSendCmd,
  'skip-review': skipReview,
  sync,
  'sync-list': syncList,
  'task-list': taskList,
  'tasks-created': tasksCreated,
  'contact-list': contactList,
  'crm-records': crmRecords,
  'task-status': taskStatus,
  'calendar-bookings': calendarBookings,
  export: exportContacted,
  open: openOutbox,
  redraft,
  'stage-list': stageList,
  'authorise-unattended': authoriseUnattended,
  'crm-judge': crmJudge,
  'draft-missing': draftMissing,
  staged,
  'batch-check': batchCheck,
  status,
  todo,
  'save-draft': saveDraft,
  'save-drafts': saveDrafts,
  'critic-input': criticInput,
  'critic-batch': criticBatch,
  verdict,
  verdicts,
  render,
  gate,
  summary
});
