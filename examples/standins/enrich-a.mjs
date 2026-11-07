#!/usr/bin/env node
// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Stand-in people-data tool, Apollo-like shape: one person matched by name and company (or LinkedIn URL), with a
// work email and its status when the data has one. Every match counts a "credit" in the data's log, so tests can
// see that no more lookups ran than the user agreed to. Also offers a bulk tool, which floorboss must never map.
import { serve, loadData, str, trap } from './lib/server.mjs';
import { appendFileSync } from 'node:fs';

const people = loadData().enrich?.people || [];
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

serve('enrich-a', {
  people_match: {
    description: 'Match one person by name and company (or LinkedIn URL) and return their work email if known. Uses one credit per email revealed.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, organization_name: { type: 'string' }, domain: { type: 'string' }, linkedin_url: { type: 'string' } },
      required: ['name']
    },
    run: (args) => {
      const name = norm(str(args, 'name'));
      const org = norm(args.organization_name);
      const p = people.find((x) => norm(x.name) === name && (!org || norm(x.company) === org || norm(x.company).includes(org)));
      if (process.env.STANDIN_LOG)
        appendFileSync(process.env.STANDIN_LOG, `${JSON.stringify({ tool: 'people_match', name: args.name, found: !!p, credit: !!p?.email })}\n`);
      if (!p) return { person: null };
      return {
        person: {
          name: p.name,
          title: p.title || null,
          organization: { name: p.company },
          email: p.email || null,
          email_status: p.email ? p.status || 'verified' : null,
          linkedin_url: p.linkedin_url || null
        }
      };
    }
  },
  bulk_people_enrichment: trap('Enrich up to 10 people at once.', { details: { type: 'array' } }, () => ({ matches: [] }))
});
