// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Tiny argv parser: `sub --key value --flag`. Values can be read from files with --key-file.
import { readFileSync, existsSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { allowedPath, secureHome, home, expandHome, readChecked } from './paths.mjs';

export function parseArgs(argv) {
  // (a --x-file path is read only from floorboss's own folders: see allowedPath)
  const [sub, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[k] = true;
    else {
      opts[k] = next;
      i++;
    }
  }
  // --now <time> moves floorboss's clock: for its own tests and simulations only (FLOORBOSS_TEST=1). From a
  // session it could date a reply check or a send window into the future.
  // Checked before and after the -file values are read, so --now-file can't set it either.
  const nowGate = () => {
    if ((typeof opts.now === 'string' || 'now-file' in opts) && process.env.FLOORBOSS_TEST !== '1')
      throw new Error("--now is for floorboss's own tests only (FLOORBOSS_TEST=1); floorboss uses the real time.");
  };
  nowGate();
  for (const k of Object.keys(opts)) {
    // A tool's error text (on_error): Claude writes it to the file named, or has none when the tool never answered.
    // A missing file is that no-answer; the file is read once and removed, so an old error is never recorded again.
    // Only the step's own error file, <event>/work/tool-error.txt in floorboss's folder, is read and removed: any
    // other path is refused, so the option can never be used to delete a record or another file.
    if ((k === 'error-file' || k === 'page-says-file') && typeof opts[k] === 'string') {
      const base = k.slice(0, -5);
      const p = resolve(expandHome(opts[k]));
      const ok = p.startsWith(join(home(), 'events') + sep) && /[\\/]events[\\/][a-z0-9][a-z0-9-]*[\\/]work[\\/]tool-error\.txt$/.test(p);
      if (!ok) throw new Error(`--${k} is the step's own work/tool-error.txt in floorboss's folder, nothing else.`);
      if (opts[base] === undefined)
        opts[base] = existsSync(p) && !lstatSync(p).isSymbolicLink() ? readFileSync(p, 'utf8').slice(0, 4000) : 'no answer from the tool';
      try {
        if (existsSync(p) && !lstatSync(p).isSymbolicLink()) unlinkSync(p);
      } catch {
        /* not there */
      }
      continue;
    }
    if (k.endsWith('-file') && typeof opts[k] === 'string') {
      const base = k.slice(0, -5);
      if (opts[base] === undefined) {
        opts[base] = readChecked(allowedPath(opts[k]));
      }
    }
  }
  nowGate();
  return { sub, opts };
}

export async function run(handlers, argv = process.argv.slice(2)) {
  // Every floorboss script run refreshes the run lock (lib/runlock.mjs): until it's cleared or expires, the
  // guard hook limits the connectors floorboss was given to read-only tools and floorboss's recipes.
  // `run-end`, accepted by every floorboss script, clears it when a command finishes.
  const lock = await import('./runlock.mjs');
  if (argv[0] === 'run-end') {
    try {
      process.stdout.write(JSON.stringify(lock.clearRun(), null, 2) + '\n');
    } catch (err) {
      process.stderr.write(`floorboss: couldn't clear the run lock (${err.message}).\n`);
      process.exit(1);
    }
    return;
  }
  // Recording what the user says happened is bookkeeping, often outside any command: it doesn't start a run
  // (nothing reads untrusted text, and nothing would clear the lock afterwards).
  // Data folders made before floorboss set private permissions: tightened once (lib/paths.mjs secureHome).
  try {
    secureHome();
  } catch {
    /* best effort: a folder floorboss can't chmod still works */
  }
  const BOOKKEEPING = new Set(['record']);
  if (!BOOKKEEPING.has(argv[0])) {
    try {
      lock.stampRun();
    } catch {
      /* the stamp is best effort */
    }
  }
  let sub, opts;
  try {
    ({ sub, opts } = parseArgs(argv));
  } catch (err) {
    process.stderr.write(`floorboss: ${err.message}\n`);
    process.exit(1);
  }
  const h = handlers[sub];
  if (!h) {
    process.stderr.write(`Unknown command "${sub}". Use one of: ${Object.keys(handlers).join(', ')}\n`);
    process.exit(2);
  }
  try {
    const out = await h(opts);
    if (out !== undefined) process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out, null, 2)) + '\n');
  } catch (err) {
    process.stderr.write(`floorboss: ${err.message}\n`);
    process.exit(1);
  }
}

export function need(opts, ...keys) {
  for (const k of keys) if (opts[k] === undefined || opts[k] === true) throw new Error(`Missing --${k}.`);
}
