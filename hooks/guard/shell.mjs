// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The shell (Bash): recognising a call to one of floorboss's own scripts, holding such a call to plain
// characters and plain quoting, and saving or forgetting a connection mid-run.
import { join, sep } from 'node:path';
import { home, allowedPath, readChecked, realPath } from '../../lib/paths.mjs';
import { sameServer } from '../../lib/security.mjs';
import { bareToolName } from '../../skills/connectors/scripts/tasks.mjs';
import { writeText } from '../../lib/jsonio.mjs';
import { PLUGIN_ROOT, PLUGIN_SCRIPT } from '../plugin-root.mjs';
import { promptLine } from './prompts.mjs';
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
const SCRIPT_REL = /^(?:skills\/[a-z][a-z-]*\/scripts\/[\w-]+\.mjs|examples\/mock-event\/load\.mjs)$/;
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
