// Runs the flow with a persona until it reaches a step (by id, or a test on the step), then stops before doing
// it, so a test can act there the way a user would.
import { drive } from '../sims/lib/driver.mjs';

export function untilStep(H, persona, want, { maxSteps = 220 } = {}) {
  const hit = typeof want === 'function' ? want : (s) => s.step === want;
  let found = null;
  const STOP = new Error('stop');
  try {
    const r = drive(H, persona, { maxSteps, onStep: (s) => { if (hit(s)) { found = s; throw STOP; } } });
    return { step: r.last.step, last: r.last, trail: r.trail };
  } catch (err) {
    if (err !== STOP) throw err;
    return { step: found.step, last: found, trail: [] };
  }
}
