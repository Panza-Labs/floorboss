# floorboss

If you are Codex (or another agent that isn't Claude Code) and the user wants to run floorboss, an event, a
conference or their outreach for one: use the `floorboss` skill in `.agents/skills/floorboss/SKILL.md` and follow it.
In this harness floorboss never sends, uses no connected tools, and the user sends each message from their own mail
app. The one exception is auto-send, which the user turns on for an event: it sends from their own ChatGPT cloud task
(`codex/autosend-task.md`), never from this chat.

If you are working on floorboss's code instead: README.md ("Development") and CONTRIBUTING.md. Run `npm test` and
`npm run self-check`; floorboss has no dependencies, and none may be added.
