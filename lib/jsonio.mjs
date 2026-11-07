// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Small file helpers: atomic JSON writes (tmp + rename) with private permissions.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  statSync,
  readSync,
  writeSync,
  unlinkSync,
  constants
} from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir, hardLinkRefusal, linkRefusal, readChecked } from './paths.mjs';

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readChecked(path, 64 * 1024 * 1024);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix or remove it; floorboss won't guess.`);
  }
}

export function writeJson(path, value) {
  writeText(path, JSON.stringify(value, null, 2) + '\n');
}

// Never through a link: one in the data folder anywhere on the way (the leaf or a folder), or one elsewhere
// that leads to keys or shell config (a script's own append followed a symlinked ledger out of the data folder).
export function refuseLinks(path) {
  const why = linkRefusal(path);
  if (why) throw new Error(why);
}

// text: a string or a Buffer (a copied list may be a spreadsheet).
export function writeText(path, text) {
  ensureDir(dirname(path));
  refuseLinks(path);
  const tmp = `${path}.tmp-${process.pid}`;
  // Created new (O_EXCL), so a link planted under the temporary name is never written through.
  try {
    unlinkSync(tmp);
  } catch {
    /* none left from a crash */
  }
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

// Append one line and fsync, so a crash right after can't lose it.
export function appendLine(path, line) {
  ensureDir(dirname(path));
  // An append goes into the file's contents, whatever its other names: never into one with a second name.
  {
    const why = hardLinkRefusal(path);
    if (why) throw new Error(why);
  }
  refuseLinks(path);
  // A crash mid-write can leave the last line without its newline: start on a fresh line, so this entry
  // isn't glued onto the broken one and lost with it.
  let lead = '';
  if (existsSync(path) && statSync(path).size > 0) {
    const fd0 = openSync(path, 'r');
    try {
      const b = Buffer.alloc(1);
      readSync(fd0, b, 0, 1, statSync(path).size - 1);
      if (b[0] !== 0x0a) lead = '\n';
    } finally {
      closeSync(fd0);
    }
  }
  // O_NOFOLLOW: a link at the leaf (planted after the check) is refused by the open itself.
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    writeSync(fd, lead + (line.endsWith('\n') ? line : line + '\n'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
