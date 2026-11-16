// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The one thing to do next, worked out from the home folder, the event's inputs and its ledger. Every step
// has exactly one action: run (a command), ask (a question, saved by `flow answer`), judge (Claude's own
// judgement written to a file, then a command), agent (a subagent with a pasted input), call (an MCP call the
// guard checks), or done. The command files are a loop around this.
import { setupSteps } from './steps/setup.mjs';
import { listSteps } from './steps/lists.mjs';
import { triageSteps } from './steps/triage.mjs';
import { researchSteps } from './steps/research.mjs';
import { replySteps } from './steps/replies.mjs';
import { draftSteps } from './steps/drafting.mjs';
import { approvalSteps } from './steps/approval.mjs';
import { sendSteps } from './steps/sending.mjs';
import { step } from './steps/shared.mjs';
import { unattendedSeenStep, unattendedOfferStep } from './steps/unattended.mjs';
export { ROOT, script, context } from './context.mjs';
export { followupsModeOf } from './steps/shared.mjs';
export { CRM_INDEPENDENT_WARNING, DISCLAIMER, helpFor, ANSWER_FORMAT } from './steps/wording.mjs';
export { earlierLine, failCounts, crmLayoutElsewhere, coworkerCounts, customerCounts, lostCounts, ratingsCarry, rewrittenSince } from './steps/counts.mjs';
export { otherChannelStep, appStep, noteUnsettled, appOutcomeTarget, askedChannels } from './steps/channels.mjs';

// An event whose dates or zone can't be read (lib/spacing.mjs eventDayState): nothing is drafted, staged or sent for it,
// as the guard, todo and the summary say, so the flow stops here with the reason rather than reading the dates.
function datesStep({ c }) {
  const e = c.event;
  if (e?.dayState?.state !== 'unreadable') return null;
  const why = `${e.event.name || e.event.slug}: ${e.dayState.why}. Nothing is drafted or sent for it until then; once the file is fixed, run /floorboss:start again.`;
  return step('done', why, { done: true, dates_unreadable: true, tell_user: why });
}

// The sales-rep path: a seller with a CRM export (or a connected CRM), an attendee list with emails, email
// sending with follow-ups. Each step says why it is next, in plain words.
export function nextStep(c) {
  // Each phase returns the step to do now, or nothing when everything it looks at is settled. They run in this
  // order and the first step returned is the answer. x carries c and what earlier phases worked out for later ones.
  const x = { c };
  // What floorboss did on its own since the user last looked comes first (it already happened: the user hears it before
  // anything else); then the disclaimer; then an event whose dates can't be read stops here, before setup or anything
  // else.
  const seen = unattendedSeenStep(x);
  if (seen) return seen;
  const setup = setupSteps(x);
  if (setup?.step === 'disclaimer') return setup;
  return (
    datesStep(x) ||
    setup ||
    listSteps(x) ||
    triageSteps(x) ||
    researchSteps(x) ||
    replySteps(x) ||
    draftSteps(x) ||
    approvalSteps(x) ||
    unattendedOfferStep(x) ||
    sendSteps(x)
  );
}
