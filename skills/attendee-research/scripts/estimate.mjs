// Copyright 2026 Panza Labs
// SPDX-License-Identifier: Apache-2.0
// Research cost estimate shown before the user picks a scale.
import { CONSTANTS } from '../../../lib/config.mjs';

export function estimate(n) {
  return {
    contacts: n,
    minutes: Math.ceil((n * CONSTANTS.research_minutes_per_contact) / 3), // a few run in parallel
    searches: n * CONSTANTS.research_searches_per_contact
  };
}

// Which contacts to research for a chosen scale. ranked: ids in first-ranking order; warm: ids.
export function pickForResearch(ranked, { scale, n = CONSTANTS.research_default_n, warm = [], has = () => false }) {
  let pick;
  if (scale === 'none') return [];
  if (scale === 'all') pick = ranked;
  else if (scale === 'top') pick = [...new Set([...warm, ...ranked.slice(0, n)])];
  else if (scale === 'cap') pick = ranked.slice(0, n);
  else throw new Error('Research scale is "all", "top", "cap" or "none".');
  return pick.filter((id) => !has(id));
}
