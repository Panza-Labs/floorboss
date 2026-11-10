// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Small helpers the guard's rules share: reading a JSON file strictly, walking every value in a call's
// arguments, comparing text and addresses, and "how long ago".
import { readFileSync, existsSync } from 'node:fs';

const norm = (x) =>
  String(x || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// A file that's missing reads as the fallback; one that exists but can't be read stops the guard.
export function readJsonStrict(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Every leaf path in a value ("message.toRecipients[].emailAddress.address") with its value. Iterative and
// capped, so a deeply nested input can't crash the guard into letting a call through.
export function leaves(v) {
  const out = [];
  const stack = [[v, '', 0]];
  while (stack.length) {
    const [x, path, depth] = stack.pop();
    if (depth > 12) throw new Error('input nested too deep');
    if (out.length > 2000) throw new Error('input too large');
    if (Array.isArray(x)) x.forEach((y) => stack.push([y, `${path}[]`, depth + 1]));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) stack.push([y, path ? `${path}.${k}` : k, depth + 1]);
    else out.push([path, x]);
  }
  return out;
}
// Case folding for addresses: ASCII letters only, so a look-alike letter (the Kelvin sign for k) never
// compares equal to the real one.
export const fold = (v) =>
  String(v ?? '')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());

// Within `ms` before now, and not dated in the future (more than a minute ahead of floorboss's clock).
export function recent(at, nowMs, ms) {
  const t = Date.parse(at);
  return Number.isFinite(t) && nowMs - t < ms && t - nowMs <= 60000;
}
export const squash = (x) =>
  String(x ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
