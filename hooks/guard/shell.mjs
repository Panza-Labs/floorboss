// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The shell (Bash): recognising a call to one of floorboss's own scripts, holding such a call to plain
// characters and plain quoting, and saving or forgetting a connection mid-run.
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { home, allowedPath, readChecked, realPath } from '../../lib/paths.mjs';
import { sameServer } from '../../lib/security.mjs';
import { bareToolName } from '../../skills/connectors/scripts/tasks.mjs';
import { writeText } from '../../lib/jsonio.mjs';
import { PLUGIN_ROOT, PLUGIN_SCRIPT } from '../plugin-root.mjs';
import { promptLine } from './prompts.mjs';
import { LABEL_PREFIX } from '../../lib/unattended.mjs';
import { foundServer } from './connectors.mjs';

// A Bash call that runs one of floorboss's own scripts: the run lock is tied to this session from now on.
export const SCRIPT_CALL =
  /(skills\/(flow|event-context|slot-finder|crm-triage|event-outreach|connectors|attendee-research)\/scripts\/cli\.mjs|examples\/mock-event\/load\.mjs)(?:["']?\s+([a-z][\w-]*))?/;
export function floorbossScriptCall(command) {
  // The script is the word after node, read as the shell reads it (bashRefusal holds a script call to that form),
  // so quotes in its path, or a script's name further along the command, can't make it look like another one.
  const words = shellWords(command);
  // The plain text must name a script too: that is what holds the command to bashRefusal's rules, so a name split
  // by quotes ("con""nectors") is no script call, and in a held session is refused as any other command.
  const m = words[0] === 'node' && SCRIPT_CALL.test(String(command || '')) ? SCRIPT_CALL.exec(words[1] ?? '') : null;
  return m ? { sub: words[2] ?? null, skill: m[2] || null } : null;
}
// A command's words exactly as the shell reads them: "save-recipe" and sa''ve-recipe are both save-recipe, and a
// backslash in double quotes stands only before $ ` " \ or a line break (which it removes).
function shellWords(command) {
  const words = [];
  let word = null,
    q = null;
  const cmd = String(command || '');
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") {
      if (ch === "'") q = null;
      else word += ch;
    } else if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && cmd[i + 1] === '\n') i++;
      else if (ch === '\\' && '$`"\\'.includes(cmd[i + 1] ?? ' ')) word += cmd[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === '\\') {
      if (cmd[i + 1] === '\n') i++;
      else word = (word ?? '') + (cmd[++i] ?? '');
    } else word = (word ?? '') + ch;
  }
  if (word !== null) words.push(word);
  return words;
}

// Saving or forgetting a connection in the session that ran floorboss. Setup does this mid-run, so it can't simply
// be refused; but a saved read recipe makes its server "given" and lifts the run's limits on what its calls carry,
// and the files behind it are ones the session writes. A subagent never does it. A connection on a server setup
// didn't find, or one that moves a saved connection to another server, is the user's to allow. The guard notes
// the whole command and the recipe it looked at, for any session, once it has decided, and the script runs only that.
export function connectorChange(command, sub, { held, subagent, config }) {
  const words = shellWords(command);
  const flag = (k) => {
    const i = words.lastIndexOf(k);
    return i >= 0 ? words[i + 1] : undefined;
  };
  const task = String(flag('--task') ?? '');
  const note = (server, tool) => writeText(join(home(), 'recipe-seen.json'), JSON.stringify({ argv: words.slice(2), server, tool, at: new Date().toISOString() }));
  if (held && subagent) return { refuse: "a subagent doesn't change floorboss's connections." };
  if (held && !task) return { refuse: 'this names no connection: pass --task with the task itself.' };
  const saved = config?.connectors?.[task];
  if (sub === 'forget') {
    note();
    return held ? { ask: `floorboss: forget your ${promptLine(task)} connection${saved?.server ? ` (${promptLine(saved.server)}/${promptLine(saved.tool)})` : ''}?\n\nAllow only if you asked for this.` } : {};
  }
  let recipe;
  try {
    recipe = JSON.parse(readChecked(allowedPath(flag('--recipe-file'))));
  } catch {
    return held ? { refuse: "its guard couldn't read that recipe file, so it can't check which connection this saves." } : {};
  }
  if (typeof recipe?.server !== 'string' || typeof recipe?.tool !== 'string') {
    if (held) return { refuse: "that recipe's server and tool aren't plain names." };
    note();
    return {};
  }
  const { server, tool } = recipe;
  if (!held) {
    note(server, tool);
    return {};
  }
  const moved = saved?.server && !sameServer(saved.server, server);
  const named = /^mcp__(.+?)__/.exec(tool);
  const silent = foundServer(server) && !moved && !bareToolName(tool).includes('__') && (!named || sameServer(named[1], server));
  note(server, tool);
  if (silent) return {};
  return {
    ask: `floorboss: connect ${promptLine(task)} to ${promptLine(server)}/${promptLine(tool)}?${moved ? ` This replaces ${promptLine(saved.server)}/${promptLine(saved.tool)}.` : " Setup didn't find this as a connector of that name."} Once saved, floorboss's run can call it with what the session has read.\n\nAllow only if you're setting this connection up.`
  };
}
const PLAIN_CHAR = /[A-Za-z0-9_./:=@%+,-]/;
const ROOT_VAR = /^\$(?:\{CLAUDE_PLUGIN_ROOT\}|CLAUDE_PLUGIN_ROOT(?![\w]))/;
export function bashRefusal(command) {
  const cmd = String(command || '');
  // A node command that names the plugin folder at all is held to the same rules, so a path spelled another way
  // ("scripts/./cli.mjs") is not let past as a command that isn't floorboss's.
  const namesPlugin = /^node\s/.test(cmd.trimStart()) && (cmd.includes('CLAUDE_PLUGIN_ROOT') || cmd.includes(PLUGIN_ROOT));
  if (!PLUGIN_SCRIPT.test(cmd) && !SCRIPT_CALL.test(cmd) && !namesPlugin) return null;
  const subst = (what) =>
    `this runs a floorboss script with ${what} in the command. floorboss's commands take values from files instead: write the value to a file and pass it with --value-file (or the command's own --file flag).`;
  const joined = (op) =>
    `this runs a floorboss script with ${op} after it, which starts another command. Run floorboss's script as a command of its own, with nothing before or after it.`;
  const plain = (what) =>
    `this runs a floorboss script with ${what}, which the shell could read as more than a plain value. Pass floorboss's scripts plain words, or put a value in single quotes; anything longer goes in a file, passed with --value-file (or the command's own --file flag).`;
  // The command starts with node itself: a setting before it (NODE_OPTIONS=…, PATH=…) or a wrapper
  // (env, exec, nice) could load other code into the script or run a different node.
  if (!/^node\s/.test(cmd.trimStart()))
    return `this runs a floorboss script with something before "node" (a setting like NODE_OPTIONS=, or another command). Run floorboss's script as "node" followed by the script, with nothing before it.`;
  // zsh expands =name to a command's path, and an empty pair of quotes before it doesn't stop that.
  if (/(^|\s)(''|"")+=/.test(cmd)) return plain('an equals sign after empty quotes');
  let q = null,
    wordStart = true;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i],
      next = cmd[i + 1];
    if (q === "'") {
      if (ch === "'") q = null;
      continue;
    }
    if (ch === '$') {
      // Only as the start of the script's own path: anywhere else the guard would read a different command from
      // the one the shell runs.
      const m = /^\s*node\s+["']?$/.test(cmd.slice(0, i)) ? ROOT_VAR.exec(cmd.slice(i)) : null;
      if (m) {
        i += m[0].length - 1;
        wordStart = false;
        continue;
      }
      if (next === '(') return subst('"$(…)" (command substitution)');
      return subst(next === "'" ? `"$'…'" (quoting the shell decodes)` : `"$" (a variable the shell fills in)`);
    }
    if (ch === '`') return subst('a backtick (command substitution)');
    if (q === '"') {
      if (ch === '"') q = null;
      // An escaped character inside double quotes is that character ("\$" is a dollar sign, not a variable).
      else if (ch === '\\') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      wordStart = false;
      continue;
    }
    if (ch === ' ') {
      wordStart = true;
      continue;
    }
    if ((ch === '<' || ch === '>') && next === '(') return subst(`"${ch}(…)" (process substitution)`);
    if (ch === '>') return subst(`an output redirect ("${cmd[i - 1] === '2' ? '2' : ''}>${next === '>' ? '>' : ''}")`);
    // A second command after the script (";", "&&", "||", "|", "&" or a new line, outside quotes): the
    // guard doesn't rely on Claude Code's own handling of operators after an approved prefix.
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r')
      return joined(ch === '\n' || ch === '\r' ? 'a new line' : `"${ch}${next === ch && ch !== ';' ? ch : ''}"`);
    if (ch === '<') return plain('an input redirect ("<") outside quotes');
    // zsh reads a word that starts with "=" as a command's path ("=(…)" runs a command into a temp file).
    if (ch === '=' && wordStart) return plain('a word starting with "=" outside quotes');
    if (PLAIN_CHAR.test(ch)) {
      wordStart = false;
      continue;
    }
    return plain(ch === '\\' ? 'a backslash outside quotes' : ch === '\t' ? 'a tab outside quotes' : `"${ch}" outside quotes`);
  }
  if (q) return plain(`a ${q === '"' ? 'double' : 'single'} quote that is never closed`);
  return scriptWordRefusal(cmd);
}

// The first word after "node" is floorboss's own script, and nothing else: no node option before it (--import,
// -r, -e, --env-file, --inspect load or run other code), no other script with floorboss's path as its argument,
// and no "." or ".." segment in it ("cli.mjs/../../x.mjs" is resolved by its text and ran another file). It names a
// script under the plugin root, by its text and by its real path.
const SCRIPT_REL = /^(?:skills\/[a-z][a-z-]*\/scripts\/[\w-]+\.mjs|examples\/mock-event\/load\.mjs|scripts\/unattended\.mjs)$/;
function scriptWordRefusal(cmd) {
  const rest = cmd.trimStart().slice(4).replace(/^ +/, '');
  // The word, as the shell reads it (the loop above allowed only plain characters and plain quotes).
  const word = shellWords(rest)[0] ?? '';
  const bad = `this runs node with something other than floorboss's own script as its first word ("${word.slice(0, 80)}"). Run "node" followed directly by the script under the plugin folder, with no node option before it and no "." or ".." in its path.`;
  if (!word || word.startsWith('-')) return bad;
  // A $ the shell won't expand (single quotes, \$) is a folder of that name, not the plugin.
  const m = /^"?\$/.test(rest) ? ROOT_VAR.exec(word) : null;
  const given = m ? PLUGIN_ROOT + word.slice(m[0].length) : word;
  if (given.includes('$') || given.split('/').some((x) => x === '..' || x === '.')) return bad;
  // A relative path names the script in the folder the command runs in: it counts only if that is the plugin's.
  const path = (given.startsWith('/') ? given : `${process.cwd()}/${given}`).replace(/\/{2,}/g, '/');
  if (!path.startsWith(PLUGIN_ROOT + '/') || !SCRIPT_REL.test(path.slice(PLUGIN_ROOT.length + 1))) return bad;
  const rp = realPath(path),
    rr = realPath(PLUGIN_ROOT);
  if (!rp.startsWith(rr + sep)) return bad;
  return null;
}

// ---------- what runs on its own (lib/unattended.mjs) ----------
// The scheduled job is installed, loaded, changed and switched back on by the user, from their own terminal, never
// from a session: text a session read could otherwise set up something that runs with nobody there. Refused by
// name, in every session, whether or not floorboss ran in it.
// Turning it off only reduces what can happen, so `unattended.mjs off` and `status` pass: exactly "node", the
// script under the plugin folder and that one word (bashRefusal has already held the command to plain words).
export function unattendedCall(command) {
  const cmd = String(command || '');
  if (!PLUGIN_SCRIPT.test(cmd) || bashRefusal(cmd)) return null;
  const words = shellWords(cmd);
  if (words.length !== 3 || words[0] !== 'node' || !['off', 'status'].includes(words[2])) return null;
  const path = words[1].replace(ROOT_VAR, PLUGIN_ROOT);
  return path === `${PLUGIN_ROOT}/scripts/unattended.mjs` ? words[2] : null;
}

// Looking at floorboss's own job, and nothing else: these exact commands, each a plain read. Anything that isn't one
// of them, letter for letter, falls to the rules below.
function readOnlyLook(command) {
  const cmd = String(command || '').trim();
  if (!/^[A-Za-z0-9 _.\/~|-]+$/.test(cmd)) return false;
  const lit = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const homes = ['~', homedir()].map(lit).join('|');
  const data = [...(home() === join(homedir(), '.floorboss') ? ['~/.floorboss'] : []), home()].map(lit).join('|');
  const label = `${lit(LABEL_PREFIX)}[a-z][a-z-]{0,30}`;
  const plist = `(?:${homes})/Library/LaunchAgents/${label}\\.plist`;
  const folder = `(?:${data})/unattended`;
  return [
    `launchctl print (?:gui|user)/\\d{1,10}/${label}`,
    `launchctl list \\| grep (?:-i )?${lit(LABEL_PREFIX)}?(?:[a-z-]{0,30})`,
    `(?:cat|ls|ls -l|ls -la|ls -al|plutil -lint|plutil -p) ${plist}`,
    `(?:ls|ls -l|ls -la|ls -al) ${folder}/?`,
    `(?:cat|head|tail|tail -f|(?:head|tail) -n \\d{1,4}|wc -l) ${folder}/(?:log\\.jsonl|brief-state\\.json|brief-installed\\.json|brief-told|off)`
  ].some((re) => new RegExp(`^${re}$`).test(cmd));
}

// The names, read from a text with no model of the shell at all. Each test is one pass over the text.
// launchctl: the word, and anywhere after it one of the words that load, enable or start a job, or that run a
// command through it (asuser, bsexec). It does not ask whether that word is launchctl's own subcommand, so
// "man launchctl | grep bootstrap" and a sentence that holds both words are refused too: the cost of not guessing.
const LAUNCHCTL = /\blaunchctl\b/i;
const STARTS = /\b(bootstrap|load|enable|kickstart|start|submit|asuser|bsexec)\b/i;
const startsJob = (t) => {
  const at = t.search(LAUNCHCTL);
  return at >= 0 && STARTS.test(t.slice(at));
};
const INSTALLER = /unattended(\.mjs|\s*[*?[{])/i;
const LABEL = LABEL_PREFIX.toLowerCase();
const FOLDER = /(?<![\w.-])unattended(?![\w.-])/i;
// The text as written, and a few more ways the shell could join it: quotes, $'…' and $"…", backticks and
// backslashes taken out; the braces and commas of {a,b} taken out, or read as spaces; and a written-out line
// break or tab (the two characters "\n" in a printf) read as a space.
function readings(text) {
  const raw = String(text);
  const strip = (t) => t.replace(/\$(?=['"])/g, '').replace(/['"\\`]/g, '');
  const plain = strip(raw.replace(/\\\r?\n/g, ''));
  return [raw, plain, plain.replace(/[{},]/g, ''), plain.replace(/[{},]/g, ' '), strip(raw.replace(/\\[nrt]/g, ' '))];
}
const YOURS =
  'is done by you, the user, from your own terminal, never from a Claude session. Turning it off is always allowed: node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" off (or status, to see what is installed).';

// A name rule, not a sandbox, for Bash, PowerShell and Monitor commands. It can't see a name the shell builds some
// other way (a variable, a wildcard that isn't on the name's end, an interpreter handed the name in pieces, a copy
// or a link of the script under another name). In the session that ran floorboss no other shell command runs at
// all. Nothing that sends relies on this rule.
export function scheduleRefusal(command) {
  const cmd = String(command || '');
  if (!cmd) return null;
  if (readOnlyLook(cmd)) return null;
  const texts = readings(cmd);
  const has = (re) => texts.some((t) => re.test(t));
  if (has(INSTALLER) && !unattendedCall(cmd))
    return `this names floorboss's unattended.mjs with something other than "off" or "status". Installing, removing or switching on what floorboss runs on its own ${YOURS}`;
  if (texts.some((t) => t.toLowerCase().includes(LABEL))) return `this names floorboss's scheduled job (${LABEL_PREFIX}…) or its launchd file. Installing, loading or changing it ${YOURS}`;
  if (texts.some(startsJob)) return `this names launchctl with a word that loads or starts a launchd job, and with floorboss installed that ${YOURS}`;
  const inData = [home(), realPath(home())].some((h) => texts.some((t) => t.includes(h)) || process.cwd() === h || process.cwd().startsWith(h + sep));
  const mine = has(/floorboss/i) || inData;
  if (has(FOLDER) && mine)
    return `this names floorboss's unattended folder (its off switch, log and records). Only floorboss's own scripts write there; switching unattended runs back on ${YOURS}`;
  // today.html is read freely (open, cat); written, moved or removed only by floorboss's own scripts.
  if (mine && has(/today\.html/i) && has(/>|(?<![\w.-])(rm|mv|cp|ln|tee|dd|sed|truncate|unlink|mkfifo|touch|chmod|install|rsync)(?![\w.-])/i))
    return `this writes, moves or removes floorboss's today.html, which only its own scripts write. ${YOURS.replace(/^is done/, 'What runs on its own is set up')}`;
  return null;
}

// ---------- the same names in a connected tool's input (MCP) ----------
// Whether a connected tool only reads, by its name and nothing else: floorboss can't see what a tool does. Every
// word of the name is looked at. One read word must be there, and no word that writes, runs, sends or joins two
// actions ("check_and_fix", "fetch_to_path", "list_append"). A tool named like a read that writes can't be seen.
const READ_WORDS = new Set(
  'get list search find query lookup read fetch describe show retrieve view count check guide help docs whoami status ping navigate snapshot screenshot info'.split(' ')
);
const WRITE_WORDS = new Set(
  (
    'write create update delete remove move set put save run exec execute start send post fix edit overwrite truncate append upsert store rename touch add insert patch modify change replace clear reset drop kill stop spawn launch open ' +
    'type click press key fill upload import export copy sync apply commit push merge deploy install uninstall enable disable load unload trigger invoke call eval evaluate script shell command process terminal make mkdir rm mv cp chmod chown ' +
    'schedule publish share reply forward archive trash label mark assign close resolve approve cancel book pay transfer and then to or into onto'
  ).split(' ')
);
export function plainlyReads(tool) {
  const words = String(tool || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.length > 0 && words.length <= 12 && words.some((w) => READ_WORDS.has(w)) && !words.some((w) => WRITE_WORDS.has(w));
}

export const TOO_LARGE = 'this call is too large for floorboss to check; send it in smaller parts.';
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_DEPTH = 512;
const PATH_BUDGET_MS = 1000;
const MAX_PATHS = 50;
const PATH_WORDS = /launchagents|launchdaemons|unattended|today\.html/i;
// Every value in the input, once: its strings joined with single spaces (so a command given in pieces, "launchctl"
// in one field and "load" in the next, reads as adjacent words), and the strings that may be paths. Stops, and
// says so, at 2 MB of values (each string, number or true/false by its own length), at 512 levels of nesting, or
// at more than 50 paths that name one of floorboss's places. A string counts as such a path only with a slash in
// it: sixty rows of a sheet that say "unattended-upgrades" are not sixty paths.
function gather(input) {
  const parts = [];
  const named = [];
  const pathLike = [];
  let size = 0;
  const stack = [[input, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (typeof v === 'string') {
      size += v.length + 1;
      if (size > MAX_TEXT) return { over: true };
      parts.push(v);
      const slashed = v.includes('/') || v.includes('\\');
      if (v.length <= 1024) {
        if (slashed && PATH_WORDS.test(v)) named.push(v);
        else if (pathLike.length < MAX_PATHS && /^(~|\/|\.{1,2}\/)/.test(v)) pathLike.push(v);
      } else if (slashed && PATH_WORDS.test(v) && !/\s/.test(v)) return { over: true }; // too long to resolve, and it may be a path to one of them
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      const text = String(v);
      size += text.length + 1;
      if (size > MAX_TEXT) return { over: true };
      parts.push(text);
    } else if (v && typeof v === 'object') {
      if (depth >= MAX_DEPTH) return { over: true };
      const kids = Array.isArray(v) ? v : Object.values(v);
      // (One for the list or object itself, so a million empty ones are not free.)
      size += 1;
      // Every value in it counts at least one, so a list that can't fit is refused before it is walked.
      if (size + kids.length > MAX_TEXT) return { over: true };
      // Pushed last first, so the values come off in the order they were written.
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1]);
    } else {
      // null, and anything else: one each, so ten million of them are over the cap, not a long walk.
      size += 1;
      if (size > MAX_TEXT) return { over: true };
    }
  }
  if (named.length > MAX_PATHS) return { over: true };
  return { text: parts.join(' '), paths: [...named, ...pathLike].slice(0, MAX_PATHS) };
}
// Why a connected tool's call is refused under these rules, or null. One pass, no disk for the names, and at most
// 50 short paths resolved (pathRefusal: hooks/guard/files.mjs). A tool that plainly reads is not looked at: a
// search for "launchctl load" or a read of the brief's page is none of this rule's business. For any other tool,
// what can't be checked is refused: too large, too deep, or anything going wrong on the way.
export function mcpScheduleRefusal(tool, input, pathRefusal) {
  if (plainlyReads(tool)) return null;
  try {
    const g = gather(input);
    if (g.over) return TOO_LARGE;
    const texts = readings(g.text);
    const has = (re) => texts.some((t) => re.test(t));
    // unattended.mjs: each mention followed by "off" or "status" is turning it off, or looking. Read with the
    // quotes taken out, since the script's path is often quoted.
    for (const t of texts.slice(1)) {
      for (let at = t.search(INSTALLER); at >= 0; ) {
        const rest = t.slice(at + 'unattended'.length, at + 'unattended'.length + 40);
        if (!/^\.mjs\s+(off|status)(?![\w.-])/i.test(rest))
          return `this names floorboss's unattended.mjs with something other than "off" or "status". Installing, removing or switching on what floorboss runs on its own ${YOURS}`;
        const next = t.slice(at + 1).search(INSTALLER);
        at = next < 0 ? -1 : at + 1 + next;
      }
    }
    if (texts.some((t) => t.toLowerCase().includes(LABEL))) return `this names floorboss's scheduled job (${LABEL_PREFIX}…) or its launchd file. Installing, loading or changing it ${YOURS}`;
    if (texts.some(startsJob)) return `this names launchctl with a word that loads or starts a launchd job, and with floorboss installed that ${YOURS}`;
    // floorboss's unattended folder and today.html: named as a path into its data folder, or beside a word that
    // writes, moves or removes in a text that names floorboss.
    const homes = [home(), realPath(home())].map((h) => h.toLowerCase());
    const inData = texts.some((t) => homes.some((h) => t.toLowerCase().includes(h))) || has(/\.floorboss(?![\w-])/i);
    const acts = has(/>|(?<![\w.-])(rm|mv|cp|ln|tee|dd|sed|truncate|unlink|rmdir|mkfifo|touch|chmod|chown|install|rsync|write|delete|remove|move|rename|overwrite)(?![\w.-])/i);
    if ((has(FOLDER) || has(/today\.html/i)) && (inData || (acts && has(/floorboss/i))))
      return `this names floorboss's unattended folder or today.html (its off switch, log, records and page), which only floorboss's own scripts write. Switching unattended runs back on ${YOURS}`;
    // At most a second on the paths: a tree planted 480 folders deep, or a chain of links, can make each one slow.
    const started = Date.now();
    for (const p of g.paths) {
      if (Date.now() - started > PATH_BUDGET_MS) return TOO_LARGE;
      const why = pathRefusal(p, g.text);
      if (why) return why;
    }
    return null;
  } catch {
    return TOO_LARGE.replace('is too large for floorboss to check; send it in smaller parts', "couldn't be checked by floorboss's guard, so it isn't let through; send it in smaller parts");
  }
}
