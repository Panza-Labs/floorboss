// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Claude's own file tools (Read, Grep, Glob, Write, Edit, MultiEdit, NotebookEdit): no read of keys or
// credentials, no write to floorboss's records, and during a run no write outside the data and temp folders.
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { home, sensitiveKind, secretPlace, realPath, linkRefusal, recordFile, hardLinkRefusal, followed } from '../../lib/paths.mjs';
import { SECRET_NAME, SECRET_SEARCH } from '../../lib/security.mjs';
import { PLUGIN_ROOT } from '../plugin-root.mjs';
import { lockNote } from './run.mjs';
import { LABEL_PREFIX } from '../../lib/unattended.mjs';

// Claude's own file tools (Read, Grep, Glob, Write, Edit, NotebookEdit).
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const expand = (p) => resolve(String(p).replace(/^~(?=$|\/)/, homedir()));
const inside = (p, root) => {
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};
// A glob as the screens read it: each brace alternative spelled out ("~/.s{s,x}h" is "~/.ssh" and "~/.sxh"),
// and every other wildcard ("?", "[…]", braces past 64 spellings) read as "*". A name screen cut at the first
// wildcard missed "~/.s{s,}h/*" and "**/.s?h/*".
export function globForms(g) {
  let out = [String(g ?? '')];
  for (let i = 0; i < 8 && out.some((s) => /\{[^{}]*\}/.test(s)); i++) {
    out = out.flatMap((s) => {
      const m = /\{([^{}]*)\}/.exec(s);
      return m ? m[1].split(',').map((alt) => s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)) : [s];
    });
    if (out.length > 64) {
      out = out.slice(0, 64).map((s) => s.replace(/\{[^}]*\}?/g, '*'));
      break;
    }
  }
  return [
    ...new Set(
      out.map((s) =>
        s
          .replace(/\{[^}]*\}?/g, '*')
          .replace(/\[[^\]]*\]?/g, '*')
          .replace(/\?/g, '*')
          .replace(/\*{3,}/g, '**')
      )
    )
  ];
}
// Key and credential files by name, under the home folder: a glob that would match one of these (with at
// least two plain letters in it, so "**/*" in a project isn't read as a search for keys) is one. Only names
// that say what they hold: a "config.json" search isn't a key search (SECRET_SEARCH still names .docker).
const SECRET_SAMPLES = [
  '.ssh',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.aws/credentials',
  '.gnupg/secring.gpg',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.vault-token',
  '.config/gcloud/credentials.db',
  '.zsh_history',
  '.bash_history',
  '.env',
  'project/.env',
  'Library/Keychains/login.keychain-db',
  'Library/Cookies/Cookies.binarycookies',
  'Library/Application Support/Google/Chrome/Default/Login Data',
  'certs/server.pem',
  'keys/id_rsa'
];
const globRe = (p) =>
  p
    .split(/(\*\*\/|\*\*|\*)/)
    .map((x) => (x === '**/' ? '(?:.*/)?' : x === '**' ? '.*' : x === '*' ? '[^/]*' : x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
export function globSeeksSecrets(g) {
  const hh = homedir();
  return globForms(g).some((f) => {
    if (SECRET_SEARCH.test(f)) return true;
    let p = f.replace(/^~(?=\/|$)/, hh);
    const anchored = p === hh || p.startsWith(`${hh}/`);
    p = anchored ? p.slice(hh.length + 1) : p.replace(/^\/+/, '');
    if (p.replace(/[*/]/g, '').length < 2) return false;
    const re = new RegExp(`${anchored ? '^' : '(^|/)'}${globRe(p)}$`, 'i');
    return SECRET_SAMPLES.some((s) => re.test(s) || re.test(`${hh.slice(1)}/${s}`));
  });
}
// The paths a file tool call names (Glob's pattern only when it is an absolute or ~ path, once per spelling,
// up to its first wildcard).
function pathsOf(tool, input) {
  const i = input || {};
  const out = [i.file_path, i.notebook_path, i.path].filter((x) => typeof x === 'string' && x.trim());
  if (tool === 'Glob' && typeof i.pattern === 'string' && /^(~|\/)/.test(i.pattern))
    for (const f of globForms(i.pattern)) out.push(f.replace(/\*.*$/, '') || '/');
  return out.map(expand);
}
// SECRET_NAME (key folders, never written) and SECRET_SEARCH (a search by name for keys and tokens) live in
// lib/security.mjs: crm-triage's list files are screened by the same names.
// Grep that prints matching lines (output_mode "content") over the home folder, a folder above it, or
// ~/Library prints keys and tokens wherever they sit: refused, run or not. Naming the files that match (the
// default, files_with_matches) or counting them per file is refused there too: the names alone say which
// files hold a key ("grep AKIA" over the home folder lists them).
const libraryDir = () => join(homedir(), 'Library');
function grepContentRefusal(input, mine = false) {
  const mode = String(input?.output_mode || 'files_with_matches');
  if (!['content', 'files_with_matches', 'count'].includes(mode))
    return mine ? `"${mode.slice(0, 30)}" isn't a search mode floorboss knows, and a floorboss run is under way.` : null;
  const where = typeof input?.path === 'string' && input.path.trim() ? expand(input.path) : process.cwd();
  const rp = realPath(where);
  // While floorboss runs in this session, a search that prints lines runs only over floorboss's data folder:
  // anywhere else it could print a key or credential file (a project's .env, a
  // .docker folder) that Read is refused, and no list of names or file types matches ripgrep's own. Listing the
  // files that match, then reading them, still works: Read refuses those files.
  if (mode === 'content' && mine && !inside(rp, realPath(home())))
    return `a search that prints matching lines over ${where} could print a key or credential file, and a floorboss run is under way: search floorboss's data folder, or list the files that match (output_mode "files_with_matches") and read the ones you need.`;
  if (inside(realPath(homedir()), rp) || inside(rp, realPath(libraryDir())))
    return mode === 'content'
      ? `a search that prints matching lines over ${where} would print keys and credentials, and floorboss never lets Claude read those: search inside a project folder.`
      : `a search that lists the files matching it over ${where} would say which files hold keys and credentials, and floorboss never lets Claude look for those: search inside a project folder.`;
  return null;
}
// A launchd job's file for floorboss: one named for it, or one whose text names its job, its launcher or its
// install script, in a folder launchd loads from. Only the user's own terminal writes that (scripts/unattended.mjs).
const LAUNCHD_DIRS = () => [join(homedir(), 'Library', 'LaunchAgents'), '/Library/LaunchAgents', '/Library/LaunchDaemons'];
// Text that names floorboss's job, a scheduled.mjs or unattended.mjs by file name, or anything in this plugin's
// folder. It is not parsed as a property list. The text is decoded the way Apple's reader decodes a string (XML
// character references with any number of leading zeros, the five named entities, CDATA markers taken out) and
// read twice, with "<!-- … -->" taken out and with it left in, since whether that is a comment depends on where
// it stands. The names are looked for in each reading as it is and again with paths made plain ("//", "/./" and
// up to 40 rounds of "x/../"). Only the first 256 KB are read (a launchd file is far smaller); a longer text is
// refused unread. The old (OpenStep) format's own escapes are not decoded.
const CONTENT_CAP = 256 * 1024;
const ref = (n) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
// Decoded as Apple's reader decodes a string: CDATA markers out, character references and the five named entities
// read, lower case, "\" as "/". With dropComments, comments are taken out first, in one walk (an unclosed one takes
// the rest with it).
function decodedXml(t, dropComments) {
  let s = String(t ?? '').slice(0, CONTENT_CAP);
  if (dropComments && s.includes('<!--')) {
    const kept = [];
    for (let at = 0; ; ) {
      const a = s.indexOf('<!--', at);
      if (a < 0) {
        kept.push(s.slice(at));
        break;
      }
      kept.push(s.slice(at, a));
      const b = s.indexOf('-->', a + 4);
      if (b < 0) break;
      at = b + 3;
    }
    s = kept.join('');
  }
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&#x0*([0-9a-f]{1,6});/gi, (_, h) => ref(parseInt(h, 16)))
    .replace(/&#0*([0-9]{1,7});/g, (_, d) => ref(Number(d)))
    .replace(/&(quot|apos|lt|gt);/g, (_, n) => ({ quot: '"', apos: "'", lt: '<', gt: '>' })[n])
    .replace(/&amp;/g, '&')
    .toLowerCase()
    .replace(/\\/g, '/');
}
function plainPaths(d) {
  let s = d.replace(/\/(\.\/)+/g, '/').replace(/\/{2,}/g, '/');
  for (let n = 0; n < 40 && s.includes('/../'); n++) {
    const t = s.replace(/(?<![^/\s<>"'])(?!\.\.?\/)[^/\s<>"']+\/\.\.\//g, '');
    if (t === s) break;
    s = t;
  }
  return s;
}
export function plainXml(t) {
  return plainPaths(decodedXml(t, true));
}
// The job's name, or either script by its file name (not the tail of a longer file name).
const hit = (s) => s.includes(LABEL_PREFIX) || /(?<![\w.-])(scheduled|unattended)\.mjs/.test(s);
// The plugin's folder as a whole path: not the tail of a longer path before it, and a "/" or the end of the name
// after it (a folder beside it whose name only starts the same way is another folder).
const inPlugin = (text, root) => {
  for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + root.length] ?? '';
    if (!/[\w.~-]/.test(before) && !/[\w.-]/.test(after)) return true;
  }
  return false;
};
const names = (t) => {
  if (String(t ?? '').length > CONTENT_CAP) return true;
  const roots = [...new Set([PLUGIN_ROOT, realPath(PLUGIN_ROOT)])].map((r) => r.toLowerCase());
  // Read both ways: with comments taken out, and with them left in (a "<!--" inside CDATA, a processing instruction
  // or an attribute is text to Apple's reader, not the start of a comment). Names are looked for before paths are
  // made plain as well as after: taking "x/../" out must never take a name out with it.
  for (const drop of [false, true]) {
    const d = decodedXml(t, drop);
    if (hit(d)) return true;
    const p = plainPaths(d);
    if (hit(p) || roots.some((r) => inPlugin(p, r))) return true;
  }
  return false;
};
const launchdDirs = () =>
  LAUNCHD_DIRS()
    .flatMap((d) => [d, realPath(d)])
    .map((d) => d.toLowerCase());
const inLaunchdDir = (spots) => {
  const dirs = launchdDirs();
  return spots.some((x) => dirs.some((d) => x.startsWith(d + sep)));
};
// Everywhere a path may lead: as written, with links followed as far as it exists, and through a link whose
// target isn't there yet. Lower case: the disk doesn't tell "LaunchAgents" from "launchagents".
const spotsOf = (p) => {
  let lands = null;
  try {
    lands = followed(p).to;
  } catch {
    lands = null;
  }
  return [resolve(p), realPath(p), lands].filter(Boolean).map((x) => x.toLowerCase());
};
// A path a connected tool (MCP) that isn't plainly a read was given: floorboss's launchd file, or one of
// floorboss's own records (the unattended folder and today.html among them; recordFile, lib/paths.mjs). Those are
// written only by floorboss's own scripts. Claude's own file tools are held by fileRefusal. The caller hands over
// at most 50 short strings (hooks/guard/shell.mjs, gather).
// text: everything else the call carries (what would be written), read by the same content rule as Write's.
export function schedulePathRefusal(value, text = '') {
  const v = String(value ?? '');
  if (!v || v.length > 1024 || !/^(~|\/|\.{1,2}\/)|\//.test(v) || /[\n\r]/.test(v)) return null;
  const p = expand(v);
  let spots;
  try {
    spots = spotsOf(p);
  } catch {
    return null;
  }
  if (inLaunchdDir(spots) && (spots.some((x) => x.split(sep).pop().startsWith(LABEL_PREFIX)) || names(text)))
    return `${v.slice(0, 200)} is the launchd file for what floorboss runs on its own. It is installed and changed only by you, the user, from your own terminal (scripts/unattended.mjs).`;
  // The folder launchd loads from, itself (moved away, replaced by a link): floorboss's job lives in it.
  if (spots.some((x) => launchdDirs().includes(x)))
    return `${v.slice(0, 200)} is a folder launchd loads jobs from, floorboss's among them: a connected tool doesn't move, replace or remove it.`;
  const homes = [resolve(home()), realPath(home())].map((h) => h.toLowerCase());
  const mine = spots.some((x) => homes.some((h) => x === `${h}${sep}unattended` || x.startsWith(`${h}${sep}unattended${sep}`) || x === `${h}${sep}today.html`));
  if (mine) return `${v.slice(0, 200)} is one of floorboss's own records for what it runs on its own (its off switch, log and page), which only its scripts write.`;
  // Any other record of floorboss's (a ledger, a saved agenda's page or marker): not a connected tool's to write.
  let record = false;
  try {
    record = recordFile(p);
  } catch {
    record = false;
  }
  return record ? `${v.slice(0, 200)} is one of floorboss's own records, which only its scripts write (an edited record could make a send look approved).` : null;
}
function launchdRefusal(p, input) {
  const spots = spotsOf(p);
  if (!inLaunchdDir(spots)) return null;
  const text = [input?.content, input?.new_string, input?.new_source, ...(Array.isArray(input?.edits) ? input.edits.map((e) => e?.new_string) : [])];
  const named = spots.some((x) => x.split(sep).pop().startsWith(LABEL_PREFIX)) || text.some(names);
  return named
    ? `${p} is the launchd file for what floorboss runs on its own. It is installed and changed only by you, the user, from your own terminal (scripts/unattended.mjs), never by Claude.`
    : null;
}
// Why a file tool call is refused, or null.
// The limits that hold while a run is under way apply to the session that ran floorboss (run.session); other
// sessions keep their file tools (the MCP limits still cover them for the lock's 30 minutes).
export function fileRefusal(tool, input, run = { active: false }) {
  const mine = !!(run.active && run.session);
  const searches = tool === 'Grep' || tool === 'Glob';
  // A search by name for keys or credentials ("**/.ssh/*", "**/*_history"), wherever it starts: Glob's
  // pattern, and the file filter of either tool.
  if (searches && [tool === 'Glob' ? input?.pattern : null, input?.glob].some((g) => typeof g === 'string' && globSeeksSecrets(g)))
    return `that search looks for keys, credentials or private history, and floorboss never lets Claude read those.`;
  for (const p of pathsOf(tool, input)) {
    if (inside(realPath(p), realPath(PLUGIN_ROOT))) {
      if (WRITE_TOOLS.has(tool)) return `floorboss's own plugin files aren't written by Claude.`;
      if (!sensitiveKind(p) || sensitiveKind(p) !== 'secret') continue;
    }
    if (WRITE_TOOLS.has(tool)) {
      const why = launchdRefusal(p, input);
      if (why) return why;
    }
    const kind = sensitiveKind(p);
    // A hard link in the data or temp folder: its other name may be a key or a shell profile (reads and writes).
    {
      const why = hardLinkRefusal(p);
      if (why) return why;
    }
    // Writes are judged by where they land: the real path (symlinks followed as far as the path exists), not
    // the path as written, so a link planted in the data folder can't carry a write to ~/.ssh or ~/.zshrc.
    // A write whose real path is a key place though the path as written names none came through a link.
    const rp = realPath(p);
    const viaLink = WRITE_TOOLS.has(tool) && !secretPlace(p);
    // Keys, credentials, shell histories and browser profiles: never read, run or not (floorboss reads
    // untrusted text, and text it read can outlast its run); never written while floorboss runs, never
    // written through a link, and key folders (.ssh, .aws, .gnupg…) never written at all.
    if (kind === 'secret' && (READ_TOOLS.has(tool) || mine || viaLink || SECRET_NAME.test(p) || SECRET_NAME.test(rp)))
      return `${p} holds keys, credentials or private history, and floorboss (installed in this Claude Code) doesn't let Claude ${READ_TOOLS.has(tool) ? 'read' : 'write'} there. If you, the user, need Claude to, turn the floorboss plugin off for that session.`;
    if (READ_TOOLS.has(tool)) {
      // A search over a folder that holds them (the home folder, or above it) while floorboss runs.
      if (searches && mine && inside(homedir(), p))
        return `a search over ${p} would reach keys and credentials, and a floorboss run is under way in this session: search inside a project folder instead.${lockNote(run)}`;
      // Claude and shell configuration: not while floorboss runs in this session. Claude's own session files
      // (projects, worktrees, plans) and the agents, skills and commands floorboss's scan reads stay readable.
      if (kind === 'config' && mine && !/\/\.claude\/(agents|skills|commands|plugins|projects|worktrees|plans|todos)(\/|$)/.test(p))
        return `${p} is configuration, and a floorboss run is under way: Claude doesn't read it then.${lockNote(run)}`;
      continue;
    }
    // A path written inside the data folder that really lands outside it (a link in the data folder) is
    // refused, run or not: the commands pre-approve writes there by the path as written.
    if ((inside(p, home()) || inside(p, realPath(home()))) && !inside(rp, realPath(home())))
      return `${p} is inside floorboss's data folder as written but really leads to ${rp}, outside it: floorboss doesn't let Claude write through a link there.`;
    // A link on the way that real() can't see through: one whose target isn't there yet (a write creates it).
    {
      const why = linkRefusal(p);
      if (why) return why;
    }
    if (recordFile(p))
      return `${p} is one of floorboss's own records, which only its scripts write (an edited record could make a send look approved). Use the floorboss command that changes it.`;
    // Where the write really lands: through every link on the way, one whose target isn't there yet included.
    const landsIn = (x) => inside(x, realPath(home())) || [tmpdir(), '/tmp', '/private/tmp'].some((r) => existsSync(r) && inside(x, realPath(r)));
    let lands = null;
    try {
      lands = followed(p).to;
    } catch {
      lands = null;
    }
    if (mine && (!landsIn(realPath(p)) || !lands || !landsIn(lands)))
      return `${p} is outside floorboss's data folder and the temp folder${lands && lands !== resolve(p) ? ` (it leads to ${lands})` : ''}, and a floorboss run is under way: Claude writes nowhere else then.${lockNote(run)}`;
  }
  // After the path checks, so a search inside a key folder says so first.
  if (tool === 'Grep') {
    const why = grepContentRefusal(input, mine);
    if (why) return why;
  }
  // A search (Grep or Glob) with no path runs over the working folder: while floorboss runs, not when that is the
  // home folder or a folder above it.
  if (searches && mine && !pathsOf(tool, input).length && inside(homedir(), process.cwd()))
    return `a search with no folder named runs over the home folder here, which holds keys and credentials, and a floorboss run is under way: name a project folder.${lockNote(run)}`;
  return null;
}
