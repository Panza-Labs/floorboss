// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Which program is running floorboss, and what that lets floorboss do.
//
// floorboss's connected features (sending, CRM writes, browser notes, reading connected tools) rest on its guard hook,
// which only Claude Code runs and which fails closed there. Anywhere else, floorboss prepares every message for the
// user to send from their own mail app, and uses no connected tool.
//
// The table, in order:
//   1. A Codex marker in the environment (any of CODEX_MARKERS): Codex. Hand-send. A marker always wins, even over
//      CLAUDECODE=1 (a Claude Code started from a Codex shell inherits both) and even in floorboss's own processes.
//   2. One of floorboss's own processes (the guard and remind hooks, the scheduler, the install script; each calls
//      ownProcess() itself, in code): as Claude Code. They never send; the guard only narrows what a call may do.
//   3. CLAUDECODE=1, the variable Claude Code sets in the shells it runs: Claude Code. Connected, as set up.
//   4. Anything else, including nothing at all: unknown. Hand-send.
// Nothing in a setting, a file or an argument can turn connected mode on: only rule 2 (code) and rule 3.
// A model outside Claude Code can still type CLAUDECODE=1 before a command; there is no guard there to stop it, so
// the README's rule for such harnesses (connect no mail, CRM or browser tool) is what holds. floorboss's scripts
// never send anything themselves, in any mode.

// Set by Codex on the commands it runs (openai/codex 0.170.0: protocol/src/shell_environment.rs, core/src/exec_env.rs,
// core/src/spawn.rs). CODEX_HOME is left out on purpose: a Claude Code user may have it in their shell profile.
export const CODEX_MARKERS = Object.freeze(['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']);

export const HARNESSES = Object.freeze({
  'claude-code': Object.freeze({ label: 'Claude Code', connected: true }),
  codex: Object.freeze({ label: 'Codex', connected: false }),
  unknown: Object.freeze({ label: 'an unknown program', connected: false })
});

let own = false;
// Called at the top of floorboss's own entry files that a model doesn't drive (hooks/guard.mjs, hooks/remind.mjs,
// scripts/scheduled.mjs, scripts/unattended.mjs).
export function ownProcess() {
  own = true;
}

const set = (v) => v != null && String(v) !== '';

export function harness(env = process.env, { ownProc = own } = {}) {
  if (CODEX_MARKERS.some((k) => set(env[k]))) return 'codex';
  if (ownProc) return 'claude-code';
  if (env.CLAUDECODE === '1') return 'claude-code';
  return 'unknown';
}

// True only where floorboss may use connected tools: Claude Code with its guard.
export function connected(env = process.env, opts) {
  return HARNESSES[harness(env, opts)]?.connected === true;
}

// The settings as hand-send sees them: no connected tool, nothing that sends, writes a CRM or drives a browser.
// Applied on top of whatever config.json or event.json say, so a file written in another program can't switch
// anything on here.
export function handSendView(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const s = { ...settings };
  s.connectors = {};
  s.sending = { ...(s.sending && typeof s.sending === 'object' ? s.sending : {}), channels: [], linkedin_ack: false };
  if (s.crm_log === 'browser' || s.crm_log === 'tasks') s.crm_log = 'csv';
  if (s.crm_create_contacts != null) s.crm_create_contacts = 'no';
  if (s.crm_fill_blanks != null) s.crm_fill_blanks = 'no';
  s.inbox_read = { linkedin: false, app: false };
  s.log_replies = false;
  s.hand_send = true;
  return s;
}

// What a config patch may save in hand-send: nothing about connections, sending, CRM writes or browser reading. Those
// keys are left out of the patch, not blanked, so what a Claude Code setup saved in the same data folder stays as it
// was for Claude Code (the view hides it here).
export const HAND_SEND_KEYS = Object.freeze(['connectors', 'sending', 'crm_log', 'crm_create_contacts', 'crm_fill_blanks', 'inbox_read', 'log_replies']);
export function handSendPatch(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const p = { ...patch };
  for (const k of HAND_SEND_KEYS) delete p[k];
  // A CRM log by CSV or none is the user's choice in either program and keeps nothing connected.
  if (patch.crm_log === 'csv' || patch.crm_log === 'none') p.crm_log = patch.crm_log;
  return p;
}

// The scan's inventory as hand-send sees it: nothing connected, whatever inventory.json (a Claude Code scan's, in the
// same data folder) says. The file itself is left alone.
export const EMPTY_INVENTORY = Object.freeze({ items: [], found: {}, writers: [], outbound: 'none', counts: {}, setup_servers: [], setup_found: {}, setup_browser_tools: [] });
export function inventoryView(inv, env = process.env) {
  if (connected(env)) return inv;
  return { ...EMPTY_INVENTORY, hand_send: true };
}

// One line for the user: what this program gets.
export function modeLine(env = process.env) {
  const h = harness(env);
  return HARNESSES[h].connected
    ? null
    : `floorboss is running in ${HARNESSES[h].label}. It uses no connected tools here: it prepares each message, and you send it from your own mail app.`;
}
