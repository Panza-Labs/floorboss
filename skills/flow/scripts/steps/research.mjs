// Copyright 2026 Potrero Ventures LLC
// SPDX-License-Identifier: Apache-2.0
// Phase 4 of nextStep.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../../lib/jsonio.mjs';
import { companySlug } from '../../../../lib/normalize.mjs';
import { plural } from '../../../../lib/plural.mjs';
import { cli, step, node, handSend } from './shared.mjs';
import { earlierLine } from './counts.mjs';

// Hand-send's people research, never asked: everyone up to 20, else the top 20.
const handSendScale = (n) => (n > 20 ? { scale: 'top', n: 20 } : { scale: 'all', n });

// Research: company briefs, fit doubts, how much to research, the research itself, and writing samples.
export function researchSteps(x) {
  const { c, cfg, mock, e } = x;
  // Company briefs come first, for every shortlisted company: a draft's angle is built from them.
  const companies = cli('attendee-research', ['company-plan', '--event', e.event.slug], c);
  const quick = c.ob.ans.setup_level === 'quick';
  if (companies.to_brief?.length) {
    const todo = companies.companies.filter((x) => !x.has_brief);
    // Research isn't asked, in any host. It starts, with one line on what is looked up and about how long it takes, and
    // the user can say "skip" (saved as the company_research answer, which this step takes).
    const hs = !mock;
    if (e.state.answered.company_research?.value === 'skip')
      return step('company_skip', "No company research (your answer): each company gets a brief that says it wasn't researched.", {
        run: node('attendee-research', 'skip-companies', '--event', e.event.slug),
        show: ['skipped']
      });
    const shortN0 = (readJson(join(e.paths.derived, 'shortlist.json'), {}).ranked || []).length;
    const fileOf = (co) => join(e.paths.work, `company-${companySlug(co)}.json`);
    // About a minute a company in turn, as the live Codex run took.
    const mins = Math.max(1, todo.length);
    const unasked = hs && !e.state.answered.company_research;
    // The people are researched in every setup level, quick included: it asks nothing, so nothing declined it.
    const peopleToo = unasked && !e.state.answered.research_scale && shortN0 ? handSendScale(shortN0) : null;
    return step(
      'company_briefs',
      `Before any draft: what each of ${todo.length} companies sells, how it relates to ${companies.sender_company || 'your company'} and what it would want from you. ${handSend() ? 'Run each researcher in turn, then save each.' : 'Run every researcher at once (in parallel, one message), then save each.'}${!unasked && todo.length > 15 ? ` Tell the user first, in one line: ${todo.length} company researches, a few web searches each, a few minutes in all.` : ''}`,
      {
        ...(unasked
          ? {
              companies: todo.map((x) => x.company),
              tell_user: `Looking up the ${todo.length} shortlisted ${todo.length === 1 ? 'company' : 'companies'} on the web now (${todo
                .slice(0, 6)
                .map((x) => x.company)
                .join(', ')}${todo.length > 6 ? ', …' : ''}): what each sells and what's new in its market${peopleToo ? `, then ${peopleToo.n === shortN0 ? `the ${plural(shortN0, 'shortlisted person', 'shortlisted people')}` : `the top ${peopleToo.n} shortlisted people`}` : ''}. About ${plural(mins + (peopleToo ? peopleToo.n : 0), 'minute')}. Say "skip" to draft without it.`,
              accepts: ['company_research'],
              if_user_says: { skip: 'flow answer --ask company_research --value-file <a file with their words>', means: 'no web research: messages say nothing about the companies themselves' }
            }
          : {}),
        agents: todo.map((co) => ({
          name: 'floorboss:attendee-researcher',
          input: {
            mode: 'company',
            company: co.company,
            sender_company: companies.sender_company,
            sender_goal: cfg.goal || null,
            people: co.people,
            ...(co.domain ? { domain: co.domain } : {}),
            // What the CRM says stays with floorboss (its own script adds it to the brief): the researcher, which reads
            // the open web, is told only that they're a customer or partner, and the user's own proof lines.
            ...(co.known
              ? {
                  known: {
                    customer: !!co.known.customer,
                    ...(co.known.relation ? { relation: co.known.relation } : {}),
                    proof: co.known.proof || [],
                    has_crm: !!co.known.has_crm
                  }
                }
              : {})
          },
          write: fileOf(co.company),
          then: node('attendee-research', 'save-company', '--event', e.event.slug, '--company-slug', companySlug(co.company), '--json-file', fileOf(co.company))
        })),
        remaining: todo.length
      }
    );
  }

  // Research said a shortlisted company may not fit (acquired, a different industry, far too big): the user decides once,
  // before anything is drafted for its people, rather than finding out from the drafts.
  if (!e.state.answered.fit_doubts) {
    const doubts = (companies.companies || []).map((x) => ({ ...x, meta: readJson(x.file.replace(/\.md$/, '.json'), null) })).filter((x) => x.meta?.fit_doubt);
    if (doubts.length)
      return step('fit_doubts', `Research found ${doubts.length} shortlisted ${doubts.length === 1 ? 'company that' : 'companies that'} may not fit.`, {
        ask: {
          id: 'fit_doubts',
          question: `Research says these may not fit: ${doubts.map((x) => `${x.company} (${x.meta.fit_doubt}; ${x.people.map((p) => p.name).join(', ')})`).join('; ')}. Cut them from the shortlist, or keep them? Cutting them all leaves ${Math.max(0, (readJson(join(e.paths.derived, 'shortlist.json'), {}).ranked || []).length - doubts.reduce((n, x) => n + x.people.length, 0))} on the shortlist.`,
          options: ['cut them all', 'keep them all', 'cut <company>, keep the rest'],
          people: doubts.flatMap((x) => x.people.map((p) => ({ id: p.id, name: p.name, company: x.company }))),
          answer_format: '{"cut":["<company>",…]} (an empty list keeps them all)'
        }
      });
  }
  // Quick setup: no person research (company briefs still run, on the user's yes). The mock comes with its
  // research (canned, and its profiles say so): nothing to ask, nothing to search.
  // The offer follows the shortlist's size: "the top 20" of 10 people is all of them.
  const shortN = (readJson(join(e.paths.derived, 'shortlist.json'), {}).ranked || []).length;
  const topN = shortN > 20 ? 20 : Math.max(1, Math.ceil(shortN / 2));
  // The people are researched without a question (any level), all of them up to 20, else the top 20.
  const scale = !e.state.answered.research_scale ? (mock ? 'none' : handSendScale(shortN).scale) : e.state.answered.research_scale.value;
  if (scale !== 'none') {
    const plan = cli(
      'attendee-research',
      ['plan', '--event', e.event.slug, '--scale', scale === 'top' ? 'top' : 'all', ...(scale === 'top' ? ['--n', String(topN)] : [])],
      c
    );
    const todo = (plan.to_research || []).filter((p) => !existsSync(join(e.paths.dir, 'profiles', `${p.id}.md`)));
    const unaskedPeople = !e.state.answered.research_scale;
    if (todo.length)
      return step(
        'research_batch',
        `Research ${plural(todo.length, 'person', 'people')} on the web, ${handSend() ? 'one after another' : 'all at once (in parallel, one message)'}: public sources only, a URL on every claim. Then save each.`,
        {
          ...(unaskedPeople
            ? {
                tell_user: `Looking up ${plural(todo.length, 'shortlisted person', 'shortlisted people')} on the web now, so each message can say one true thing about its reader. About ${plural(todo.length, 'minute')}. Say "skip" to draft without it.`,
                accepts: ['research_scale'],
                if_user_says: { skip: 'flow answer --ask research_scale --value-file <a file with the word none>' }
              }
            : {}),
          agents: todo.map((p) => ({
            name: 'floorboss:attendee-researcher',
            input: { id: p.id, name: p.name, title: p.title, company: p.company, segment: p.segment, sources: p.sources },
            write: join(e.paths.work, `research-${p.id}.json`),
            then: node('attendee-research', 'save', '--event', e.event.slug, '--id', p.id, '--json-file', join(e.paths.work, `research-${p.id}.json`))
          })),
          remaining: todo.length
        }
      );
  }

  // The sender's own emails that got replies set the voice (asked once; skippable with words).
  // With the intake answered, only when past emails were picked (then on quick setup too); before it, as it was.
  const emailsPick = c.ob.ans.account_intake ? String(c.ob.ans.account_intake).split(',').includes('emails') : null;
  if (!e.state.voice_samples.length && !e.state.answered.voice_samples && e.settings.drafting_mode !== 'delegate' && c.ob.ans.samples_ok !== true && (emailsPick === null ? !quick : emailsPick))
    return step('voice_samples', 'Three to five emails you wrote that got a reply show floorboss how you write: length, how you open, how you ask.', {
      ask: {
        id: 'voice_samples',
        question: 'Paste three to five emails you sent that got a reply (from your sent mail), or say skip.',
        answer_format: '{"samples":[{"subject","body"}]} or the word skip'
      }
    });
}
