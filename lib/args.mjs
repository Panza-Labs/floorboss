// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Tiny argv parser: `sub --key value --flag`. Values can be read from files with --key-file.
import { readFileSync, existsSync, unlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, sep, basename, dirname } from 'node:path';
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
  // Asking what runs on its own changes nothing either: it doesn't hold up the next scheduled run.
  const BOOKKEEPING = new Set(['record', 'unattended-status']);
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
  let out;
  try {
    out = await h(opts);
  } catch (err) {
    // A command that wrote part of its work before failing: its page is kept in step too (said once).
    const page = await refreshPages(opts);
    const tell = page && !/outbox page could not be rebuilt/.test(err.message) ? `\n${page}` : '';
    process.stderr.write(`floorboss: ${err.message}${tell}\n`);
    process.exit(1);
  }
  const page = await refreshPages(opts);
  if (page) out = out && typeof out === 'object' && !Array.isArray(out) ? { ...out, outbox_not_rebuilt: page } : [out, page].filter((x) => x !== undefined).join('\n');
  if (out !== undefined) process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out, null, 2)) + '\n');
}

// After every command that wrote anything, the outbox page of each event the writes may touch is checked, and rebuilt
// when anything it is built from has changed (skills/event-outreach/scripts/commands/page-inputs.mjs): one place for
// every writer, so the page a user copies from never offers a message the ledgers no longer allow. A page reads its own
// event's record and files, the user's settings, and every other event's record, settings, lists and mappings (a send,
// an approval or a stop there changes who this page may offer), so a write there checks every page. The check reads
// the sizes and times of what each page was built from, and for a record that changed at another event what it lends
// the others (lib/lent.mjs); the rebuild happens only when something the page reads changed. A command that wrote
// nothing checks nothing. Only folders that are events (a valid name, an event.json) with a page are looked at.
// Returns what to tell the user when a page could not be rebuilt, else null.
async function refreshPages(opts) {
  const { ledgersWritten } = await import('./ledger.mjs');
  const { writtenFiles } = await import('./jsonio.mjs');
  const { home: homeDir, configPath } = await import('./paths.mjs');
  const wrote = ledgersWritten();
  const written = writtenFiles().map((f) => resolve(f));
  if (!wrote.length && !written.length) return null;
  const { NO_PAGE_EFFECT } = await import('../skills/event-outreach/scripts/commands/page-inputs.mjs');
  const root = resolve(homeDir());
  const events = join(root, 'events');
  const own = new Set();
  let every = false;
  // A line the page may read: every page is checked (another event's page finds it current unless what this record
  // lends the others changed).
  for (const { types } of wrote) if (types.some((t) => !NO_PAGE_EFFECT.has(t))) every = true;
  for (const p of written) {
    if (p === resolve(configPath())) every = true;
    else if (p.startsWith(events + sep)) {
      const [slug, ...rest] = p.slice(events.length + 1).split(sep);
      const r = rest.join('/');
      // Outputs (the derived files, the page and what it was built from) and working files no page reads.
      if (r === 'outbox.html' || r === 'report.html' || r === 'report.csv' || r.startsWith('mail/') || r.startsWith('released/') || (r.startsWith('derived/') && r !== 'derived/todo.json') || (r.startsWith('work/') && !r.startsWith('work/drafts/'))) continue;
      // What other events read of this one too.
      if (r === 'event.json' || r.startsWith('inputs/') || r.startsWith('sources/')) every = true;
      else own.add(slug);
    } else if (!p.startsWith(root + sep) || p.startsWith(join(root, 'context') + sep)) every = true;
  }
  if (!every && !own.size) return null;
  const pages = [];
  try {
    for (const slug of existsSync(events) ? readdirSync(events) : [])
      if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && existsSync(join(events, slug, 'event.json')) && existsSync(join(events, slug, 'outbox.html')) && (every || own.has(slug))) pages.push(slug);
  } catch {
    return null;
  }
  if (!pages.length) return null;
  try {
    const { refreshOutbox } = await import('../skills/event-outreach/scripts/commands/cards.mjs');
    const said = pages.map((s) => refreshOutbox(s, opts)?.not_rebuilt).filter(Boolean);
    return said.length ? said.join(' ') : null;
  } catch (e) {
    return `Saved, but the outbox pages could not be checked: ${e.message}`;
  }
}

export function need(opts, ...keys) {
  for (const k of keys) if (opts[k] === undefined || opts[k] === true) throw new Error(`Missing --${k}.`);
}
