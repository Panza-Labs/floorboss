// The sixth simulated first-time tester's event, as their files had it: Ines Moreau of Paylark, a HubSpot export with a
// Lifecycle column and no opt-out column, coworkers Sam Okafor and Sofia Marin, Stockroom AI off-limits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, cli, fitAll, ROOT } from './harness.mjs';
import { makeHome, simplePersona } from '../sims/lib/driver.mjs';

export const ATTENDEES = `Full Name,Job Title,Organisation,Email Address,Notes
Lena Vogt,Head of Payments,Cartwise,lena.vogt@cartwise.example,
Tomás Rey,VP Partnerships,Shelfly,tomas@shelfly.example,
Felix Braun,CTO,Kassenwerk,felix.braun@kassenwerk.example,
Mira Holt,Director of Checkout,Basketry,mira.holt@basketry.example,
Noor Aziz,Head of Product,Basketry,noor.aziz@basketry.example,
Jonas Becker,COO,Retailio,jonas.becker@retailio.example,
Petra Lind,Head of eCommerce,Retailio,petra.lind@retailio.example,
Kate Lindqvist,Partnerships Manager,Tillmoss Labs,kate@tillmoss.example,
Ravi Menon,VP Engineering,Stockroom AI,ravi.menon@stockroom.example,
Julia Ferreira,Head of Partnerships,Aislewise,julia.ferreira@aislewise.example,
Henrik Stahl,CEO,Pickpack,henrik@pickpack.example,
Amara Osei,Director Retail Ops,Freshline Markets,amara.osei@freshline.example,
Daniel Kurz,Product Lead POS,Kassenwerk,daniel.kurz@kassenwerk.example,
Sofia Marin,Account Executive,Paylark,sofia.marin@paylark.example,
Oliver Grant,Head of Platform Partnerships,Cartwise,oliver.grant@cartwise.example,
Yuki Tanaka,Founder,Loopcart,yuki@loopcart.example,
`;
export const CRM = `Contact Name,Email,Account,Owner,Lifecycle,Notes
,,Kassenwerk,Ines Moreau,Customer,Account renews in Q1; their POS team asked about split-tender payments in September
Lena Vogt,lena.vogt@cartwise.example,Cartwise,Ines Moreau,Open Deal,Asked for pilot pricing for their marketplace payouts on the 12 Sept call
Tomás Rey,tomas@shelfly.example,Shelfly,Ines Moreau,Prospect,Interested in instant refunds for returns; wants to see the refunds API docs
Mira Holt,mira.holt@basketry.example,Basketry,Ines Moreau,Customer,
Jonas Becker,jonas.becker@retailio.example,Retailio,Sam Okafor,Open Deal,
Katherine Lindqvist,k.lindqvist@tillmoss.example,Tillmoss,Ines Moreau,Prospect,
Marco Bellini,marco@pickpack.example,Pickpack,Sam Okafor,Closed Lost,Lost on price March 2026
`;
export const MAPPING_SAID = "Lifecycle is the status column. Customer means customer, Open Deal is warm, Prospect means hold, Closed Lost is lost. And there's no opt-out column.";

// The simulated tester's run through the flow, answered as they answered (standard setup, the HubSpot export with "no
// opt-out column", two coworkers, an off-limits company). over: answers to change. Their files are written to
// the home first.
export function ftu6Flow(over = {}) {
  const H = makeHome({ context: { from: join(ROOT, 'examples/mock-event/context/buyers'), name: 'buyers' } });
  const list = join(H.HOME, 'work', 'attendees.csv'), crm = join(H.HOME, 'work', 'crm.csv');
  writeFileSync(list, ATTENDEES); writeFileSync(crm, CRM);
  const persona = simplePersona({ asks: {
    setup_level: 'standard, I have a CRM export with owners', list_source: `it's at ${list}, the organiser sent it`,
    crm_where: 'HubSpot, but it\'s not connected here. I exported it.', crm_export: `The export is at ${crm}. There's no opt-out column in it, we never added one.`,
    company: { own_company: 'Paylark', own_domains: ['paylark.example'] }, team: { works_alone: false, colleagues: ['Sam Okafor', 'Sofia Marin'] },
    dnc: { dnc: [], accounts: ['Stockroom AI'] }, map_columns_crm: MAPPING_SAID, crm_name: 'yes, Ines Moreau is me', coworker_contacts: 'leave them alone, and list them for me', customers: 'a warm note', lost_deals: '12 months', optout_known: 'yes, on every email',
    about_you: { sign_off: 'Best, Ines', sender_name: 'Ines Moreau, Paylark', city: 'Amsterdam' },
    // Kate Lindqvist is the one uncertain match (Katherine Lindqvist in the CRM): settled and warm, on one line.
    check_these: (s) => s.ask.people.map((p) => `${p.id} same-person ${(p.alternatives || []).find((a) => a.ref)?.ref || 'crm:5'} warm because we met at Tillcon in March`).join('\n'),
    company_research: 'skip company research', ...over } });
  return { H, persona };
}

// The event through the mapping (in the simulated tester's words), the load and the fits: everyone fits, so who is
// held or asked about comes from the CRM alone.
export function ftu6({ settings = {}, home = null, event = {} } = {}) {
  const H = setup({ home, event, attendees: ATTENDEES, crm: CRM, accounts: 'Company,Status\nStockroom AI,do not contact this company\n', settings: {
    own_company: 'Paylark', own_domains: ['paylark.example'], colleagues: ['Sam Okafor', 'Sofia Marin'], crm_user_name: 'Ines Moreau', coworker_contacts: 'leave', crm_accounts: 'apply', colleague_notes: false,
    customer_rule: { recent_months: 6, recent: 'warm', on_deal: 'warm', other: 'warm' }, ...settings } });
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'attendees']);
  cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'attendees', '--accept']);
  cli(H, 'crm-triage', ['propose-mapping', '--event', H.slug, '--kind', 'crm']);
  const words = join(H.HOME, 'mapping-words.txt'); writeFileSync(words, MAPPING_SAID);
  const m = cli(H, 'crm-triage', ['confirm-mapping', '--event', H.slug, '--kind', 'crm', '--words-file', words]);
  if (m.ERROR) throw new Error(m.ERROR);
  const load = cli(H, 'crm-triage', ['load', '--event', H.slug]);
  if (load.ERROR) throw new Error(load.ERROR);
  fitAll(H, load);
  return { ...H, load };
}
