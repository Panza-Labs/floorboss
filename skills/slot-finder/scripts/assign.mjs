// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Give each shortlisted contact up to two slots: different days, else 2h apart the same day,
// else one slot, else an open ask. Higher ranks pick first; no slot exceeds its capacity.
// Only times on the hour or the half hour are offered ("Tue 1st at 9:00", never "11:10"): a slot that starts anywhere
// else (a busy block or a gap moved it) stays free for booking but is never offered.

const TWO_HOURS = 2 * 3600 * 1000;
// A slot's id carries its start in the event's own time (s20261201T0930).
export const onTheHalfHour = (slot) => /T\d{2}(?:00|30)$/.test(String(slot?.id || ''));

// topUp: contacts in `existing` who kept one time after the other was booked; they get a second one.
export function assignSlots(ranked, slots, { max_offers = 3, per_slot = 1, existing = {}, topUp = [] } = {}) {
  const capacity = max_offers * per_slot;
  const count = Object.fromEntries(slots.map((s) => [s.id, 0]));
  const byId = Object.fromEntries(slots.map((s) => [s.id, s]));
  const assignments = {};
  for (const [cid, ids] of Object.entries(existing)) {
    const valid = ids.filter((id) => byId[id]);
    if (valid.length) {
      assignments[cid] = valid;
      valid.forEach((id) => {
        count[id]++;
      });
    }
  }
  // Slots with their own label and length (a dinner) are for the user to offer by hand, not auto-assigned.
  slots = slots.filter((s) => !s.label);
  const offGrid = slots.filter((s) => !onTheHalfHour(s)).length;
  slots = slots.filter(onTheHalfHour);
  const openAsk = [];
  // Offers spread over the days and the hours: the day and the hour offered least so far go first. Picking the
  // earliest free slot would bunch everyone into the first days, 30 minutes apart.
  const dayLoad = {},
    hourLoad = {};
  const hourOf = (x) => new Date(x.start).getUTCHours();
  const note = (x) => {
    dayLoad[x.day] = (dayLoad[x.day] || 0) + 1;
    hourLoad[hourOf(x)] = (hourLoad[hourOf(x)] || 0) + 1;
  };
  for (const ids of Object.values(assignments)) for (const id of ids) if (byId[id]) note(byId[id]);
  const order = (a, b) =>
    count[a.id] - count[b.id] ||
    (dayLoad[a.day] || 0) - (dayLoad[b.day] || 0) ||
    (hourLoad[hourOf(a)] || 0) - (hourLoad[hourOf(b)] || 0) ||
    Date.parse(a.start) - Date.parse(b.start);
  for (const cid of topUp) {
    const have = assignments[cid] || [];
    if (have.length !== 1) continue;
    const kept = byId[have[0]];
    const avail = slots.filter((s) => count[s.id] < capacity && s.id !== kept.id).sort(order);
    const second = avail.find((s) => s.day !== kept.day) || avail.find((s) => Math.abs(Date.parse(s.start) - Date.parse(kept.start)) >= TWO_HOURS);
    if (second) {
      assignments[cid] = [kept.id, second.id].sort((a, b) => Date.parse(byId[a].start) - Date.parse(byId[b].start));
      count[second.id]++;
      note(second);
    }
  }
  for (const c of ranked) {
    if (assignments[c.id]) continue;
    const avail = slots.filter((s) => count[s.id] < capacity).sort(order);
    let pick = null;
    for (const first of avail) {
      const second = avail.find((s) => s.day !== first.day && s.id !== first.id);
      if (second) {
        pick = [first, second];
        break;
      }
    }
    if (!pick) {
      for (const first of avail) {
        const second = avail.find((s) => s.id !== first.id && Math.abs(Date.parse(s.start) - Date.parse(first.start)) >= TWO_HOURS);
        if (second) {
          pick = [first, second];
          break;
        }
      }
    }
    if (!pick && avail.length) pick = [avail[0]];
    if (!pick) {
      openAsk.push(c.id);
      continue;
    }
    pick.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    assignments[c.id] = pick.map((s) => s.id);
    pick.forEach((s) => {
      count[s.id]++;
      note(s);
    });
  }
  // Who got fewer than two times to choose from, and how many free slots weren't offered for starting off the half hour.
  const shortOfTwo = ranked.map((c) => c.id).filter((id) => (assignments[id] || []).length === 1);
  return { assignments, openAsk, offers: count, capacity, off_grid: offGrid, short_of_two: shortOfTwo };
}

// Who else was offered each slot (for the outbox slot table and re-plan warnings).
export function holdersBySlot(assignments) {
  const out = {};
  for (const [cid, ids] of Object.entries(assignments)) for (const id of ids) (out[id] ||= []).push(cid);
  return out;
}
