// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// The collection prompt: generic instructions the user runs in their own browser agent.
import { CONSTANTS } from '../../../lib/config.mjs';

export const CSV_HEADER = 'name,title,company,email,profile_url,attendee_type,location,notes,booth';

export function collectPrompt({ event, listUrl, segments = [], mustMeet = [], savePath }) {
  // Everyone on the list is captured: who fits is decided later, where the user can see it. A filter here
  // would be a fit decision nobody sees.
  const meta = String(savePath).replace(/\.csv$/i, '') + '.meta.json';
  return `# Collect the contact list for ${event.name}

Check the event's and the platform's terms before running this. You're running it in your own browser,
logged in as yourself; that's your decision and your risk.

## The event
- ${event.name}, ${event.city}, ${event.start_date} to ${event.end_date}
- List page: ${listUrl || '(the attendee, speaker, exhibitor or sponsor list on the event site or app)'}

## Who to capture
Everyone on the list: every attendee, speaker, exhibitor and sponsor contact the page shows. Don't filter
by role or company; floorboss decides who fits later, where the user can see each decision.
${mustMeet.length ? `\nCheck these names especially and say which ones you saw: ${mustMeet.join(', ')}.\n` : ''}
## What to capture
Save a CSV with exactly this header line:

${CSV_HEADER}

Fill email, profile_url, notes and booth only where the page shows them. Leave a field empty rather
than guessing.

## How to behave
- Read only. Never message, connect, follow, book, register or click anything that changes something.
- Stay on the event's own site or app. Never visit LinkedIn.
- Skip anyone whose profile is marked private or hidden.
- Go slowly, one page at a time.
- Stop at the first rate limit, captcha or warning, and save what you have.
- Stop after ${CONSTANTS.collection_row_cap} rows.

## Where to save it
${savePath}

Then save a second file, ${meta}, with what the page said and why you stopped:

{"shown_total": <the number of people the page says are listed, or null if it doesn't say>,
 "saved": <rows you saved>, "stopped_because": "<end of list | row limit | rate limit | captcha | other: …>"}
`;
}
