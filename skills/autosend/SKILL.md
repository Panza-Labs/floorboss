---
name: autosend
description: Codex only. floorboss auto-send from the user's own ChatGPT cloud task (Gmail only). Not for Claude Code, where every one of its commands refuses; Claude Code has its own sending. Never use this skill in Claude Code.
license: Apache-2.0
disable-model-invocation: true
---

# Auto-send (Codex only)

This folder holds the script behind floorboss's auto-send in Codex: `scripts/cli.mjs`. In Claude Code every one of
its commands refuses ("auto-send is for Codex; Claude Code has its own sending"), so there is nothing here to run.

In Codex, the laptop steps (turning an event on, the readback and the second yes, "stop auto-send", settling an
unclear send, the data repo's lock) are in `.agents/skills/floorboss/SKILL.md` under "Auto-send from the cloud". The
cloud task's prompt is `codex/autosend-task.md`. The design: lib/autosend/ and SECURITY.md ("Auto-send in Codex").
