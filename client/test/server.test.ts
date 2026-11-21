// Drives the client's server over loopback, with a stand-in agent (below) where an agent is needed.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { createReviewServer } from '../../tools/case-system/src/http.ts';
import { CaseStore } from '../../tools/case-system/src/store.ts';
import { SAMPLES } from '../src/samples.ts';
import { IdentityProvider } from '../src/identity.ts';
import { createClientServer } from '../src/server.ts';
import { SessionStore } from '../src/sessions.ts';
import { InquiryStore } from '../src/store.ts';
import {
  EXAMPLE_RESPONSE,
  RILEY,
  caseSystemCheck,
  clientConfig,
  deadUrl,
  eventually,
  fetchAs,
  getJson,
  listen,
  postJson,
  prop,
  seededRandom,
  sequentialIds,
  settableClock,
  signIn,
  startClient,
  startIssuer,
  steppingClock,
  stop,
  tempDir,
} from './helpers.ts';
import type { Answer, RunningClient } from './helpers.ts';

// --- Stand-in agent ---------------------------------------------------------------------------------
// NOT an agent. A tiny HTTP server that speaks the agent contract (GET /ping, POST /invocations) so
// the client's handling of each kind of answer can be tested before any real agent exists.

type StandInMode = 'correct' | 'label_answer' | 'failed_outcome' | 'outside_contract' | 'status_500' | 'never_answer';

const LABEL_SET_ID = '00000000-0000-4000-8000-0000000000a1';
const LABEL_SOURCE = `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${LABEL_SET_ID}&version=3`;

// What an agent that answers from drug labels returns: label_answer, citations with their sources, and a
// retrieval step whose hits say which passages the model was shown. Every word is invented.
const LABEL_RESPONSE = {
  ...EXAMPLE_RESPONSE,
  reply: 'Take it with food [1]; do not exceed the stated dose [2].',
  label_answer: 'answered',
  case_actions: [],
  citations: [
    {
      drug: 'Examplamab',
      section: '2.1 Invented dosing',
      quote: 'Invented passage one.',
      set_id: LABEL_SET_ID,
      version: 3,
      effective_date: '20260130',
      source: LABEL_SOURCE,
      passage: `${LABEL_SET_ID}/3/sec-1/body/1`,
    },
    {
      drug: 'Examplamab',
      section: '2.2 Invented limits',
      quote: 'Invented passage two.',
      set_id: LABEL_SET_ID,
      version: 3,
      effective_date: '20260130',
      source: LABEL_SOURCE,
      passage: `${LABEL_SET_ID}/3/sec-2/body/1`,
    },
  ],
  steps: [
    {
      kind: 'retrieval',
      started_at: '2026-03-01T09:00:01.100Z',
      duration_ms: 14,
      query: 'invented dosing',
      strategy: 'bm25',
      hits: [
        { drug: 'Examplamab', section: '2.1 Invented dosing', score: 7.5, excerpt: 'Invented passage one.', passage: `${LABEL_SET_ID}/3/sec-1/body/1`, handle: 'P1', shown: true },
        { drug: 'Examplamab', section: '9 Invented other', score: 1.25, excerpt: 'Invented passage three.', passage: `${LABEL_SET_ID}/3/sec-9/body/1`, handle: 'P2', shown: false },
      ],
    },
  ],
};

type StandInAgent = {
  url: string;
  // Every body received at /invocations, parsed, in order.
  received: unknown[];
  // The Authorization header of every request to /invocations, in the same order, and of every /ping.
  authorizations: (string | undefined)[];
  pingAuthorizations: (string | undefined)[];
  setMode: (mode: StandInMode) => void;
};

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed;
}

async function startStandInAgent(t: TestContext, initial: StandInMode): Promise<StandInAgent> {
  let mode = initial;
  const received: unknown[] = [];
  const authorizations: (string | undefined)[] = [];
  const pingAuthorizations: (string | undefined)[] = [];

  function answer(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === '/ping' && request.method === 'GET') {
      pingAuthorizations.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'Healthy' }));
      return;
    }
    if (request.url !== '/invocations' || request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    bodyOf(request)
      .then((body) => {
        received.push(body);
        authorizations.push(request.headers.authorization);
        switch (mode) {
          case 'correct':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(EXAMPLE_RESPONSE));
            return;
          case 'label_answer':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(LABEL_RESPONSE));
            return;
          case 'failed_outcome':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ...EXAMPLE_RESPONSE, outcome: 'failed', case_actions: [] }));
            return;
          case 'outside_contract':
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ...EXAMPLE_RESPONSE, outcome: 'finished' }));
            return;
          case 'status_500':
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'boom' }));
            return;
          case 'never_answer':
            // Holds the connection open. The test's teardown closes it.
            return;
        }
      })
      .catch((error: unknown) => {
        response.writeHead(400);
        response.end(String(error));
      });
  }

  const server = createServer(answer);
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return {
    url,
    received,
    authorizations,
    pingAuthorizations,
    setMode: (next) => {
      mode = next;
    },
  };
}

const SENDER = 'Dr. Priya Raman, p.raman@example.org';
const TEXT = 'What is the maximum dose of atorvastatin with clarithromycin?';

async function withAgent(
  t: TestContext,
  mode: StandInMode,
  agentTimeoutMs?: number,
): Promise<{ agent: StandInAgent; client: RunningClient }> {
  const agent = await startStandInAgent(t, mode);
  const client = await startClient(t, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: 'Test stand-in agent.', url: agent.url }],
    caseReviewUrl: await deadUrl(t),
    webRoot: tempDir(t),
    ...(agentTimeoutMs === undefined ? {} : { agentTimeoutMs }),
  });
  return { agent, client };
}

function runsOf(answer: Answer): unknown[] {
  const runs = prop(prop(answer.body, 'inquiry'), 'runs');
  assert.ok(Array.isArray(runs));
  return runs;
}

// Waits until no run of the inquiry is still running, and returns the inquiry as the API gives it.
async function settled(client: RunningClient, inquiryId: string): Promise<Answer> {
  return eventually(
    () => getJson(`${client.url}/api/inquiries/${inquiryId}`),
    (answer) => runsOf(answer).every((run) => prop(run, 'state') !== 'running'),
  );
}

async function send(client: RunningClient, agentId = 'stand-in'): Promise<Answer> {
  return postJson(`${client.url}/api/inquiries`, { sender: `  ${SENDER} `, text: TEXT, agent_id: agentId });
}

const RUNNING = {
  id: 'id-2',
  inquiry_id: 'id-1',
  agent_id: 'stand-in',
  state: 'running',
  started_at: '2026-03-01T09:00:01.000Z',
  started_by: { name: 'Riley Reviewer' },
  finished_at: null,
  duration_ms: null,
  error: null,
  response: null,
};

test('a new inquiry answers 202 with a running run, and later reads back completed with the response', async (t) => {
  const { agent, client } = await withAgent(t, 'correct');

  const accepted = await send(client);
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, {
    inquiry: {
      id: 'id-1',
      received_at: '2026-03-01T09:00:00.000Z',
      entered_by: { name: 'Riley Reviewer' },
      sender: SENDER,
      text: TEXT,
      runs: [RUNNING],
    },
  });

  const done = await settled(client, 'id-1');
  assert.deepEqual(done.body, {
    inquiry: {
      id: 'id-1',
      received_at: '2026-03-01T09:00:00.000Z',
      entered_by: { name: 'Riley Reviewer' },
      sender: SENDER,
      text: TEXT,
      runs: [
        {
          ...RUNNING,
          state: 'completed',
          finished_at: '2026-03-01T09:00:02.000Z',
          duration_ms: 1000,
          response: EXAMPLE_RESPONSE,
        },
      ],
    },
  });

  // The agent was sent exactly the message, as stamped when it was received.
  assert.deepEqual(agent.received, [
    { message: { id: 'id-1', received_at: '2026-03-01T09:00:00.000Z', sender: SENDER, text: TEXT } },
  ]);

  const listed = await getJson(`${client.url}/api/inquiries`);
  assert.deepEqual(listed.body, {
    inquiries: [
      {
        id: 'id-1',
        received_at: '2026-03-01T09:00:00.000Z',
        sender: SENDER,
        text: TEXT,
        runs: [{ id: 'id-2', agent_id: 'stand-in', state: 'completed', case_ids: ['AE-000001'] }],
      },
    ],
    truncated: false,
  });
});

test('C5. label_answer, citations and a retrieval step come back from the client API unchanged', async (t) => {
  const { client } = await withAgent(t, 'label_answer');
  await send(client);
  const [run] = runsOf(await settled(client, 'id-1'));
  assert.equal(prop(run, 'state'), 'completed');
  assert.equal(prop(run, 'error'), null);
  assert.deepEqual(prop(run, 'response'), LABEL_RESPONSE);
});

test('running an inquiry again sends the same id and receipt time to the agent', async (t) => {
  const { agent, client } = await withAgent(t, 'correct');
  await send(client);
  await settled(client, 'id-1');

  const again = await postJson(`${client.url}/api/inquiries/id-1/runs`, { agent_id: 'stand-in' });
  assert.equal(again.status, 202);
  assert.deepEqual(again.body, { run: { ...RUNNING, id: 'id-3', started_at: '2026-03-01T09:00:03.000Z' } });

  const done = await settled(client, 'id-1');
  assert.deepEqual(
    runsOf(done).map((run) => [prop(run, 'id'), prop(run, 'state')]),
    [
      ['id-2', 'completed'],
      ['id-3', 'completed'],
    ],
  );
  assert.equal(agent.received.length, 2);
  assert.deepEqual(agent.received[1], agent.received[0]);
});

test('an answer whose outcome is failed is still a completed run: the agent kept to the contract', async (t) => {
  const { client } = await withAgent(t, 'failed_outcome');
  await send(client);
  const [run] = runsOf(await settled(client, 'id-1'));
  assert.equal(prop(run, 'state'), 'completed');
  assert.equal(prop(prop(run, 'response'), 'outcome'), 'failed');
  assert.equal(prop(run, 'error'), null);
});

async function failureOf(t: TestContext, mode: StandInMode, agentTimeoutMs?: number): Promise<unknown> {
  const { client } = await withAgent(t, mode, agentTimeoutMs);
  const accepted = await send(client);
  assert.equal(accepted.status, 202);
  const [run] = runsOf(await settled(client, 'id-1'));
  assert.equal(prop(run, 'state'), 'failed');
  assert.equal(prop(run, 'response'), null);
  assert.equal(prop(run, 'finished_at'), '2026-03-01T09:00:02.000Z');
  return prop(run, 'error');
}

test('an answer outside the contract fails the run and names the first problem', async (t) => {
  const error = await failureOf(t, 'outside_contract');
  assert.ok(typeof error === 'string');
  assert.match(error, /^The agent's answer did not match the contract: outcome: .+/);
});

test('an answer with status 500 fails the run with the status', async (t) => {
  assert.equal(await failureOf(t, 'status_500'), 'The agent answered with status 500.');
});

test('an agent that never answers fails the run when the timeout passes', async (t) => {
  assert.equal(await failureOf(t, 'never_answer', 200), 'The agent did not answer within 0.2 seconds.');
});

test('an agent that cannot be reached fails the run and says so', async (t) => {
  const client = await startClient(t, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: '', url: await deadUrl(t) }],
    caseReviewUrl: await deadUrl(t),
    webRoot: tempDir(t),
  });
  await send(client);
  const [run] = runsOf(await settled(client, 'id-1'));
  const error = prop(run, 'error');
  assert.ok(typeof error === 'string');
  assert.match(error, /^Could not reach the agent: .+/);
});

test('an inquiry is refused with 400, and nothing is stored, when it is malformed or names an unknown agent', async (t) => {
  const { agent, client } = await withAgent(t, 'correct');
  const post = (payload: unknown): Promise<Answer> => postJson(`${client.url}/api/inquiries`, payload);

  const unknown = await post({ sender: SENDER, text: TEXT, agent_id: 'nobody' });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body, { error: 'unknown_agent', detail: 'No agent with the id "nobody" is configured.' });

  for (const payload of [
    { sender: '  ', text: TEXT, agent_id: 'stand-in' },
    { sender: SENDER, text: '', agent_id: 'stand-in' },
    { sender: SENDER, text: 42, agent_id: 'stand-in' },
    { sender: SENDER, text: 'x'.repeat(10_001), agent_id: 'stand-in' },
    { sender: SENDER, text: TEXT },
    [SENDER, TEXT],
  ]) {
    const refused = await post(payload);
    assert.equal(refused.status, 400, JSON.stringify(payload).slice(0, 80));
    assert.equal(prop(refused.body, 'error'), 'bad_request');
    assert.equal(typeof prop(refused.body, 'detail'), 'string');
  }

  const notJson = await fetchAs(`${client.url}/api/inquiries`, { method: 'POST', body: '{not json' });
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: 'bad_request', detail: 'The request body is not JSON.' });

  const tooLarge = await fetchAs(`${client.url}/api/inquiries`, {
    method: 'POST',
    body: JSON.stringify({ sender: SENDER, text: 'x'.repeat(1_100_000), agent_id: 'stand-in' }),
  });
  assert.equal(tooLarge.status, 400);
  assert.deepEqual(await tooLarge.json(), { error: 'bad_request', detail: 'The request body is larger than 1 MB.' });

  assert.deepEqual((await getJson(`${client.url}/api/inquiries`)).body, { inquiries: [], truncated: false });
  assert.deepEqual(agent.received, []);
});

test('text of exactly the maximum length is accepted', async (t) => {
  const { client } = await withAgent(t, 'correct');
  const accepted = await postJson(`${client.url}/api/inquiries`, { sender: SENDER, text: 'x'.repeat(10_000), agent_id: 'stand-in' });
  assert.equal(accepted.status, 202);
  await settled(client, 'id-1');
});

test('a run of an inquiry that does not exist is 404; one naming an unknown agent is 400', async (t) => {
  const { client } = await withAgent(t, 'correct');
  const missing = await postJson(`${client.url}/api/inquiries/nope/runs`, { agent_id: 'stand-in' });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'inquiry_not_found', detail: 'No inquiry has the id "nope".' });

  await send(client);
  await settled(client, 'id-1');
  const unknown = await postJson(`${client.url}/api/inquiries/id-1/runs`, { agent_id: 'nobody' });
  assert.equal(unknown.status, 400);
  assert.equal(prop(unknown.body, 'error'), 'unknown_agent');

  const read = await getJson(`${client.url}/api/inquiries/nope`);
  assert.equal(read.status, 404);
  assert.equal(prop(read.body, 'error'), 'inquiry_not_found');
});

test('agents are listed without their URLs, and the samples are served as written', async (t) => {
  const { client } = await withAgent(t, 'correct');
  assert.deepEqual((await getJson(`${client.url}/api/agents`)).body, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: 'Test stand-in agent.' }],
  });
  assert.deepEqual((await getJson(`${client.url}/api/samples`)).body, { samples: SAMPLES });
});

test('an unknown API path is 404 and a wrong method on a known one is 405, both with an ApiError', async (t) => {
  const { client } = await withAgent(t, 'correct');

  const missing = await getJson(`${client.url}/api/nothing-here`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'not_found', detail: 'There is no API route /api/nothing-here.' });

  const wrong = await fetchAs(`${client.url}/api/inquiries`, { method: 'DELETE' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, POST');
  assert.deepEqual(await wrong.json(), { error: 'method_not_allowed', detail: '/api/inquiries accepts GET, POST.' });

  const postStatus = await postJson(`${client.url}/api/status`, {});
  assert.equal(postStatus.status, 405);
  assert.equal(prop(postStatus.body, 'error'), 'method_not_allowed');
});

test('an unexpected failure is a 500 internal_error with no stack trace', async (t) => {
  const store = new InquiryStore(':memory:', steppingClock('2026-03-01T09:00:00Z'));
  const clock = settableClock('2026-03-01T09:00:00Z');
  const issuer = await startIssuer(t, clock);
  const config = clientConfig({
    caseReviewUrl: await deadUrl(t),
    agents: [],
    webRoot: tempDir(t),
    discoveryUrl: issuer.discoveryUrl,
    revocationEndpoint: issuer.revocationUrl,
  });
  const server = createClientServer({
    config,
    store,
    now: () => new Date('2026-03-01T09:00:00Z'),
    newId: sequentialIds('id'),
    agentTimeoutMs: 1000,
    identity: new IdentityProvider(config.oidc, { claim: 'roles', reviewerRole: 'reviewer' }, clock.now),
    sessions: new SessionStore(clock.now, seededRandom('closed-store')),
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  await signIn(url, issuer, RILEY);
  // A closed database makes the next read throw, which no route expects.
  store.close();
  const failed = await getJson(`${url}/api/inquiries`);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, {
    error: 'internal_error',
    detail: 'The client failed while handling the request. The cause is in its log.',
  });
});

test('status reports the case system and each agent as up when they answer the health check', async (t) => {
  const agent = await startStandInAgent(t, 'correct');
  const caseStore = new CaseStore(':memory:', () => new Date('2026-01-01T00:00:00Z'));
  // Only its health check is asked, which needs no token; its token check is never reached.
  const unusedIdentity = { issuer: await startIssuer(t, settableClock('2026-01-01T00:00:00Z')), clock: settableClock('2026-01-01T00:00:00Z') };
  const reviewServer = createReviewServer(caseStore, caseSystemCheck(unusedIdentity.issuer, unusedIdentity.clock), 'reviewer');
  t.after(() => {
    stop(reviewServer);
    caseStore.close();
  });
  const client = await startClient(t, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: 'Test stand-in agent.', url: agent.url }],
    caseReviewUrl: await listen(reviewServer),
    webRoot: tempDir(t),
  });
  assert.deepEqual((await getJson(`${client.url}/api/status`)).body, {
    checked_at: '2026-03-01T09:00:00.000Z',
    pieces: [
      {
        id: 'case-system',
        name: 'Case system',
        role: "Holds adverse event cases and records reviewers' decisions.",
        state: 'up',
        detail: 'Answered the health check.',
      },
      { id: 'stand-in', name: 'Stand-in', role: 'Test stand-in agent.', state: 'up', detail: 'Answered the health check.' },
      {
        id: 'identity',
        name: 'Identity provider',
        role: 'Signs desk staff in and issues the tokens sent to agents and the case system.',
        state: 'up',
        detail: 'Answered the health check.',
      },
      {
        id: 'knowledge',
        name: 'Label search',
        role: 'Finds the passages of the approved label that answer a question.',
        state: 'not_built',
        detail: 'Not built yet.',
      },
      {
        id: 'evaluation',
        name: 'Evaluation',
        role: 'Scores the agents against a set of prepared inquiries.',
        state: 'not_built',
        detail: 'Not built yet.',
      },
    ],
  });
});

test('status reports pieces that cannot be reached as down, with the reason', async (t) => {
  const client = await startClient(t, {
    agents: [{ id: 'gone', name: 'Gone', description: 'Not running.', url: await deadUrl(t) }],
    caseReviewUrl: await deadUrl(t),
    webRoot: tempDir(t),
  });
  const pieces = prop((await getJson(`${client.url}/api/status`)).body, 'pieces');
  assert.ok(Array.isArray(pieces));
  assert.deepEqual(
    pieces.map((piece) => [prop(piece, 'id'), prop(piece, 'state')]),
    [
      ['case-system', 'down'],
      ['gone', 'down'],
      ['identity', 'up'],
      ['knowledge', 'not_built'],
      ['evaluation', 'not_built'],
    ],
  );
  for (const piece of pieces.slice(0, 2)) {
    const detail = prop(piece, 'detail');
    assert.ok(typeof detail === 'string');
    assert.match(detail, /^Could not reach it: .+/);
  }
});

test('with no agent configured, status says so in a single agents piece', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t) });
  const pieces = prop((await getJson(`${client.url}/api/status`)).body, 'pieces');
  assert.ok(Array.isArray(pieces));
  assert.deepEqual(pieces.map((piece) => prop(piece, 'id')), ['case-system', 'agents', 'identity', 'knowledge', 'evaluation']);
  assert.deepEqual(pieces[1], {
    id: 'agents',
    name: 'Agents',
    role: 'Handle inquiries: answer from the label and open adverse event cases.',
    state: 'not_built',
    detail: 'No agent is configured.',
  });
});
