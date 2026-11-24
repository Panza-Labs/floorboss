// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Company and people research starts with a heads-up (the company_briefs step, which names the companies and says "skip"
// stops it), not a question. These helpers run a persona to that heads-up, let the test say its words there the way the
// user would (flow answer --ask company_research), then run on to the end.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drive, cli } from '../sims/lib/driver.mjs';

export const isHeadsUp = (s) => s.step === 'company_briefs' && Array.isArray(s.accepts) && s.accepts.includes('company_research');

// What the user says at the heads-up: saved as the answer it accepts. Returns the flow's result (ERROR when asked again).
export function say(H, up, said, ask = 'company_research') {
  const f = join(H.HOME, 'work', `heads-up-${ask}.txt`);
  writeFileSync(f, said);
  return cli(H, 'flow', ['answer', '--event', up.event, '--ask', ask, '--value-file', f]);
}

// Runs the persona to the heads-up and stops there (before any researcher). { up, H }.
export function toHeadsUp(H, persona, opts = {}) {
  const STOP = new Error('heads-up');
  let up = null;
  try {
    drive(H, persona, { maxSteps: 200, ...opts, onStep: (s) => { if (isHeadsUp(s)) { up = s; throw STOP; } } });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  if (!up) throw new Error('the research heads-up was never reached');
  return up;
}

// Runs the persona to the heads-up, calls act(up) there, then on to the end. Returns the second part's { trail, last },
// the heads-up step, and every researcher's input that ran after the act (company briefs and people).
export function throughHeadsUp(H, persona, act, opts = {}) {
  const up = toHeadsUp(H, persona, opts);
  act(up);
  const ran = [];
  const run = drive(H, persona, { maxSteps: 200, ...opts, onStep: (s) => { if (s.agents) ran.push(...s.agents.filter((a) => /researcher/.test(a.name)).map((a) => ({ step: s.step, ...a.input }))); } });
  return { ...run, slug: up.event, up, ran, companiesResearched: ran.filter((r) => r.mode === 'company').map((r) => r.company), peopleResearched: ran.filter((r) => r.mode !== 'company' && r.name).map((r) => r.name) };
}
