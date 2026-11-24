// Invariants 5, 6 and 9 to 14 of client/README.md ("Always true"), and the probe that the built app is served. The
// agent and the case system are scripted servers; the identity provider refreshes by a function, and a machine
// client's token is a function (support.ts).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type { Refreshed } from '../src/identity.ts';
import type { Session } from '../src/sessions.ts';
import { tokenFor } from '../src/tokens.ts';
import type { Person, Received } from './support.ts';
import { APP_ORIGIN, DANA, EXAMPLE_RESPONSE, RILEY, ScriptedRenewal, at, call, clock, deskConfig, machineTokens, scripted, settled, signedIn, startDesk } from './support.ts';

const webRoot = mkdtempSync(join(tmpdir(), 'client-web-'));
after(() => rmSync(webRoot, { recursive: true, force: true }));
mkdirSync(join(webRoot, 'assets'));
writeFileSync(join(webRoot, 'index.html'), 'the app page');
writeFileSync(join(webRoot, 'assets', 'app.js'), 'the app script');

const WITH_STEP = { ...EXAMPLE_RESPONSE, steps: [{ kind: 'error' as const, started_at: '2026-03-01T09:00:00.000Z', duration_ms: 5, message: 'A synthetic step.' }] };
const agent = await scripted({ after }, (r) => ({ status: 200, body: at(r.body, 'message', 'text') === 'A message with steps' ? WITH_STEP : EXAMPLE_RESPONSE }));
const cases = await scripted({ after }, () => ({ status: 200, body: { answered: 'by the case system' } }));
const agents = [
  { id: 'first', name: 'First', description: 'scripted', url: agent.url },
  { id: 'expert', name: 'Expert', description: 'scripted', scope: 'agents:expert' as const, url: agent.url },
  { id: 'orchestrator', name: 'Orchestrator', description: 'scripted', scope: 'agents:orchestrator' as const, url: agent.url, wait_seconds: 295 },
];
const config = deskConfig({ agents, caseReviewUrl: cases.url, webRoot });
const time = clock();
const identity = new ScriptedRenewal(config, time.now);
const machine = machineTokens(time.now);
const desk = await startDesk({ after }, config, time, identity, machine);
const textOf = (r: Received): unknown => at(r.body, 'message', 'text');

function inquire(cookie: string, text: string, origin?: string): Promise<{ status: number; body: unknown }> {
  return call(`${desk.url}/api/inquiries`, { cookie, origin, method: 'POST', body: { sender: 'A clinician', text, agent_id: 'first' } });
}

async function listed(cookie: string, text: string): Promise<boolean> {
  const { body } = await call(`${desk.url}/api/inquiries`, { cookie });
  const inquiries = at(body, 'inquiries');
  return Array.isArray(inquiries) && inquiries.some((inquiry) => at(inquiry, 'text') === text);
}

test('invariant 5: every call carries a token got for its target alone, with enough life left; refreshes never overlap; a failed one ends the session', { timeout: 10_000 }, async (t) => {
  const setup = signedIn(desk, RILEY, 'access-setup', 3_600_000, 'refresh-setup');
  const inquiryId = String(at((await inquire(setup, 'for a new run')).body, 'inquiry', 'id'));
  await settled(desk, inquiryId, setup);
  const before = agent.received.length;
  // The session keeps a token with the given life for each scope it was granted ("<access>:<scope>"), and carries the
  // one kept for the call's scope or the one got for it ("<scope> for <refresh token>"). 100 s is short of an agent run (180 s); 10 s, of a case
  // call (30 s).
  const rows = [
    { name: 'a new inquiry, token long-lived', life: 3_600_000, scope: 'agents:intake', kept: true, send: (c: string) => inquire(c, 'long-lived'), seen: () => agent.waitFor((r) => textOf(r) === 'long-lived') },
    { name: 'a new inquiry, token short of an agent run', life: 100_000, scope: 'agents:intake', kept: false, send: (c: string) => inquire(c, 'short'), seen: () => agent.waitFor((r) => textOf(r) === 'short') },
    {
      name: 'a new run of an inquiry, token short of an agent run',
      life: 100_000,
      scope: 'agents:intake',
      kept: false,
      send: (c: string) => call(`${desk.url}/api/inquiries/${inquiryId}/runs`, { cookie: c, method: 'POST', body: { agent_id: 'first' } }),
      seen: () => agent.waitFor((r) => textOf(r) === 'for a new run' && agent.received.indexOf(r) >= before),
    },
    { name: 'the case list', life: 10_000, scope: 'cases:read', kept: false, send: (c: string) => call(`${desk.url}/api/cases?status=awaiting_review`, { cookie: c }), seen: () => cases.waitFor((r) => r.path.startsWith('/cases?')) },
    { name: 'a case', life: 10_000, scope: 'cases:read', kept: false, send: (c: string) => call(`${desk.url}/api/cases/AE-51`, { cookie: c }), seen: () => cases.waitFor((r) => r.path === '/cases/AE-51') },
    {
      name: 'a review',
      life: 10_000,
      scope: 'cases:review',
      kept: false,
      send: (c: string) => call(`${desk.url}/api/cases/AE-52/review`, { cookie: c, method: 'POST', body: { decision: 'approve' } }),
      seen: () => cases.waitFor((r) => r.path === '/cases/AE-52/review'),
    },
  ];
  for (const [n, row] of rows.entries()) {
    await t.test(row.name, async () => {
      const cookie = signedIn(desk, RILEY, `access-${n}`, row.life, `refresh-${n}`);
      assert.ok((await row.send(cookie)).status < 300);
      assert.equal((await row.seen()).authorization, row.kept ? `Bearer access-${n}:${row.scope}` : `Bearer ${row.scope} for refresh-${n}`);
    });
  }
  await t.test('two calls for different targets arrive together', async () => {
    // Each refresh returns a new refresh token, "r+" for r, and finishes a turn of the event loop later.
    const asked: string[] = [];
    let inFlight = 0;
    let most = 0;
    const refresh = async (refreshToken: string, scope: string): Promise<Refreshed> => {
      asked.push(`${scope} with ${refreshToken}`);
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return { accessToken: `${scope} for ${refreshToken}`, accessExpiresAt: time.now().getTime() + 600_000, granted: ['openid', scope], refreshToken: `${refreshToken}+` };
    };
    const session: Session = { id: 'together', user: DANA, granted: new Set(DANA.granted), refreshToken: 'r', tokens: new Map(), refreshes: Promise.resolve() };
    const deps = { refresh, now: time.now, isLive: () => true, end: () => undefined };
    const got = await Promise.all([tokenFor(session, 'agents:intake', 180_000, deps), tokenFor(session, 'cases:read', 30_000, deps)]);
    assert.deepEqual(got, [
      { outcome: 'token', accessToken: 'agents:intake for r' },
      { outcome: 'token', accessToken: 'cases:read for r+' },
    ]);
    assert.deepEqual({ asked, most, refreshToken: session.refreshToken }, { asked: ['agents:intake with r', 'cases:read with r+'], most: 1, refreshToken: 'r++' });
  });
  await t.test('the renewal is refused', async () => {
    const cookie = signedIn(desk, RILEY, 'access-refused', 10_000, 'refuse');
    assert.equal((await inquire(cookie, 'refused renewal')).status, 401);
    assert.equal((await call(`${desk.url}/api/session`, { cookie })).status, 401);
    assert.equal(await listed(setup, 'refused renewal'), false);
    assert.equal(agent.received.some((r) => textOf(r) === 'refused renewal'), false);
  });
});

test('invariant 6: the reviewer of a case is whoever is signed in, never a name the browser sends', async (t) => {
  const cookie = signedIn(desk, RILEY, 'access-riley', 3_600_000, 'refresh-riley');
  await t.test("a decision is forwarded with the signed-in user's token and no reviewer", async () => {
    const reply = await call(`${desk.url}/api/cases/AE-61/review`, { cookie, method: 'POST', body: { decision: 'approve', note: 'synthetic note' } });
    assert.deepEqual(reply, { status: 200, body: { answered: 'by the case system' } });
    const forwarded = await cases.waitFor((r) => r.path === '/cases/AE-61/review');
    assert.deepEqual({ authorization: forwarded.authorization, body: forwarded.body }, { authorization: 'Bearer access-riley:cases:review', body: { decision: 'approve', note: 'synthetic note' } });
  });
  await t.test('a decision that names its reviewer is refused and not forwarded', async () => {
    const reply = await call(`${desk.url}/api/cases/AE-62/review`, { cookie, method: 'POST', body: { decision: 'approve', reviewer: 'Someone Else' } });
    assert.equal(reply.status, 400);
    assert.equal(cases.received.some((r) => r.path === '/cases/AE-62/review'), false);
  });
});

test('invariant 9: a POST from another site is refused', async (t) => {
  const cookie = signedIn(desk, DANA, 'access-dana', 3_600_000, 'refresh-dana');
  await t.test('an inquiry from another site', async () => {
    assert.equal((await inquire(cookie, 'from elsewhere', 'https://elsewhere.example')).status, 403);
    assert.equal(await listed(cookie, 'from elsewhere'), false);
  });
  await t.test('a sign-out from another site', async () => {
    assert.equal((await call(`${desk.url}/auth/logout`, { cookie, method: 'POST', origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await call(`${desk.url}/api/session`, { cookie })).status, 200);
  });
  await t.test("an inquiry from the app's own origin is taken", async () => {
    const { status, body } = await inquire(cookie, 'from the app', APP_ORIGIN);
    assert.equal(status, 202);
    await settled(desk, String(at(body, 'inquiry', 'id')), cookie);
  });
});

test('invariant 10: what a session may do comes from its granted scopes; anything else is 403 before identity or the target is asked', async (t) => {
  const person = (sub: string, granted: string[]): Person => ({ sub, name: sub, username: sub, roles: [], granted });
  const send = (c: string, agentId: string) => () => call(`${desk.url}/api/inquiries`, { cookie: c, method: 'POST', body: { sender: 'A clinician', text: 'not allowed', agent_id: agentId } });
  const caseList = (c: string) => () => call(`${desk.url}/api/cases`, { cookie: c });
  const oneCase = (c: string) => () => call(`${desk.url}/api/cases/AE-101`, { cookie: c });
  const review = (c: string) => () => call(`${desk.url}/api/cases/AE-101/review`, { cookie: c, method: 'POST', body: { decision: 'approve' } });
  const rows = [
    { name: 'granted nothing but openid', granted: ['openid'], may: { agents: [], read_cases: false, decide_cases: false, read_traces: false }, refused: (c: string) => [send(c, 'first'), caseList(c), oneCase(c), review(c)] },
    { name: 'granted cases:read only', granted: ['openid', 'cases:read'], may: { agents: [], read_cases: true, decide_cases: false, read_traces: false }, refused: (c: string) => [send(c, 'first'), review(c)] },
    { name: 'granted the intake scope and both case scopes', granted: RILEY.granted, may: { agents: ['first'], read_cases: true, decide_cases: true, read_traces: false }, refused: (c: string) => [send(c, 'expert')] },
    { name: 'granted traces:read only', granted: ['openid', 'traces:read'], may: { agents: [], read_cases: false, decide_cases: false, read_traces: true }, refused: (c: string) => [send(c, 'first'), caseList(c)] },
  ];
  for (const [n, row] of rows.entries()) {
    await t.test(row.name, async () => {
      // Kept tokens too short for any call, so a call let through would ask the identity provider first.
      const cookie = signedIn(desk, person(`sub-may-${n}`, row.granted), `access-may-${n}`, 10_000, `refresh-may-${n}`);
      const view = await call(`${desk.url}/api/session`, { cookie });
      assert.deepEqual(at(view.body, 'may'), row.may);
      const listed = at((await call(`${desk.url}/api/agents`, { cookie })).body, 'agents');
      assert.deepEqual(Array.isArray(listed) ? listed.map((a) => at(a, 'id')) : listed, row.may.agents);
      for (const refused of row.refused(cookie)) {
        const asked = [identity.renewed.length, agent.received.length, cases.received.length];
        assert.equal((await refused()).status, 403);
        assert.deepEqual([identity.renewed.length, agent.received.length, cases.received.length], asked);
      }
    });
  }
});

test("invariant 11: the inbox is the desk's; to a session that may neither run an agent nor read cases an inquiry is unknown", async (t) => {
  const dana = signedIn(desk, DANA, 'access-inbox-dana', 3_600_000, 'refresh-inbox-dana');
  const morgan = signedIn(desk, { sub: 'sub-morgan', name: 'Morgan Medinfo', username: 'morgan.medinfo', roles: [], granted: ['openid', 'agents:intake', 'agents:expert'] }, 'access-inbox-morgan', 3_600_000, 'refresh-inbox-morgan');
  const riley = signedIn(desk, { ...RILEY, granted: ['openid', 'cases:read'] }, 'access-inbox-riley', 3_600_000, 'refresh-inbox-riley');
  const neither = signedIn(desk, { sub: 'sub-neither', name: 'Nobody', username: 'nobody', roles: [], granted: ['openid', 'traces:read'] }, 'access-inbox-neither', 3_600_000, 'refresh-inbox-neither');
  const id = String(at((await inquire(dana, "Dana's inquiry")).body, 'inquiry', 'id'));
  await settled(desk, id, dana);
  const read = (cookie: string, inquiryId: string) => call(`${desk.url}/api/inquiries/${inquiryId}`, { cookie });
  const rerun = (cookie: string, inquiryId: string, agentId: string) => call(`${desk.url}/api/inquiries/${inquiryId}/runs`, { cookie, method: 'POST', body: { agent_id: agentId } });
  const rows = [
    { name: 'Morgan reads the inquiry Dana entered', shows: async () => { const r = await read(morgan, id); return [r.status, at(r.body, 'inquiry', 'text'), at(r.body, 'inquiry', 'entered_by', 'name')]; }, expected: [200, "Dana's inquiry", DANA.name] },
    {
      name: 'Morgan runs it again, through an agent Morgan may run',
      shows: async () => {
        const r = await rerun(morgan, id, 'expert');
        const seen = await agent.waitFor((s) => textOf(s) === "Dana's inquiry" && s.authorization === 'Bearer access-inbox-morgan:agents:expert');
        await settled(desk, id, morgan);
        return [r.status, at(r.body, 'run', 'started_by', 'name'), at(seen.body, 'message', 'id')];
      },
      expected: [202, 'Morgan Medinfo', id],
    },
    { name: 'Riley, who may only read cases, reads it', shows: async () => { const r = await read(riley, id); return [r.status, at(r.body, 'inquiry', 'text')]; }, expected: [200, "Dana's inquiry"] },
    {
      name: 'a session that may do neither is answered as for an unknown id, and nothing is sent',
      shows: async () => {
        const sent = agent.received.length;
        const asked = (inquiryId: string) => Promise.all([read(neither, inquiryId), rerun(neither, inquiryId, 'first')]);
        const [theirs, none] = [await asked(id), await asked('no-such-inquiry')];
        return [isDeepStrictEqual(theirs, none), theirs.map((r) => at(r.body, 'error')), agent.received.length - sent];
      },
      expected: [true, ['inquiry_not_found', 'not_allowed'], 0],
    },
    {
      name: 'what the lab explorer entered or ran is not shown: its inquiry is not listed and is unknown by id, and its run on a desk inquiry is left out',
      shows: async () => {
        const entered = await call(`${desk.url}/lab/api/runs`, { method: 'POST', body: { agent_id: 'first', sender: 'A clinician', text: "The lab explorer's inquiry" } });
        const ran = await call(`${desk.url}/lab/api/runs`, { method: 'POST', body: { agent_id: 'first', inquiry_id: id } });
        const runs = [at((await read(morgan, id)).body, 'inquiry', 'runs')].flat().map((r) => at(r, 'id'));
        return [await listed(morgan, "The lab explorer's inquiry"), (await read(morgan, String(at(entered.body, 'inquiry_id')))).status, runs.includes(at(ran.body, 'run_id')), runs.length];
      },
      expected: [false, 404, false, 2],
    },
    { name: 'the list gives every inquiry to a session that may run an agent, and none to one that may not', shows: async () => [await listed(morgan, "Dana's inquiry"), await listed(riley, "Dana's inquiry")], expected: [true, false] },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => assert.deepEqual(await row.shows(), row.expected));
  }
});

test("invariant 12: a run's steps leave the server only on the trace routes, to a session granted traces:read; those cover every person's runs", async (t) => {
  const dana = signedIn(desk, DANA, 'access-steps', 3_600_000, 'refresh-steps');
  const avery = signedIn(desk, { sub: 'sub-avery', name: 'Avery Auditor', username: 'avery.auditor', roles: [], granted: ['openid', 'cases:read', 'traces:read'] }, 'access-traces', 3_600_000, 'refresh-traces');
  const id = String(at((await inquire(dana, 'A message with steps')).body, 'inquiry', 'id'));
  const runId = String(at(await settled(desk, id, dana), 'runs', 0, 'id'));
  const traces = (body: unknown): unknown[] => [at(body, 'traces')].flat();
  const rows = [
    { name: 'its own inquiry, to a session without the scope', cookie: dana, path: `/api/inquiries/${id}`, status: 200, shows: (b: unknown) => ['steps' in Object(at(b, 'inquiry', 'runs', 0, 'response')), at(b, 'inquiry', 'runs', 0, 'response', 'reply')], expected: [false, EXAMPLE_RESPONSE.reply] },
    { name: 'its own inquiry list, to a session without the scope', cookie: dana, path: '/api/inquiries', status: 200, shows: (b: unknown) => [JSON.stringify(b).includes('"steps"')], expected: [false] },
    { name: 'the trace list, to a session without the scope', cookie: dana, path: '/api/traces', status: 403 },
    { name: 'a trace, to a session without the scope', cookie: dana, path: `/api/traces/${runId}`, status: 403 },
    { name: 'an unknown run, to a session without the scope', cookie: dana, path: '/api/traces/no-such-run', status: 403 },
    { name: "the trace list holds a run another person started", cookie: avery, path: '/api/traces', status: 200, shows: (b: unknown) => [traces(b).some((r) => at(r, 'run_id') === runId && at(r, 'started_by', 'name') === DANA.name)], expected: [true] },
    { name: "that run's trace holds its steps and its message", cookie: avery, path: `/api/traces/${runId}`, status: 200, shows: (b: unknown) => [at(b, 'trace', 'run', 'response', 'steps'), at(b, 'trace', 'inquiry', 'text')], expected: [WITH_STEP.steps, 'A message with steps'] },
    { name: 'an unknown run', cookie: avery, path: '/api/traces/no-such-run', status: 404 },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      const { status, body } = await call(`${desk.url}${row.path}`, { cookie: row.cookie });
      assert.equal(status, row.status);
      if (row.shows !== undefined) assert.deepEqual(row.shows(body), row.expected);
    });
  }
});

test("invariant 13: the lab explorer's routes need no session, give every inquiry and run with its steps, and run a message as the lab explorer's own client", async (t) => {
  const dana = signedIn(desk, DANA, 'access-lab-dana', 3_600_000, 'refresh-lab-dana');
  const riley = signedIn(desk, RILEY, 'access-lab-riley', 3_600_000, 'refresh-lab-riley');
  const danaInquiry = String(at((await inquire(dana, 'A message with steps')).body, 'inquiry', 'id'));
  const danaRun = String(at(await settled(desk, danaInquiry, dana), 'runs', 0, 'id'));
  const rileyRun = String(at(await settled(desk, String(at((await inquire(riley, "Riley's lab inquiry")).body, 'inquiry', 'id')), riley), 'runs', 0, 'id'));
  const desks = async (path: string): Promise<unknown> => (await call(`${desk.url}${path}`, { cookie: riley })).body;
  const runs = (body: unknown): unknown[] => [at(body, 'traces')].flat();
  // Each row is called with no cookie; its expected answer is what the contract says, or what the named /api route gives.
  const rows = [
    { name: 'the pieces\' state', path: '/lab/api/status', status: 200, shows: (b: unknown) => b, expected: () => desks('/api/status') },
    { name: 'every agent, whoever asks', path: '/lab/api/agents', status: 200, shows: (b: unknown) => [at(b, 'agents')].flat().map((a) => at(a, 'id')), expected: () => agents.map((a) => a.id) },
    { name: 'the prepared inquiries', path: '/lab/api/samples', status: 200, shows: (b: unknown) => b, expected: () => desks('/api/samples') },
    {
      name: "both people's runs",
      path: '/lab/api/runs',
      status: 200,
      shows: (b: unknown) => [danaRun, rileyRun].map((id) => at(runs(b).find((r) => at(r, 'run_id') === id), 'started_by', 'name')),
      expected: () => [DANA.name, RILEY.name],
    },
    { name: "one run's steps and its message", path: `/lab/api/runs/${danaRun}`, status: 200, shows: (b: unknown) => [at(b, 'trace', 'run', 'response', 'steps'), at(b, 'trace', 'inquiry', 'text')], expected: () => [WITH_STEP.steps, 'A message with steps'] },
    { name: 'an inquiry with every run of it, steps included', path: `/lab/api/inquiries/${danaInquiry}`, status: 200, shows: (b: unknown) => [at(b, 'inquiry', 'text'), [at(b, 'inquiry', 'runs')].flat().map((r) => [at(r, 'id'), at(r, 'response', 'steps')])], expected: () => ['A message with steps', [[danaRun, WITH_STEP.steps]]] },
    {
      name: "a new message run through an agent, with the token got as the lab explorer's client for that agent's scope, entered by the lab explorer",
      path: '/lab/api/runs',
      method: 'POST',
      body: { agent_id: 'expert', sender: 'A clinician', text: 'A lab message' },
      status: 202,
      shows: async (b: unknown) => {
        const seen = await agent.waitFor((r) => textOf(r) === 'A lab message');
        const inquiry = at((await call(`${desk.url}/lab/api/inquiries/${String(at(b, 'inquiry_id'))}`)).body, 'inquiry');
        return [seen.authorization, at(inquiry, 'entered_by', 'name'), at(inquiry, 'runs', 0, 'id') === at(b, 'run_id'), at(inquiry, 'runs', 0, 'started_by', 'name')];
      },
      expected: () => ['Bearer lab-explorer for agents:expert', 'Lab explorer', true, 'Lab explorer'],
    },
    { name: 'a POST to a route that only reads', path: '/lab/api/agents', method: 'POST', status: 405, shows: (b: unknown, allow: string | null) => [at(b, 'error'), allow], expected: () => ['method_not_allowed', 'GET'] },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      const response = await fetch(`${desk.url}${row.path}`, { method: row.method ?? 'GET', body: row.body === undefined ? undefined : JSON.stringify(row.body) });
      const body: unknown = await response.json();
      assert.equal(response.status, row.status);
      assert.deepEqual(await row.shows(body, response.headers.get('allow')), await row.expected());
    });
  }
});

test('invariant 14: a message through the contact form is stored and handed to the orchestrator as its own client; the sender is told only when it was received', async (t) => {
  const dana = signedIn(desk, DANA, 'access-contact-dana', 3_600_000, 'refresh-contact-dana');
  const contact = (body: unknown) => call(`${desk.url}/contact/api/messages`, { method: 'POST', body });
  const message = (text: string) => ({ name: 'Dr Synthetic', role: 'cardiology', contact: 'synthetic@example.org', text });
  // The inquiry in the desk's list with that text, once its runs have ended, read by its id.
  const inInbox = async (text: string): Promise<unknown> => {
    const found = [at((await call(`${desk.url}/api/inquiries`, { cookie: dana })).body, 'inquiries')].flat().find((i) => at(i, 'text') === text);
    return found === undefined ? undefined : settled(desk, String(at(found, 'id')), dana);
  };
  const rows = [
    {
      name: 'answered 202 with only received_at; in the inbox, entered by the contact form, with a run of the orchestrator sent with its token',
      shows: async () => {
        const reply = await contact(message('Through the contact form'));
        const inquiry = await inInbox('Through the contact form');
        const seen = await agent.waitFor((r) => textOf(r) === 'Through the contact form');
        return [reply.status, Object.keys(Object(reply.body)), at(inquiry, 'entered_by', 'name'), at(inquiry, 'sender'), [at(inquiry, 'runs')].flat().map((r) => [at(r, 'agent_id'), at(r, 'started_by', 'name')]), seen.authorization];
      },
      expected: [202, ['received_at'], 'Contact form', 'Dr Synthetic, cardiology, synthetic@example.org', [['orchestrator', 'Contact form']], 'Bearer contact-form for agents:orchestrator'],
    },
    {
      name: 'the token cannot be got: still 202 with only received_at, and the run is failed',
      shows: async () => {
        machine.refuse = true;
        try {
          const reply = await contact(message('Token refused'));
          const inquiry = await inInbox('Token refused');
          return [reply.status, Object.keys(Object(reply.body)), at(inquiry, 'runs', 0, 'state'), agent.received.some((r) => textOf(r) === 'Token refused')];
        } finally {
          machine.refuse = false;
        }
      },
      expected: [202, ['received_at'], 'failed', false],
    },
    {
      name: 'a body missing a field is 400 and stores nothing',
      shows: async () => {
        const { contact: missing, ...rest } = message('Missing its contact');
        void missing;
        const reply = await contact(rest);
        return [reply.status, at(reply.body, 'error'), await listed(dana, 'Missing its contact')];
      },
      expected: [400, 'bad_request', false],
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => assert.deepEqual(await row.shows(), row.expected));
  }
});

test('probe: the built app is served, and any other path is its page', async () => {
  const script = await fetch(`${desk.url}/assets/app.js`);
  assert.equal(await script.text(), 'the app script');
  const page = await fetch(`${desk.url}/cases/AE-1`);
  assert.equal(await page.text(), 'the app page');
});
