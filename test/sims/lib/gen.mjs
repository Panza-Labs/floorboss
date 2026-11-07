// Generated personas: a fictional attendee list, a CRM export, a do-not-contact list and an accounts list in
// one of several real-world shapes, from a seed, with the truth about every person kept apart. The truth is
// what the simulations check against: nobody marked "never" is shortlisted or written to, nobody a colleague
// holds gets a message, and the run finishes. Every name, company and address is invented (.test domains).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return { next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), pick: (l) => l[Math.floor(next() * l.length)], chance: (p) => next() < p, shuffle: (l) => { const a = [...l]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; } };
}

const FIRST = ['Ana', 'Bo', 'Chen', 'Dara', 'Eli', 'Farah', 'Goran', 'Hana', 'Ivo', 'Jules', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tomás', 'Uma', 'Viktor', 'Wen', 'Ximena', 'Yusuf', 'Zoë', 'Aiko', 'Björn', 'Carmen', 'Dmitri', 'Esra', 'Felix', 'Greta', 'Hiro', 'Inés', 'Jonas', 'Kavya', 'Luca', 'Maren', 'Nils', 'Olu', 'Paola', 'Rafael', 'Sana', 'Theo', 'Ulla', 'Vera', 'Wim', 'Yara', 'Zain'];
const LAST = ['Abara', 'Berg', 'Castillo', 'Dubois', 'Eriksen', 'Fischer', 'García', 'Haddad', 'Ito', 'Jansen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quintero', 'Rossi', 'Schmidt', 'Tanaka', 'Usman', 'Varga', 'Weber', 'Xu', 'Yilmaz', 'Zielinski', 'Achterberg', 'Brennan', 'Costa', 'Delacroix', 'Ekström', 'Falk', 'Gruber', 'Holm', 'Iqbal', 'Jovanović', 'Kim', 'Laurent', 'Müller', 'Novak', 'Olawale', 'Pérez', 'Reyes', 'Sørensen', 'Torres', 'Ueda', 'Vogel', 'Walsh', 'Yamada', 'Zhou'];
const NICK = { Jules: 'Julian', Bo: 'Bodil', Theo: 'Theodor', Luca: 'Lucas', Wim: 'Willem', Eli: 'Elias' };

export const INDUSTRIES = {
  logistics: { pre: ['Harbor', 'Northgate', 'Bluewater', 'Ironline', 'Keel', 'Merriton', 'Tidal', 'Crossdock'], suf: ['Freight', 'Logistics', 'Shipping', 'Cargo', 'Haulage', '3PL'], fit: ['VP Operations', 'Head of Warehouse Operations', 'Director of Logistics', 'COO', 'Head of Transport', 'Supply Chain Director'], weak: ['Marketing Coordinator', 'HR Business Partner', 'Accountant', 'Sales Intern', 'Office Manager', 'IT Support'] },
  fintech: { pre: ['Larch', 'Cedar', 'Summit', 'Granite', 'Silverline', 'Cobalt', 'Harbourside', 'Northfield'], suf: ['Bank', 'Pay', 'Credit Union', 'Capital', 'Financial', 'Payments'], fit: ['Head of Fraud', 'VP Financial Crimes', 'Chief Risk Officer', 'Director of AML', 'Head of Payments Risk', 'BSA Officer'], weak: ['Branch Manager', 'Marketing Analyst', 'Recruiter', 'Teller Supervisor', 'Social Media Lead', 'Facilities Manager'] },
  devtools: { pre: ['Stackly', 'Bytewise', 'Forge', 'Lattice', 'Quanta', 'Orbit', 'Patchwork', 'Kernel'], suf: ['Labs', 'Systems', 'Software', 'Cloud', 'IO', 'AI'], fit: ['VP Engineering', 'Head of Platform', 'Staff Engineer', 'CTO', 'Engineering Manager', 'Director of Developer Experience'], weak: ['Community Manager', 'Account Executive', 'Office Coordinator', 'Recruiter', 'Designer', 'Student'] },
  health: { pre: ['Mercy', 'Riverbend', 'Lumen', 'Cedar', 'Haven', 'Clearview', 'Northstar', 'Willow'], suf: ['Health', 'Clinics', 'Medical Group', 'Hospital', 'Care', 'Diagnostics'], fit: ['Chief Medical Information Officer', 'VP Clinical Operations', 'Director of Nursing Informatics', 'CIO', 'Head of Revenue Cycle', 'Director of Patient Access'], weak: ['Receptionist', 'Volunteer Coordinator', 'Marketing Specialist', 'Billing Clerk', 'Chaplain', 'Student Nurse'] },
  retail: { pre: ['Maple', 'Urban', 'Golden', 'Fresh', 'Coastal', 'Brightside', 'Oak', 'Little'], suf: ['Grocers', 'Outfitters', 'Market', 'Stores', 'Goods', 'Brands'], fit: ['VP Ecommerce', 'Head of Store Operations', 'Director of Merchandising', 'Chief Digital Officer', 'Head of Loyalty', 'VP Supply Chain'], weak: ['Store Associate', 'Visual Merchandiser', 'HR Assistant', 'Cashier Lead', 'Brand Ambassador', 'Intern'] },
};
const NONBUYERS = [['Press', 'Reporter', 'Freight Weekly'], ['Vendor', 'Account Executive', 'Rivalware'], ['Student', 'MBA Candidate', 'Lakeside University'], ['Regulator', 'Examiner', 'State Banking Department']];

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

// The knobs a persona sets. Everything has a default, so a persona states only what makes it different.
export function generate(o) {
  const r = rng(o.seed || 1);
  const ind = INDUSTRIES[o.industry || 'logistics'];
  const own = o.own || { company: 'Lanecraft', domain: 'lanecraft.test', colleagues: ['Sam Rivera'] };
  const companies = [];
  const nCo = o.companies || 30;
  const seenCo = new Set();
  const QUAL = ['', 'North', 'West', 'Pacific', 'Atlantic', 'Central', 'United', 'First', 'Royal', 'Metro'];
  let tries = 0;
  while (companies.length < nCo) {
    // Past the plain combinations, a qualifier makes the name new ("First Larch Bank").
    const q = tries++ > 200 ? `${QUAL[1 + (tries % (QUAL.length - 1))]} ` : '';
    const name = `${q}${r.pick(ind.pre)} ${r.pick(ind.suf)}`;
    if (seenCo.has(name)) { if (tries > 5000) throw new Error(`can't make ${nCo} distinct company names`); continue; }
    seenCo.add(name);
    const big = r.chance(o.bigShare ?? 0.2);
    companies.push({ name, domain: `${slug(name)}.test`, big, band: big ? r.pick(['large', 'enterprise']) : r.pick(['micro', 'small', 'small', 'mid', 'mid']) });
  }
  // People: fits and weak titles at target companies, some non-buyers, colleagues and own-company staff.
  const people = [];
  const usedNames = new Set();
  const person = (company, title, extra = {}) => {
    let first, last, key;
    do { first = r.pick(FIRST); last = r.pick(LAST); key = `${first} ${last}`; } while (usedNames.has(key));
    usedNames.add(key);
    const email = r.chance(o.missingEmail ?? 0.05) ? '' : `${slug(first)}.${slug(last)}@${company.domain}`;
    // LinkedIn links and connections are drawn only for personas that ask for them (others keep their data).
    const linkedin = o.linkedinShare && (r.chance(o.linkedinShare) || !email) ? `https://www.linkedin.com/in/${slug(first)}-${slug(last)}` : '';
    const connected = o.linkedinShare ? r.chance(o.connectedShare ?? 0.3) : false;
    // truthEmail: the address a people-data tool would find for someone the list has no email for.
    const p = { first, last, name: key, title, company: company.name, domain: company.domain, band: company.band || null, email, truthEmail: email || `${slug(first)}.${slug(last)}@${company.domain}`, linkedin, connected, truth: 'ok', why: [], ...extra };
    people.push(p);
    return p;
  };
  const n = o.n || 120;
  while (people.length < n) {
    const co = r.pick(companies);
    const fit = r.chance(o.fitShare ?? 0.55);
    person(co, fit ? r.pick(ind.fit) : r.pick(ind.weak), { fit });
    if (co.big && r.chance(0.5)) person(co, r.pick(ind.fit), { fit: true });
  }
  for (const [type, title, company] of NONBUYERS.slice(0, o.nonbuyers ?? 2)) person({ name: company, domain: `${slug(company)}.test` }, title, { fit: false, attendee_type: type });
  // Own company and colleagues on the list: never written to.
  const ownCo = { name: own.company, domain: own.domain };
  for (const c of own.colleagues || []) { const [first, ...rest] = c.split(' '); people.push({ first, last: rest.join(' '), name: c, title: 'Account Executive', company: own.company, domain: own.domain, email: `${slug(first)}.${slug(rest.join(' '))}@${own.domain}`, truth: 'never', why: ['own company'], fit: false }); }
  person(ownCo, 'Solutions Engineer', { fit: false, truth: 'never', why: ['own company'] });

  // The CRM: a share of the list, plus records for people not on it.
  const crm = [];
  const crmShare = o.crm === false ? 0 : (o.crmShare ?? 0.35);
  const statuses = STATUS_SETS[o.crmStyle || 'salesforce'];
  const owners = [own.user || 'Sam Rivera', ...(own.colleagues || []).filter((c) => c !== (own.user || 'Sam Rivera'))];
  for (const p of people.filter((x) => x.truth === 'ok' && x.email)) {
    if (!r.chance(crmShare)) continue;
    const st = r.pick(statuses);
    const owner = r.chance(o.colleagueOwnShare ?? 0.25) && owners.length > 1 ? r.pick(owners.slice(1)) : owners[0];
    const rec = { p, status: st.v, owner, optout: false, note: '', last: `2026-${String(r.int(1, 9)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}` };
    if (st.truth === 'never') { p.truth = 'never'; p.why.push(`CRM status ${st.v}`); }
    if (owner !== owners[0] && p.truth === 'ok') { p.truth = 'colleague'; p.holder = owner; p.why.push(`owned by ${owner}`); }
    crm.push(rec);
  }
  // Opt-outs and stop notes, in whichever column the export has them.
  const crmOk = crm.filter((x) => x.p.truth === 'ok');
  for (const x of r.shuffle(crmOk).slice(0, o.optouts ?? 3)) { x.optout = true; x.p.truth = 'never'; x.p.why.push('opted out in the CRM'); }
  for (const x of r.shuffle(crm.filter((y) => y.p.truth === 'ok')).slice(0, o.stopNotes ?? 2)) { x.note = r.pick(STOP_NOTES[o.lang || 'en']); x.p.truth = 'never'; x.p.why.push(`note: ${x.note}`); }
  // Do-not-contact list and off-limits accounts.
  const dnc = [];
  for (const p of r.shuffle(people.filter((x) => x.truth === 'ok' && x.email)).slice(0, o.dnc ?? 2)) { dnc.push(p.email); p.truth = 'never'; p.why.push('do-not-contact list'); }
  const accounts = [];
  if (o.offLimits) for (const co of r.shuffle(companies).slice(0, o.offLimits)) { accounts.push({ company: co.name, status: 'no-poach partner' }); for (const p of people.filter((x) => x.company === co.name)) { p.truth = 'never'; p.why.push('off-limits account'); } }
  // Duplicate rows: the same person scanned twice, sometimes under a nickname or a personal address.
  const dupes = [];
  for (const p of r.shuffle(people.filter((x) => x.email && x.truth !== 'never')).slice(0, o.dupes ?? 3)) {
    const nick = NICK[p.first];
    dupes.push({ ...p, first: nick || p.first, name: `${nick || p.first} ${p.last}`, email: r.chance(0.5) ? p.email.toUpperCase() : `${slug(p.first)}${r.int(1, 99)}@gmail.test`, dupe_of: p.name });
  }
  return { people, dupes, crm, dnc, accounts, companies, own, ind, o };
}

const STATUS_SETS = {
  salesforce: [{ v: 'Prospecting' }, { v: 'Qualification' }, { v: 'Negotiation' }, { v: 'Closed Won' }, { v: 'Closed Lost' }, { v: 'Nurture' }],
  hubspot: [{ v: 'Lead' }, { v: 'Marketing Qualified Lead' }, { v: 'Sales Qualified Lead' }, { v: 'Opportunity' }, { v: 'Customer' }, { v: 'Other' }, { v: 'Subscriber' }],
  german: [{ v: 'Interessent' }, { v: 'Angebot' }, { v: 'Kunde' }, { v: 'Verloren' }, { v: 'Kein Kontakt erwünscht', truth: 'never' }, { v: 'Partner' }],
  sheet: [{ v: 'met at expo 2025' }, { v: 'talking' }, { v: 'said no' }, { v: 'client' }, { v: 'dont email', truth: 'never' }, { v: '' }],
};
const STOP_NOTES = {
  en: ['Asked us to stop emailing', 'Please remove me from your list', 'Do not contact again - legal', 'unsubscribe request 03/2026'],
  de: ['Bitte keine E-Mails mehr', 'Möchte nicht kontaktiert werden', 'Abgemeldet, nicht mehr anschreiben'],
};

// The files, in the persona's shapes.
export function writeFiles(g, dir) {
  mkdirSync(dir, { recursive: true });
  const o = g.o;
  const r = rng((o.seed || 1) + 7);
  const d = o.delimiter || ',';
  const q = (v) => { const s = String(v ?? ''); return s.includes(d) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = (headers, rows) => `${o.bom ? '﻿' : ''}${[headers, ...rows].map((row) => row.map(q).join(d)).join(o.crlf ? '\r\n' : '\n')}\n`;
  const rows = r.shuffle([...g.people, ...g.dupes]);
  const A = ATTENDEE_SHAPES[o.listStyle || 'plain'];
  writeFileSync(join(dir, 'attendees.csv'), csv(A.headers, rows.map((p) => A.row(p, r))));
  if (o.crm !== false) {
    const C = CRM_SHAPES[o.crmStyle || 'salesforce'];
    const extra = Array.from({ length: o.crmExtra ?? 10 }, (_, i) => ({ p: { first: r.pick(FIRST), last: `${r.pick(LAST)}-${i}`, name: '', title: 'Manager', company: r.pick(g.companies).name, email: `x${i}@elsewhere.test` }, status: r.pick(STATUS_SETS[o.crmStyle || 'salesforce']).v, owner: 'Sam Rivera', optout: false, note: '', last: '2025-11-02' }));
    writeFileSync(join(dir, 'crm.csv'), csv(C.headers, [...g.crm, ...extra].map((x) => C.row(x))));
  }
  if (g.dnc.length) writeFileSync(join(dir, 'dnc.txt'), g.dnc.join('\n') + '\n');
  if (g.accounts.length) writeFileSync(join(dir, 'accounts.csv'), `Company,Owner,Status\n${g.accounts.map((a) => `${a.company},Partnerships,${a.status}`).join('\n')}\n`);
  return dir;
}

const ATTENDEE_SHAPES = {
  plain: { headers: ['Name', 'Title', 'Company', 'Email'], row: (p) => [p.name, p.title, p.company, p.email] },
  // A Grip-style export: a LinkedIn column, emails only for people who shared them.
  grip: { headers: ['First Name', 'Last Name', 'Job Title', 'Company', 'Email', 'LinkedIn', 'Country'], row: (p, r) => [p.first, p.last, p.title, p.company, p.email, p.linkedin || '', r.pick(['US', 'GB', 'DE'])] },
  eventapp: { headers: ['First Name', 'Last Name', 'Job Title', 'Organization', 'Email Address', 'Country', 'Registration Type', 'Sessions'], row: (p, r) => [p.first, p.last, p.title, p.company, p.email, r.pick(['DE', 'NL', 'US', 'GB']), p.attendee_type || 'Delegate', 'Keynote; Track B'] },
  german: { headers: ['Vorname', 'Nachname', 'Position', 'Firma', 'E-Mail', 'Land'], row: (p, r) => [p.first, p.last, p.title, p.company, p.email, r.pick(['Deutschland', 'Österreich', 'Schweiz'])] },
  messy: { headers: ['Full name ', 'Company / Org', 'e-mail', 'Role', 'Notes', '', 'Badge #'], row: (p, r) => [`  ${p.name} `, p.company, r.chance(0.3) ? p.email.toUpperCase() : p.email || 'N/A', p.title, r.chance(0.1) ? 'met briefly last year' : '', '', String(r.int(1000, 9999))] },
  badge: { headers: ['Lead ID', 'Captured', 'First', 'Last', 'Company', 'Title', 'Email', 'Phone', 'Rating', 'Comments'], row: (p, r) => [String(r.int(10000, 99999)), '2026-10-01 10:12', p.first, p.last, p.company, p.title, p.email, r.chance(0.5) ? `+1 555 01${r.int(10, 99)}` : '', r.pick(['Hot', 'Warm', 'Cold', '']), ''] },
};

const CRM_SHAPES = {
  salesforce: { headers: ['First Name', 'Last Name', 'Title', 'Account Name', 'Email', 'Contact Owner', 'Lead Status', 'Last Activity', 'Email Opt Out', 'Description'], row: (x) => [x.p.first, x.p.last, x.p.title, x.p.company, x.p.email, x.owner, x.status, x.last.replace(/(\d+)-(\d+)-(\d+)/, '$2/$3/$1'), x.optout ? '1' : '0', x.note] },
  hubspot: { headers: ['First Name', 'Last Name', 'Email', 'Company Name', 'Number of Employees', 'Contact owner', 'Lifecycle Stage', 'Last Activity Date', 'Unsubscribed from all email', 'Notes'], row: (x) => [x.p.first, x.p.last, x.p.email, x.p.company, { micro: '5', small: '30', mid: '250', large: '2000', enterprise: '25000' }[x.p.band] || '', x.owner, x.status, `${x.last} 14:03`, x.optout ? 'true' : 'false', x.note] },
  german: { headers: ['Vorname', 'Nachname', 'E-Mail', 'Firma', 'Betreuer', 'Status', 'Letzter Kontakt', 'Kein Newsletter', 'Notiz'], row: (x) => [x.p.first, x.p.last, x.p.email, x.p.company, x.owner, x.status, x.last.replace(/(\d+)-(\d+)-(\d+)/, '$3.$2.$1'), x.optout ? 'ja' : 'nein', x.note] },
  sheet: { headers: ['who', 'company', 'email', 'status', 'owner', 'notes'], row: (x) => [`${x.p.first} ${x.p.last}`, x.p.company, x.p.email, x.optout ? 'unsubscribed' : x.status, x.owner.split(' ')[0], x.note] },
};
