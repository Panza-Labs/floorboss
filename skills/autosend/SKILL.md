---
name: autosend
description: floorboss auto-send (Gmail only). In Codex, from the user's own ChatGPT cloud task. In Claude Code, through a daily Claude routine: the routine's commands and a routine event's laptop steps (on, readback, approve, revoke, drafts; skills/flow/SKILL.md says when); every other command refuses there.
license: Apache-2.0
disable-model-invocation: true
---

# Auto-send

This folder holds the script behind floorboss's auto-send: `scripts/cli.mjs`. In Claude Code it runs the daily Claude
routine's commands (`scripts/routine.mjs`) and the laptop steps of an event set to send that way (on, readback, approve,
revoke, drafts): when to run them is "Daily sending through a Claude routine" in `skills/flow/SKILL.md`. Every other
command refuses there.

In Codex, the laptop steps (turning an event on, the readback and the final approval, "stop auto-send", settling an
unclear send, the data repo's lock) are in `.agents/skills/floorboss/SKILL.md` under "Auto-send from the cloud". The
cloud task's prompt is `codex/autosend-task.md`. The design: lib/autosend/ and SECURITY.md ("Auto-send in Codex").
