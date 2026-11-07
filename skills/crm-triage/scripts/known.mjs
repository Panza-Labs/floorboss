// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// A contacts export the user gives (LinkedIn Connections.csv, Gmail or Outlook contacts): people they already
// talk to. Each becomes { name, email, emails_seen, company, company_key, date, stopped, source }.
import { readFileSync } from 'node:fs';
import { readCsvText, decode } from '../../../lib/csv.mjs';
import { companyKey, emailsIn } from '../../../lib/normalize.mjs';
import { parseDate, optedOut } from './sources.mjs';

const pick = (headers, re) => headers.find((h) => re.test(h.trim()));

export function readKnown(path) {
  // LinkedIn's Connections.csv opens with a "Notes:" paragraph before the header row.
  const { text } = decode(readFileSync(path));
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /(^|,)\s*"?(first name|name|full name|e-?mail( address)?|display name)"?\s*(,|$)/i.test(l));
  const { headers, records } = readCsvText(at > 0 ? lines.slice(at).join('\n') : text);
  const name = pick(headers, /^(name|full name|display name|contact)$/i);
  const first = pick(headers, /^(first name|given name|vorname|prénom|nombre)$/i);
  const last = pick(headers, /^(last name|family name|surname|nachname|nom|apellido)$/i);
  const mailCols = headers.filter((h) => /mail/i.test(h));
  const company = pick(headers, /^(company|organi[sz]ation( name)?|organi[sz]ation 1 - name|employer|firma|empresa)$/i);
  const date = pick(headers, /connected on|last (contact|contacted|email|message|interaction)|date/i);
  const unsub = pick(headers, /unsubscribed|opted.?out|do not contact|dnc/i);
  return records
    .map((r) => {
      const n = (name && r[name]) || [first && r[first], last && r[last]].filter(Boolean).join(' ');
      const all = [...new Set(mailCols.flatMap((h) => emailsIn(r[h])))];
      const email = all[0] || null;
      const co = company ? r[company] : '';
      if (!n && !email) return null;
      return {
        name: n || '',
        email,
        emails_seen: all.slice(1),
        company: co || '',
        company_key: co ? companyKey(co) : null,
        date: date ? parseDate(r[date]) : null,
        stopped: unsub ? optedOut(r[unsub], 'optout') : false,
        source: 'your contacts'
      };
    })
    .filter(Boolean);
}
