// 0.1.7 review: nothing is ever drafted on a channel the user did not choose. Someone with no address on any chosen
// channel isn't written to, and the plan says in one line how many and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, cli, triage, todoJobs } from './fixtures/harness.mjs';

const LIST = 'Name,Title,Company,Email,LinkedIn\nAna Berg,COO,Acme,ana@acme.test,\nBo Lind,COO,Beta,,https://www.linkedin.com/in/bo\nCy Ho,COO,Gamma,,\n';
const jobs = (H) => todoJobs(H).jobs.filter((j) => j.kind === 'message').map((j) => `${j.contact.name}:${j.routed || (j.channel === 'email' ? 'email' : j.invite_note ? 'linkedin' : j.app_note ? 'app' : j.channel)}`);

for (const [reach, want, line] of [
  [[], ['Ana Berg:email'], /^2 people have no email, and you chose email only: they aren't written to\.$/],
  [['linkedin'], ['Ana Berg:email', 'Bo Lind:linkedin'], /^1 person has no email or LinkedIn link, and you chose email and LinkedIn: they aren't written to\.$/]
]) {
  test(`reach ${JSON.stringify(reach)}: no message on a channel not chosen, and one line says who isn't written to`, () => {
    const H = setup({ attendees: LIST, event: { app_name: 'Grip' }, settings: { reach } });
    triage(H);
    assert.deepEqual(jobs(H).filter((x) => x.endsWith(':email') || !x.startsWith('Ana')).sort(), want.sort());
    const p = cli(H, 'crm-triage', ['plan', '--event', H.slug]);
    assert.match(p.not_written_to || '', line, JSON.stringify(p).slice(0, 400));
  });
}
