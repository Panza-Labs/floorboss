// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Column mapping for a file the user gives (an attendee list, a CRM export): what each column means, what
// each status value means, and which cells say "stop". floorboss proposes from column names and sample
// values; the user confirms once; the confirmed mapping is stored in sources/<fingerprint>.json and reused
// for every later file with the same header. Nothing is dropped in silence: every column the mapping
// ignores is listed back, and any column whose cells say stop is read as a note whatever it is called.
import { bandOf } from './sizes.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../../../lib/jsonio.mjs';

// Accents folded ("Zuständiger" is "zustandiger", "Größe" is "grosse") before anything else is dropped.
const norm = (h) =>
  String(h)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

export const FIELDS = {
  attendees: [
    'name',
    'first_name',
    'last_name',
    'title',
    'company',
    'email',
    'profile_url',
    'phone',
    'notes',
    'location',
    'booth',
    'attendee_type',
    'contact_opt_in',
    'company_size',
    'ignore'
  ],
  crm: [
    'name',
    'first_name',
    'last_name',
    'title',
    'company',
    'email',
    'profile_url',
    'phone',
    'notes',
    'owner',
    'status',
    'status_2',
    'last_contact',
    'won_at',
    'rejected_at',
    'deal',
    'deal_stage',
    'opted_out',
    'crm_id',
    'company_size',
    'ignore'
  ]
};

// The prior for the proposal: what a column is usually called. Only a guess; the user's confirmation rules.
const ALIASES = {
  attendees: {
    name: [
      'name',
      'fullname',
      'attendee',
      'attendeename',
      'contactname',
      'person',
      'who',
      'participant',
      'participantname',
      'teilnehmer',
      'teilnehmername',
      'nombrecompleto',
      'nomcomplet',
      'nameandsurname'
    ],
    first_name: ['firstname', 'givenname', 'forename', 'first', 'vorname', 'nombre', 'prenom', 'nome'],
    last_name: ['lastname', 'surname', 'familyname', 'last', 'nachname', 'familienname', 'apellido', 'apellidos', 'nom', 'sobrenome', 'cognome'],
    title: [
      'title',
      'jobtitle',
      'position',
      'role',
      'designation',
      'jobrole',
      'jobposition',
      'jobfunction',
      'function',
      'funktion',
      'positionbezeichnung',
      'berufsbezeichnung',
      'cargo',
      'puesto',
      'fonction',
      'poste'
    ],
    company: [
      'company',
      'companyname',
      'organisation',
      'organization',
      'org',
      'employer',
      'account',
      'accountname',
      'exhibitor',
      'exhibitorname',
      'co',
      'firma',
      'unternehmen',
      'empresa',
      'societe',
      'entreprise',
      'organisationname',
      'organizationname',
      'institution',
      'affiliation'
    ],
    email: ['email', 'emailaddress', 'workemail', 'businessemail', 'mail', 'emailadresse', 'correo', 'correoelectronico', 'courriel'],
    profile_url: ['profileurl', 'linkedin', 'linkedinurl', 'linkedinprofile', 'profile', 'profilelink', 'url', 'website'],
    phone: [
      'phone',
      'phonenumber',
      'mobile',
      'mobilephone',
      'cell',
      'cellphone',
      'whatsapp',
      'whatsappnumber',
      'telefono',
      'telephone',
      'tel',
      'telefon',
      'handy',
      'handynummer',
      'mobilnummer',
      'telefonnummer',
      'movil',
      'celular',
      'portable'
    ],
    notes: [
      'notes',
      'note',
      'bio',
      'biography',
      'about',
      'aboutme',
      'comments',
      'summary',
      'description',
      'anmerkungen',
      'notizen',
      'notiz',
      'bemerkung',
      'bemerkungen',
      'lookingfor',
      'looking'
    ],
    location: ['country', 'location', 'city', 'region', 'countryregion', 'land', 'pais', 'pays', 'ort', 'stadt'],
    booth: ['booth', 'stand', 'boothnumber', 'standnumber', 'hall', 'exhibitorstand', 'boothno', 'standno'],
    attendee_type: ['attendeetype', 'participanttype', 'registrationtype', 'tickettype', 'badgetype', 'category', 'type', 'segment', 'roletype'],
    company_size: [
      'companysize',
      'employees',
      'numberofemployees',
      'noofemployees',
      'employeecount',
      'headcount',
      'companyheadcount',
      'staffcount',
      'employeerange',
      'sizerange',
      'companysizerange',
      'anzahlmitarbeiter',
      'mitarbeiterzahl',
      'unternehmensgrosse',
      'unternehmensgroesse',
      'empleados',
      'numerodeempleados',
      'effectif',
      'taille',
      'accountsize',
      'segmentsize'
    ],
    contact_opt_in: [
      'matchmakingoptin',
      'matchmaking',
      'meetingoptin',
      'networkingoptin',
      'optin',
      'contactable',
      'opentomeetings',
      'allowmeetings',
      'meetingrequests',
      'consent',
      'contactconsent',
      'meetingconsent',
      'einwilligung',
      'einwilligungkontakt',
      'kontakterlaubt',
      'consentimiento',
      'consentement',
      'opentonetworking',
      'acceptsmeetings'
    ]
  },
  crm: {
    name: [
      'name',
      'fullname',
      'contactname',
      'candidatename',
      'candidate',
      'personname',
      'person',
      'who',
      'contact',
      'kontakt',
      'kontaktname',
      'nombre',
      'nom'
    ],
    first_name: ['firstname', 'givenname', 'vorname'],
    last_name: ['lastname', 'surname', 'familyname', 'nachname'],
    email: ['email', 'emailaddress', 'workemail', 'candidateemail', 'primaryemail', 'personemail'],
    company: [
      'company',
      'companyname',
      'account',
      'accountname',
      'organisation',
      'organization',
      'associatedcompany',
      'currentcompany',
      'currentemployer',
      'employer',
      'firma'
    ],
    title: ['title', 'jobtitle', 'currenttitle', 'headline', 'position'],
    owner: [
      'owner',
      'contactowner',
      'dealowner',
      'accountowner',
      'recordowner',
      'relationshipholder',
      'holder',
      'recruiter',
      'betreuer',
      'kundenbetreuer',
      'zustandigermitarbeiter',
      'zustaendigermitarbeiter',
      'betreuendermitarbeiter',
      'verantwortlich',
      'zustandig',
      'zustaendig',
      'bearbeiter',
      'accountmanager',
      'salesrep',
      'rep',
      'propietario',
      'responsable'
    ],
    status: [
      'status',
      'stage',
      'dealstage',
      'lifecyclestage',
      'lifecycle',
      'lifecyclestatus',
      'leadstatus',
      'leadstage',
      'pipelinestage',
      'contactstage',
      'candidatestage',
      'relationship',
      'label',
      'labels',
      'contactlabel',
      'phase',
      'stufe',
      'estado',
      'etape'
    ],
    crm_id: ['recordid', 'contactid', 'id', 'personid', 'leadid', 'candidateid', 'hsobjectid'],
    last_contact: [
      'letztenderung',
      'letzteanderung',
      'letzterkontakt',
      'zuletztkontaktiert',
      'ultimocontacto',
      'lastcontact',
      'lastcontacted',
      'lastactivitydate',
      'lastactivity',
      'lastcontactdate',
      'lastengagementdate'
    ],
    profile_url: ['linkedin', 'linkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'profileurl', 'personlinkedinurl'],
    phone: ['phone', 'phonenumber', 'mobile', 'mobilephone'],
    notes: [
      'notes',
      'note',
      'comments',
      'comment',
      'description',
      'remarks',
      'notizen',
      'notiz',
      'bemerkung',
      'bemerkungen',
      'kommentar',
      'anmerkung',
      'notas',
      'commentaire',
      'commentaires'
    ],
    won_at: ['closedate', 'closewondate', 'dealclosedate', 'wondate', 'datewon', 'customersince', 'becameacustomerdate', 'dateclosed', 'closedwondate'],
    rejected_at: ['rejecteddate', 'daterejected', 'rejectedon', 'rejectiondate', 'disqualifieddate', 'archiveddate', 'dateclosedlost'],
    deal: ['associateddeal', 'associateddeals', 'dealname', 'deal', 'deals', 'opportunity', 'opportunityname', 'wondeal', 'dealtitle', 'opportunitytitle'],
    // Where the deal stands (won, lost, a pipeline stage), apart from the person's own status. "Deal Stage" alone
    // in a file is its status column; next to a lifecycle or lead status it is this (see propose).
    deal_stage: ['dealstage', 'dealstatus', 'opportunitystage', 'opportunitystatus', 'stageofdeal', 'dealresult', 'dealoutcome', 'wonlost'],
    company_size: [
      'companysize',
      'employees',
      'numberofemployees',
      'noofemployees',
      'employeecount',
      'headcount',
      'companyheadcount',
      'staffcount',
      'employeerange',
      'sizerange',
      'companysizerange',
      'anzahlmitarbeiter',
      'mitarbeiterzahl',
      'unternehmensgrosse',
      'unternehmensgroesse',
      'empleados',
      'numerodeempleados',
      'effectif',
      'taille',
      'accountsize',
      'segmentsize'
    ],
    opted_out: [
      'unsubscribedfromallemail',
      // A marketing or subscription status ("Subscribed", "Unsubscribed") says who opted out, not who someone is.
      'marketingstatus',
      'emailmarketingstatus',
      'subscriptionstatus',
      'emailsubscriptionstatus',
      'unsubscribed',
      'optedout',
      'optout',
      'emailoptout',
      'hasoptedoutofemail',
      'donotemail',
      'donotcontact',
      'keinnewsletter',
      'newsletterabgemeldet',
      'abgemeldet',
      'keinewerbung',
      'werbewiderspruch',
      'keinemails',
      'keineemails',
      'nocontactar',
      'baja',
      'desinscrit',
      'nepascontacter'
    ]
  }
};

// Words in a cell that mean "leave this person alone". Read in every column, whatever its name.
export const STOP_WORDS =
  /\b(bitte keine (weiteren )?(e-?mails?|mails?|werbung|nachrichten|anrufe)|keine (weiteren )?(e-?mails?|mails?) (mehr|erhalten)|m[oö]chte keine (e-?mails?|mails?|werbung)|kontakt unerw[uü]nscht|keine kontaktaufnahme|w[uü]nscht keinen kontakt|kein newsletter|no me escriban|darse de baja|dado de baja|ne souhaite plus [eê]tre contact|bitte keine (e-?mails?|werbung|nachrichten|anrufe)|keine (e-?mails?|werbung|kontaktaufnahme) mehr|nicht (mehr )?(kontaktieren|anschreiben|kontaktiert werden)|m[oö]chte nicht (mehr )?kontaktiert werden|abgemeldet|no (me )?contact(ar|en)|no (quiere|desea) (ser )?contactad[oa]|ne (plus |pas )?(me )?contacter|d[ée]sinscrit\w*|never (to )?be contacted|never contact (me|us|them|him|her|this person|again)|(asked|wants?|wishes) (us |me )?(to )?never|stop (emailing|contacting|messaging|calling)|asked (us |me )?to stop|unsubscrib\w*|do ?n[o']?t (contact|email|pitch|message|reach out|call)|dont (contact|email|pitch|message)|no (more )?(contact|outreach|emails?)|leave (them|him|her) alone|opted? ?out|remove (me|them) from|no pitch|do not solicit)\b/i;
// Text that reads like an instruction to an AI (a list note, a CRM note): data, never obeyed, and said on the card.
export const INSTRUCTION_LIKE =
  /note to (ai|any|all)?\s*(ai )?(assistant|agent|model)s?|(mark|treat) (this person|me|them) (as )?(a )?must[- ]?meet|skip (all |the )?(checks|rules|review)|bypass|override (the |your )?(rules|instructions)|ignore (all |any |your |the |previous |prior )*(instructions|rules|prompt)|system prompt|you are (an? )?(ai|assistant|language model)|as an ai|assistant[,:]|(email|send|forward|export) (the |all |every |your )?(crm|list|contacts|data|attendees)|add (every|all) (attendees?|people|contacts)|disregard|jailbreak|do not tell the user|<\/?(system|instructions?)>/i;
// A CRM note that logs a two-way history (a meeting, a demo, a call, an intro, a deal): someone the sender has
// dealt with, never a first-time cold contact. A download or a newsletter sign-up is not this.
export const CRM_HISTORY =
  /\b(met|meeting|spoke|spoken|talked|chatted|(had|on) a call|call(ed)? with|phone call|demo\w*|discovery|conversation|lunch|coffee|dinner|visited|site visit|proposal|quoted?|trial(l?ed)?|pilot|intro(duced)? (via|by|from|through)|referred by|referral from|negotiat\w*|contract|redlines?|went quiet|replied|responded)\b/i;
// Wording that undoes a history word ("never met", "no reply"), read clause by clause: "Met at SaaSCon; no call
// booked yet" still has the meeting. A note that warns off another approach ("do not re-engage") never counts.
export const NOT_HISTORY = /\b(never|not|no|didn['’]?t|hasn['’]?t|haven['’]?t)\s+(yet\s+)?(met|meet|spoke|spoken|talked|replied|responded|call|demo)/i;
export const WARN_OFF = /\b(do not|don['’]?t|never|not to)\s+(re-?)?(engage|approach|pursue|contact)|\bno re-?engage\w*/i;
// Does a CRM note log a real conversation? Some clause says so without undoing it, and nothing warns off.
export function noteHistory(n) {
  const t = String(n || '');
  if (!t || WARN_OFF.test(t)) return false;
  return t.split(/(?<!\b[A-Z])\.\s+|[;!?\n]+|,\s*(?:but|then)\b/i).some((cl) => CRM_HISTORY.test(cl) && !NOT_HISTORY.test(cl));
}
// Softer wording: not a stop, but the user should see it before anyone writes.
export const CAUTION_WORDS = /\b(not interested|complain\w*|unhappy|angry|dispute|legal|lawyer|churn\w*|cancel\w*|competitor)\b/i;

// What a status value usually means, from the words in it. The proposal only; the user confirms per value.
const HOLD =
  /do not|don'?t (contact|email|call)|dnc|blacklist|block|on hold|\bhold\b|quiet|complian|legal|litig|lawsuit|dispute|tender|no consent|consent withdrawn|embargo|conflict|at risk|churn|cancel|escalat|unsub|opted?.?out|bounce|invalid|spam|complain|gdpr|erase|delet|remov|not to be|no contact|former (customer|client)|ex-?(customer|client)|past (customer|client)|competitor|banned|suspend|hired|employee|no.?poach|non.?solicit|do not (hire|poach|approach|recruit)/i;
const DO_NOT_CONTACT =
  /do not (contact|e-?mail|mail|call|reach out)|don'?t (e-?mail|mail)|unerw[uü]nscht|keine? kontakt\w*|kein(en)? kontakt|nicht (mehr )?(kontaktieren|anschreiben)|no contactar|ne pas contacter|don'?t contact|not to be contacted|asked (us )?(not to|to stop)|stop (contact|email)|dnc|unsub|opted?.?out|no contact|never contact|blacklist|gdpr|erase|remov/i;
const LOST =
  /\b(lost|closed[- ]?lost|not qualified|unqualified|disqualified|not converted|bad fit|junk|reject\w*|declin\w*|passed|withdrawn|not interested|no budget|recycl\w*|archiv\w*|bad timing)\b/i;
const CUSTOMER = /\b(customer|client|closed[- ]?won|won|paying|active account|renewal)\b/i;
// A live partner ("Partner - active", "Active partner") is a relationship of the sender's, like a customer; a bare
// "Partner" can name whoever holds the record (a partner of the firm), so it stays a colleague's until the user says.
// "Partner - not active", "Former partner": a partner word with a live word, said in the negative, isn't live.
const NOT_LIVE = /\b(not|no longer|non-?active|former|ex|inactive|churn\w*|lapsed|paused|pending|prospective|potential)\b/i;
const LIVE_PARTNER = /\bpartner\w*\b.*\b(active|live|current|signed|won)\b|\b(active|live|current|signed)\s+(channel |referral |reseller )?partner/i;
const COORDINATE = /\bpartner/i;
const TWO_WAY =
  /\b(spoke|spoken|met|talked|had a call|call held|replied|responded|in touch|in conversation|negotiat\w*|proposal|price quote|contract|demo|discovery|qualif\w*|needs analysis|decision maker|presentation|appointment|meeting|evaluat\w*|trial|pilot|poc|sql|sales qualified|engaged|interested|hot|warm|working|connected|in progress|opportunit\w*|open deal|screen\w*|interview\w*|onsite|offer|reference)\b/i;
const ONE_WAY =
  /\b(nurtur\w*|contacted|emailed|messaged|reached out|attempted\w*|attempting|outreach sent|sent|pinged|no reply|no response|unresponsive|target(ed)?|to contact|identified|new|open|lead|leads|prospect\w*|cold|mql|subscriber|other|unknown|none|marketing|inbound|outbound|event|webinar|imported|list|sourced|applied|new applicant|application review)\b/i;
export const STATUS_MEANINGS = ['warm', 'hold', 'coordinate', 'ignore', 'customer', 'lost', 'do_not_contact'];

export function defaultStatusMeaning(value) {
  const s = String(value || '')
    .toLowerCase()
    .trim();
  if (!s) return 'ignore';
  if (DO_NOT_CONTACT.test(s)) return 'do_not_contact';
  if (HOLD.test(s)) return 'hold';
  if (LIVE_PARTNER.test(s) && !NOT_LIVE.test(s)) return 'customer';
  if (COORDINATE.test(s)) return 'coordinate';
  if (CUSTOMER.test(s)) return 'customer';
  if (LOST.test(s)) return 'lost';
  // Marketing-qualified is one-way (a download, a form, a webinar): its "qualified" alone isn't a conversation, but
  // anything else two-way in the status ("MQL, demo booked", "MQL to SQL") still is.
  const mql = /\bmarketing[- ]qualified\b|\bmql\b|\binformation qualified\b/;
  if (mql.test(s)) {
    const rest = s.replace(new RegExp(mql.source, 'g'), ' ');
    return TWO_WAY.test(rest) && !/\b(never|not|hasn'?t|haven'?t|no[- ]show\w*|no (response|reply|meeting|demo|call)|unresponsive|requested)\b/.test(rest)
      ? 'warm'
      : 'ignore';
  }
  if (TWO_WAY.test(s)) return 'warm';
  if (ONE_WAY.test(s)) return 'ignore';
  return null; // unknown: the user says
}

// What a deal's stage says: won (a customer), lost (a past conversation that ended), open (a known pipeline step,
// one going on now), or unclear (a stage name floorboss doesn't know, which the user is asked about: read as open,
// a lost deal by another name would count as a live conversation). A blank or placeholder says nothing.
const DEAL_LOST =
  /\b(lost|closed[- ]?lost|abandon\w*|dead|declined|rejected|cancel+ed|disqualified|unqualified|not[- ]interested|no[- ](decision|budget|deal|go|fit|interest)|withdrawn|churn\w*|gone cold|went cold|stalled out|verloren|perdu\w*|perdido|perso|archived)\b/i;
const DEAL_OPEN =
  /\b(open|new|lead|qualif\w*|discovery|intro\w*|first (call|meeting)|meeting|call|demo|present\w*|appointment|scheduled|proposal|quote|pricing|offer|negotiat\w*|contract|legal|procurement|security review|pilot|trial|poc|proof of concept|evaluat\w*|in progress|follow[- ]?up|decision maker|bought[- ]in|commit\w*|verbal|pending|stage \d|s\d|pipeline|opportunity|engaged|working|not (yet )?(signed|won|live)|un-?signed|signature|signing|go[- ]live|planned|kick-?off|onboarding|implementation)\b/i;
// "Live" (the whole stage) or "went live" is won; "Go-live planned", "Live demo" or "live in Q1" is a step to come.
const DEAL_WON = /\b(won(?!['’]t)|closed[- ]?won|signed|went live|is live|now live)\b|^\s*live\s*$/i;
export function dealStateOf(value) {
  const s = String(value ?? '').trim();
  if (!s || /^(-+|—|–|n\/?a|none|null|nil|\?+|unknown)$/i.test(s)) return null;
  if (DEAL_LOST.test(s)) return 'lost';
  if (DEAL_WON.test(s) && !/\bnot (yet )?(signed|won|live)|\bun-?signed|\b(pending|awaiting) (signature|signing)|\bto be signed/i.test(s)) return 'won';
  // Any other "closed" stage is a deal that ended without a win.
  if (/\bclosed\b/i.test(s)) return 'lost';
  return DEAL_OPEN.test(s) ? 'open' : 'unclear';
}

export function fingerprint(headers) {
  return createHash('sha256')
    .update(headers.map((h) => norm(h)).join('\u0001'))
    .digest('hex')
    .slice(0, 16);
}

const sample = (rows, h, n = 3) => {
  const out = [];
  for (const r of rows) {
    const v = String(r[h] ?? '').trim();
    if (v && !out.includes(v)) out.push(v.slice(0, 60));
    if (out.length >= n) break;
  }
  return out;
};
const share = (rows, h, test) => {
  const vals = rows.map((r) => String(r[h] ?? '').trim()).filter(Boolean);
  return vals.length ? vals.filter(test).length / vals.length : 0;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HONORIFIC = /^(mr|mrs|ms|mx|miss|dr|prof|sir|dame|herr|frau|mme|mlle|sr|sra|srta|m)\.?$/i;
const YES_NO = /^(yes|no|y|n|ja|nein|oui|non|sí|si|sim|não|true|false|0|1|x|✓|opted in|opted out|checked|unchecked)$/i;

// Propose a field for every column, with three sample values and how sure the guess is.
export function propose(headers, rows, kind) {
  const table = ALIASES[kind];
  if (!table) throw new Error(`Unknown mapping kind ${kind}`);
  const columns = {};
  const taken = new Set();
  // Exact names first, for every header, so a word match below never takes a field a real column has.
  const exact = {};
  // A deal's stage goes last, so it is the status column only when no lifecycle or lead status is there.
  const dealStage = (h) => kind === 'crm' && table.deal_stage.includes(norm(h));
  for (const h of [...headers.filter((x) => !dealStage(x)), ...headers.filter(dealStage)]) {
    // Pipedrive writes "Person - Label", "Person - Notes": the name after "person" is the column's name.
    const whole = norm(h);
    const n = kind === 'crm' && /^person[a-z]{3,}/.test(whole) && !Object.values(table).some((a) => a.includes(whole)) ? whole.slice(6) : whole;
    for (const [f, aliases] of Object.entries(table)) {
      const i = aliases.indexOf(n);
      if (i >= 0 && !Object.values(exact).some((x) => x.field === f)) {
        exact[h] = { field: f, confidence: i === 0 ? 0.95 : 0.85 };
        break;
      }
    }
  }
  for (const x of Object.values(exact)) taken.add(x.field);
  for (const h of headers) {
    let field = exact[h]?.field || null,
      confidence = exact[h]?.confidence || 0;
    if (field) taken.delete(field);
    // A header that says not to email or contact ("Do Not Email (Y/N)") is an opt-out, never the email column.
    if (
      !field &&
      kind === 'crm' &&
      !taken.has('opted_out') &&
      /\b(do ?not|don'?t|no)\b.*\b(e-?mail|mail|contact)\b|opt.?out|unsubscri/i.test(h) &&
      !/reason|date|source/i.test(h)
    ) {
      field = 'opted_out';
      confidence = 0.6;
    }
    // "Company / Org", "Email (work)": no exact name, but one of its words is. A header that is about
    // something else of that thing ("Company Size", "Owner ID") never matches this way.
    if (!field) {
      const words = String(h)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 2);
      const about = words.some((w) =>
        /^(size|type|id|domain|industry|revenue|count|date|url|website|country|number|no|employees|phone|source|score|rating)$/.test(w)
      );
      if (!about)
        for (const [f, aliases] of Object.entries(table))
          if (
            !taken.has(f) &&
            words.some((w) => aliases.includes(w)) &&
            !(f === 'name' && words.length > 1 && !words.includes('name') && !words.includes('who'))
          ) {
            field = f;
            confidence = 0.6;
            break;
          }
    }
    const samples = sample(rows, h);
    // Values decide where the name doesn't: a column of addresses is email; a column of Mr/Ms isn't a title.
    if (!field && share(rows, h, (v) => EMAIL.test(v)) >= 0.5 && !taken.has('email')) {
      field = 'email';
      confidence = 0.8;
    }
    if (field === 'company_size' && rows.length && share(rows, h, (v) => !String(v).trim() || bandOf(v)) < 0.6) {
      field = 'ignore';
      confidence = 0.5;
    }
    if (field === 'title' && share(rows, h, (v) => HONORIFIC.test(v)) > 0.5) {
      field = 'ignore';
      confidence = 0.9;
    }
    if (
      !field &&
      kind === 'attendees' &&
      /consent|opt|contactable|meeting|matchmak|einwillig|kontakt|permission|allow|accept|networking|open to|availab/i.test(h) &&
      share(rows, h, (v) => YES_NO.test(v)) > 0.8 &&
      !taken.has('contact_opt_in')
    ) {
      field = 'contact_opt_in';
      confidence = 0.6;
    }
    if (!field && kind === 'crm' && /status|stage|lifecycle|disposition/i.test(h) && !taken.has('status_2') && taken.has('status')) {
      field = 'status_2';
      confidence = 0.7;
    }
    if (!field) {
      field = 'ignore';
      confidence = 1;
    }
    if (field !== 'ignore') taken.add(field);
    const col = { field, confidence, samples };
    if (['last_contact', 'won_at', 'rejected_at'].includes(field)) col.date_order = null; // decided below over every date column
    if (field === 'opted_out') {
      // A column that records consent means the opposite of an opt-out. Guess from its name; the user confirms.
      col.sense =
        /opt.?in|consent|einwilligung|subscri|permission|allow|can (email|contact)|agreed|gdpr ok/i.test(h) && !/out|unsub|withdraw|do not|no /i.test(h)
          ? 'consent'
          : 'optout';
      col.confidence = Math.min(col.confidence, 0.7);
    }
    columns[h] = col;
  }
  // Day/month order, from every slash date in every date column.
  const dateCols = Object.entries(columns)
    .filter(([, c]) => 'date_order' in c)
    .map(([h]) => h);
  let dmy = false,
    mdy = false,
    slash = false;
  for (const h of dateCols)
    for (const r of rows) {
      const m = /^(\d{1,2})[/.](\d{1,2})[/.]\d{2,4}/.exec(String(r[h] ?? '').trim());
      if (!m) continue;
      slash = true;
      if (+m[1] > 12) dmy = true;
      if (+m[2] > 12) mdy = true;
    }
  const order = dmy && !mdy ? 'dmy' : mdy && !dmy ? 'mdy' : slash ? 'ambiguous' : 'iso';
  for (const h of dateCols) columns[h].date_order = order === 'ambiguous' ? 'mdy' : order === 'iso' ? null : order;
  const statusCols = Object.entries(columns)
    .filter(([, c]) => ['status', 'status_2'].includes(c.field))
    .map(([h]) => h);
  const values = { status: {} };
  const counts = new Map();
  for (const h of statusCols)
    for (const r of rows) {
      const v = String(r[h] ?? '').trim();
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
  for (const [v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) values.status[v] = defaultStatusMeaning(v);
  return {
    kind,
    fingerprint: fingerprint(headers),
    headers,
    columns,
    values,
    status_values: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, proposed: values.status[value] })),
    stop_like_cells: stopLikeCells(headers, rows, columns),
    date_order_ambiguous: order === 'ambiguous',
    owner_values:
      kind === 'crm'
        ? [...new Set(rows.map((r) => String(r[Object.keys(columns).find((h) => columns[h].field === 'owner')] ?? '').trim()).filter(Boolean))].slice(0, 20)
        : undefined
  };
}

// Columns the mapping ignores whose cells say stop or caution. Shown always; stop cells are read as notes.
export function stopLikeCells(headers, rows, columns) {
  const out = [];
  for (const h of headers) {
    if (['opted_out', 'notes', 'status', 'status_2'].includes(columns[h]?.field)) continue;
    let stop = 0,
      caution = 0,
      example = null;
    // The cells themselves (file line and text), so the note names which cell says it, not only a count.
    const cells = [];
    // A caution word in a name, title or company ("Legal Counsel", "Churn Analyst") is someone's job, not a
    // warning about them: only a stop word counts there.
    const who = ['name', 'first_name', 'last_name', 'title', 'company', 'email'].includes(columns[h]?.field);
    rows.forEach((r, i) => {
      const v = String(r[h] ?? '');
      const kind = STOP_WORDS.test(v) ? 'stop' : !who && CAUTION_WORDS.test(v) ? 'caution' : null;
      if (!kind) return;
      if (kind === 'stop') {
        stop++;
        example ||= v.trim().slice(0, 80);
      } else caution++;
      if (cells.length < 5)
        cells.push({ line: i + 2, kind, text: v.trim().slice(0, 80), ...(kind === 'caution' ? { word: CAUTION_WORDS.exec(v)[0].toLowerCase() } : {}) });
    });
    if (stop || caution) out.push({ column: h, stop_rows: stop, caution_rows: caution, example, cells });
  }
  return out;
}

// What the user confirms. Fails loudly on anything that would make floorboss guess later.
export function validateMapping(m, { optOutNone = false } = {}) {
  const errors = [];
  if (!m || !['attendees', 'crm'].includes(m.kind)) errors.push('kind is attendees or crm');
  const fields = Object.values(m?.columns || {}).map((c) => c?.field);
  const allowed = FIELDS[m?.kind] || [];
  for (const [h, c] of Object.entries(m?.columns || {}))
    if (!allowed.includes(c?.field)) errors.push(`column "${h}": "${c?.field}" isn't a field (${allowed.join(', ')})`);
  for (const f of allowed) if (f !== 'ignore' && fields.filter((x) => x === f).length > 1) errors.push(`two columns are mapped to ${f}`);
  if (!fields.includes('name') && !(fields.includes('first_name') || fields.includes('last_name')))
    errors.push('no name column (name, or first_name and last_name)');
  if (m?.kind === 'attendees' && !fields.includes('company')) errors.push('no company column');
  if (m?.kind === 'crm') {
    // A status that means never contact ("Unsubscribed" in Deal Stage) covers it: no opt-out column is needed.
    if (!fields.includes('opted_out') && !optOutNone && !m.opt_out_none && !statusOptOut(m).length)
      errors.push('no opt-out column: map one, or say there is none ("there\'s no opt-out column")');
    for (const [v, meaning] of Object.entries(m.values?.status || {}))
      if (!STATUS_MEANINGS.includes(meaning)) errors.push(`status "${v}": "${meaning}" isn't one of ${STATUS_MEANINGS.join(', ')}`);
    for (const [h, c] of Object.entries(m.columns || {}))
      if (c.field === 'opted_out' && !['optout', 'consent'].includes(c.sense))
        errors.push(`column "${h}": say whether yes means opted out (sense: optout) or agreed to contact (sense: consent)`);
  }
  return errors;
}

// Status values that mean never contact, with the column they're in.
function statusOptOut(m) {
  const vals = Object.entries(m?.values?.status || {})
    .filter(([, x]) => x === 'do_not_contact')
    .map(([k]) => k);
  const col = Object.entries(m?.columns || {}).find(([, c]) => c.field === 'status')?.[0] || null;
  return vals.map((v) => ({ value: v, column: col }));
}
// Which column says who opted out, in a line the user can check: the opt-out column, a status that covers it, or
// none at all. asking: false when the mapping isn't put to the user again (a layout confirmed before): then the
// line says what is so, without asking them to say anything.
export function optOutSays(m, { asking = true } = {}) {
  const col = Object.entries(m?.columns || {}).find(([, c]) => c.field === 'opted_out');
  if (col)
    return `"${col[0]}" is read as the opt-out column (${col[1].sense === 'consent' ? 'yes means they agreed to be contacted' : 'yes means they opted out'}).`;
  const st = statusOptOut(m);
  if (st.length)
    return `no opt-out column: ${st[0].column ? `"${st[0].column}"` : 'the status'} covers it (${st.map((x) => `"${x.value}"`).join(', ')} ${st.length === 1 ? 'means' : 'mean'} never contact).`;
  if (m?.opt_out_none) return 'no opt-out column (you said there is none): only stop notes and statuses hold anyone back.';
  if (!asking) return 'no column says who opted out: only stop notes and statuses hold anyone back.';
  return 'no column says who opted out: say "there\'s no opt-out column" if that\'s right, or which column it is.';
}

export function sourcePath(evDir, fp) {
  return join(evDir, 'sources', `${fp}.json`);
}
export function readSource(evDir, fp) {
  const p = sourcePath(evDir, fp);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
export function writeSource(evDir, m) {
  writeJson(sourcePath(evDir, m.fingerprint), m);
  return sourcePath(evDir, m.fingerprint);
}
export function listSources(evDir) {
  const dir = join(evDir, 'sources');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    : [];
}

const FALSE =
  /^(|false|no|nein|nee|nej|non|n|0|0\.0|none|null|nil|n\/a|na|-|–|—|off|unchecked|☐|opted in|opt[- ]?in|opted-in|subscribed|consented|consent given|has consent|ok|active|allowed|not opted out|not unsubscribed)$/i;
const CONSENT_YES = /^(yes|y|true|1|x|✓|✔|granted|given|consented|opted[- ]?in|opt[- ]?in|double opt[- ]?in|subscribed|ja|oui|sí|si|sim)$/i;
// Fails closed: anything that isn't clearly "no" counts as opted out; with a consent column, anything that
// isn't clearly "yes" counts as no consent.
export function optedOut(value, sense) {
  const v = String(value ?? '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .trim();
  return sense === 'consent' ? !CONSENT_YES.test(v) : !FALSE.test(v);
}

export function parseDate(value, order) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const ok = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ok(m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const a = +m[1],
      b = +m[2];
    if (order === 'dmy' || (!order && a > 12)) return ok(y, b, a);
    return ok(y, a, b);
  }
  if (/^\d+$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// Apply a confirmed (or proposed) mapping to the file's rows. Every row keeps its line number and the raw
// cells of every notes-like or stop-like column, so nothing the file said is lost.
export function applyMapping(rows, m) {
  const cols = Object.entries(m.columns);
  const field = (f) => cols.filter(([, c]) => c.field === f).map(([h]) => h);
  const one = (r, f) => {
    const h = field(f)[0];
    return h ? String(r[h] ?? '').trim() : '';
  };
  const noteCols = [...field('notes'), ...(m.stop_like_cells || []).filter((x) => x.stop_rows).map((x) => x.column)].filter((h, i, a) => a.indexOf(h) === i);
  const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');
  const flat = (v) =>
    String(v ?? '')
      .replace(CONTROL, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return rows.map((r, i) => {
    const name = flat(one(r, 'name') || [one(r, 'first_name'), one(r, 'last_name')].filter(Boolean).join(' '));
    const out = {
      line: i + 2,
      name,
      title: flat(one(r, 'title')),
      company: flat(one(r, 'company')),
      email: one(r, 'email').toLowerCase(),
      profile_url: one(r, 'profile_url'),
      phone: one(r, 'phone'),
      location: one(r, 'location'),
      booth: one(r, 'booth'),
      attendee_type: one(r, 'attendee_type'),
      contact_opt_in: one(r, 'contact_opt_in'),
      company_size: one(r, 'company_size'),
      notes: noteCols
        .map((h) => String(r[h] ?? '').trim())
        .filter(Boolean)
        .join(' | ')
    };
    if (m.kind === 'crm') {
      const statuses = ['status', 'status_2']
        .flatMap((f) => field(f))
        .map((h) => String(r[h] ?? '').trim())
        .filter(Boolean);
      const ownerH = field('owner')[0],
        optH = field('opted_out')[0];
      const dateOf = (f) => {
        const h = field(f)[0];
        return h ? parseDate(r[h], m.columns[h].date_order) : null;
      };
      Object.assign(out, {
        owner: ownerH ? String(r[ownerH] ?? '').trim() : '',
        statuses,
        status: statuses[0] || '',
        meanings: statuses.map((s) => m.values?.status?.[s] ?? defaultStatusMeaning(s) ?? 'unknown'),
        opted_out: optH ? optedOut(r[optH], m.columns[optH].sense || 'optout') : false,
        last_contact: dateOf('last_contact'),
        won_at: dateOf('won_at'),
        rejected_at: dateOf('rejected_at'),
        deal: flat(one(r, 'deal')),
        deal_stage: flat(one(r, 'deal_stage')).slice(0, 60),
        // The record id goes into a task call and its prompt: one short line, never text of its own.
        crm_id: one(r, 'crm_id')
          .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
          .trim()
          .slice(0, 64),
        // Stop wording anywhere in a column floorboss doesn't otherwise read, on every read: a later export with the
        // same columns can carry a "please stop" the confirmed mapping never saw.
        stop_note: STOP_WORDS.test(out.notes)
          ? out.notes.slice(0, 140)
          : (
              Object.keys(r)
                .filter((h) => !m.columns[h] || m.columns[h].field === 'ignore')
                .map((h) => flat(r[h]))
                .find((v) => v && STOP_WORDS.test(v)) || ''
            ).slice(0, 140) || null,
        caution_note: !STOP_WORDS.test(out.notes) && CAUTION_WORDS.test(out.notes) ? out.notes.slice(0, 140) : null
      });
      out.deal_state = dealStateOf(out.deal_stage);
      // A won deal counts only on a row whose status or deal stage says so; CRMs put a close date on lost and open
      // deals too.
      if (out.won_at && !out.meanings.includes('customer') && out.deal_state !== 'won') out.won_at = null;
      // On the won deal: the deal's stage says so when the file has one; else any deal on the row counts.
      out.on_won_deal = out.deal_state ? out.deal_state === 'won' : field('deal').length ? !/^(\s*|-+|—|–|n\/?a|none|null|nil|\?+)$/i.test(out.deal) : null;
    }
    return out;
  });
}
