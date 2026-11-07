// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// floorboss's clock can be moved (FLOORBOSS_NOW) only under its own tests and simulations (FLOORBOSS_TEST=1).
// Anywhere else the variable is ignored: set in a session's environment, it could date a reply check, a send
// window or a pause into the future or the past.
export const movedNow = () => (process.env.FLOORBOSS_TEST === '1' && process.env.FLOORBOSS_NOW) || null;
export const nowMs = () => Date.parse(movedNow() || '') || Date.now();
