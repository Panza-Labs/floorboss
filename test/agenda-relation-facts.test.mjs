// The agenda's "To you" line gives the relationship as facts (customer, the CRM's stage, proof customer), never
// the drafting instructions the company brief carries for the writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCompanyBrief, readCompanyBrief } from '../skills/attendee-research/scripts/companies.mjs';
import { renderMarkdown } from '../skills/event-outreach/scripts/agenda.mjs';

test('agenda: "To you" holds the facts only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-agenda-'));
  writeCompanyBrief(dir, 'Prairie Cold Storage', { sells: 'cold storage for food distributors', relation_to_us: 'customer', existing_vendors: 'none found', what_they_would_want: 'lower peak charges', do_not_tell_them: 'their own expansion', industry_news_none: 'nothing new', sources: ['https://prairie.example/about'] }, { customer: 'the CRM says "Closed Won"', proof: ['Prairie Cold Storage cut peak charges 18%'], has_crm: true });
  const brief = readCompanyBrief(dir, 'Prairie Cold Storage');
  assert.match(brief, /Write as to a customer/, 'the brief itself still tells the writer');
  const data = { event: { name: 'Midwest Expo' }, day: null, goal: null, meetings: [{ id: 'c001', time: 'Tue 17 Nov, 09:00', place: null, person: { name: 'Rachel Kim', title: 'Director of Facilities', company: 'Prairie Cold Storage' }, relation: {}, thread: { sent: [], received: [] }, company_brief: brief.replace(/\s+/g, ' '), news: [], profile: null }] };
  const md = renderMarkdown(data, new Map([['c001', { points: [{ text: 'x', from: 'brief' }], ask: 'y' }]]));
  const line = md.split('\n').find((l) => l.startsWith('- To you:'));
  assert.ok(line, md);
  assert.match(line, /^- To you: customer.*; your customer: the CRM says "Closed Won"; proof customer: your proof library names them \(Prairie Cold Storage cut peak charges 18%\)$/);
  assert.doesNotMatch(line, /Write as|never a cold pitch|Never quote|\*\*/);
});
