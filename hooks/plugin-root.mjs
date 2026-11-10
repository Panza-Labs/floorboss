// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Where this plugin is installed, and what a path to one of its scripts looks like. Kept beside guard.mjs (not in
// guard/) because both are worked out from this file's own place in the plugin.
import { resolve } from 'node:path';

export const PLUGIN_ROOT = resolve(process.env.CLAUDE_PLUGIN_ROOT || new URL('..', import.meta.url).pathname);

// A Bash call that runs one of floorboss's scripts is held to an allowlist: outside quotes only letters,
// digits, spaces and _ . / : = @ % + , -, and plain '…' or "…" quoting. Inside double quotes no "$" or
// backtick; inside single quotes anything. The one variable allowed is ${CLAUDE_PLUGIN_ROOT}, as the commands
// write it. The commands pre-approve floorboss's scripts by their prefix, and Claude Code's docs don't say how
// a substitution inside an approved prefix is treated: "cli.mjs next --event $(cat ~/.ssh/id_rsa)" could run
// unasked. A list of what to refuse always missed one (bash's $'…' quoting, zsh's =(…) and glob qualifiers),
// so everything the shell could work out is refused, said plainly for the common ones. Every other Bash
// command is left alone.
export const PLUGIN_SCRIPT = new RegExp(
  `(${resolve(process.env.CLAUDE_PLUGIN_ROOT || new URL('..', import.meta.url).pathname).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|\\$\\{?CLAUDE_PLUGIN_ROOT\\}?)[^\\s'"]*/scripts/[\\w.-]+\\.mjs`
);
