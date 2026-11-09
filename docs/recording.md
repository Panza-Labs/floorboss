# Recording the 60-second demo

The README's GIF is now a scripted film on example data. This is how to record a real take of the mock run instead.

## Before you record

1. Install the plugin (see the README), or start Claude Code with `claude --plugin-dir <path to floorboss>`.
2. Use a fresh data folder so the run starts clean:
   `export FLOORBOSS_HOME=$(mktemp -d)` before starting `claude`.
3. Do one full practice run first. The draft step takes several minutes (it writes about 25 drafts and
   sends each through the critic), so the recording speeds it up rather than showing it in real time.
4. Terminal: large font (18pt or more), a light or dark theme with good contrast, window about 1280×800.

## Shot list (about 60 seconds after editing)

| Seconds | What's on screen |
|---|---|
| 0–6 | Type `/floorboss:event-setup mock buyers`. Setup's summary: event, 58 attendees, 23 slots, context check notes. |
| 6–20 | Type `/floorboss:event-triage mock-harbour-haul`. Show the groups (suppressed, coordinate, warm, check-these), the injected note being ignored, and the shortlist table with reasons. Answer `defaults`. |
| 20–28 | The gate result: 25 shortlisted, each with two times, no slot offered more than three times. |
| 28–42 | Type `/floorboss:event-draft mock-harbour-haul`. Speed up the drafting. Pause on a critic FAIL and its reason (for example invented urgency), then the rewrite passing. |
| 42–55 | The outbox opens in the browser: scroll the cards, click Copy on one message, tick Sent and Booked, click Copy status. |
| 55–60 | End on the outbox header: "You're sending these yourself." |

## Export

Save as an MP4 or GIF under 10 MB and put it at the top of the README, replacing the `RECORDING` comment.
On macOS, Cmd+Shift+5 records a window; trim and speed up the drafting section in QuickTime or any editor.
