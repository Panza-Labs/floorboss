---
description: Turn off what floorboss runs on its own (the morning brief), or see whether it is installed and when it last ran.
argument-hint: "off | status"
allowed-tools: ["Bash(node \"${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs\" off)", "Bash(node \"${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs\" status)"]
---

Arguments: `$ARGUMENTS` (`off` or `status`; with none, `status`).

Run exactly one of these, with nothing before or after it, and show the user what it prints:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" off`: stops every unattended run until the user turns it
  on again. Nothing is removed.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" status`: what is installed, whether it is off, and the
  last runs.

That is all this command does. Installing the morning brief, removing it and turning it back on are the user's,
from their own terminal: floorboss's guard refuses them from a Claude session. If the user asks for one, print
the line for them to copy and run it nowhere yourself:

- install: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" install-brief`
- turn back on: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" on`
- remove: `node "${CLAUDE_PLUGIN_ROOT}/scripts/unattended.mjs" uninstall-brief`

Running on its own is macOS only for now.
