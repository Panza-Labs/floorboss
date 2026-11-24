// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// floorboss's own scripts known by what they are on disk (device and inode), not by how a path is spelled (third
// review of audit run 11): a firmlink (/System/Volumes/Data/...), a symlinked parent folder, another letter case or
// extra slashes all name the same file. A path that doesn't exist falls back to its text.
import { statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { PLUGIN_ROOT } from '../plugin-root.mjs';
import { realPath } from '../../lib/paths.mjs';

const idOf = (p) => {
  try {
    const s = statSync(p);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
};
const ls = (d) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};
let INDEX = null;
// { root, areas: Set(id), scripts: Map(file id -> { rel, dir }) }, read once per guard run.
function index() {
  if (INDEX) return INDEX;
  const areas = new Set();
  const scripts = new Map();
  const add = (rel) => {
    const id = idOf(join(PLUGIN_ROOT, rel));
    if (id) scripts.set(id, { rel, dir: idOf(dirname(join(PLUGIN_ROOT, rel))) });
  };
  for (const d of ['lib', 'examples']) {
    const id = idOf(join(PLUGIN_ROOT, d));
    if (id) areas.add(id);
  }
  for (const s of ls(join(PLUGIN_ROOT, 'skills'))) {
    const dir = join(PLUGIN_ROOT, 'skills', s, 'scripts');
    const id = idOf(dir);
    if (!id) continue;
    areas.add(id);
    for (const f of ls(dir)) if (/^[\w-]+\.mjs$/.test(f)) add(`skills/${s}/scripts/${f}`);
  }
  add('examples/mock-event/load.mjs');
  add('scripts/unattended.mjs');
  INDEX = { root: idOf(PLUGIN_ROOT), areas, scripts };
  return INDEX;
}

// A word as a path: the plugin-root variable and ~ expanded, against base when relative.
export function wordPath(word, base) {
  const w = String(word ?? '')
    .replace(/^\$\{?CLAUDE_PLUGIN_ROOT\}?(?=\/|$)/, PLUGIN_ROOT)
    .replace(/^~(?=\/|$)/, homedir());
  return resolve(base || process.cwd(), w);
}

const FIRM = /^\/system\/volumes\/data(?=\/)/;
const lc = (t) => String(t).replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase().replace(FIRM, '');
const AREA_REL = /^(?:skills\/[^/]+\/scripts|lib|examples)(?:\/|$)/;

// Where a path is in the plugin: { script: rel or null (one of floorboss's scripts, in its own folder), area: true
// when it is in skills/*/scripts, lib or examples, or is one of the scripts by inode wherever it sits }.
export function locate(path) {
  const ix = index();
  const id = idOf(path);
  if (id) {
    const known = ix.scripts.get(id);
    if (known) return { script: known.dir && idOf(dirname(path)) === known.dir ? known.rel : null, area: AREA_REL.test(known.rel) };
    for (let p = dirname(path); ; p = dirname(p)) {
      const pid = idOf(p);
      if (pid && (ix.areas.has(pid))) return { script: null, area: true };
      if (pid && pid === ix.root) return { script: null, area: false };
      if (p === dirname(p)) break;
    }
    // Inside the plugin by identity only through a folder floorboss doesn't run scripts from.
  }
  // Not on disk (or not found inside the plugin by identity): its text, both the root and its real path.
  const t = lc(path);
  for (const r of new Set([lc(PLUGIN_ROOT), lc(realPath(PLUGIN_ROOT))])) {
    if (t === r || t.startsWith(r + '/')) {
      const rel = t.slice(r.length + 1);
      return { script: null, area: AREA_REL.test(rel) };
    }
  }
  return { script: null, area: false };
}
export const _sep = sep;
