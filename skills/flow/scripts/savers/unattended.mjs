// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// The answers about unattended drafts: "seen" (what floorboss did on its own was shown, so an attended run goes on),
// and the yes or "not now" to authorising a sequence's follow-ups (the authorisation itself is a prompt the guard
// raises on the command named here; this saves no authorisation).
import { writePrivate, unseen } from '../../../../lib/unattended-drafts.mjs';
import { script } from '../context.mjs';

export const UNATTENDED_SAVERS = {
  unattended_seen: () => {
    const news = unseen();
    const at = news.length ? news[news.length - 1].at : new Date().toISOString();
    writePrivate([], 'summary-seen.json', { at, seen_at: new Date().toISOString() });
    return { seen: news.length };
  },
  unattended_authorise: (v, c) => {
    const yes = /^\s*(yes|y|ok|okay|sure|go ahead|do it)\b/i.test(String(typeof v === 'object' ? v?.answer || '' : v));
    if (!yes) return { authorised: false, note: 'Nothing is authorised. Every follow-up waits for you, as before.' };
    return {
      run_this: ['node', script('event-outreach'), 'authorise-unattended', '--event', c.slug],
      note: 'Run run_this as it is. Claude Code shows the user every follow-up in full; only their allow authorises them.'
    };
  }
};
