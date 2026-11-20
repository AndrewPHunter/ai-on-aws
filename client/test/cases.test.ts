// Case review through the client, against the real case system run in this process.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { CONTEXT_HEADERS, createAgentServer, createReviewServer } from '../../tools/case-system/src/http.ts';
import { CaseStore } from '../../tools/case-system/src/store.ts';
import { deadUrl, getJson, listen, postJson, prop, startClient, stop, tempDir } from './helpers.ts';

type Running = { clientUrl: string; reviewUrl: string };

const COMPLETE = {
  patient: 'JD, 54, male',
  reporter: 'Dr A. Rivera, a.rivera@example.org',
  suspect_drug: 'atorvastatin',
  event: 'severe muscle pain',
};

// Starts the case system, opens one complete case through its MCP endpoint as an agent would,
// and starts a client pointed at its review server.
async function start(t: TestContext): Promise<Running> {
  let seconds = 0;
  const store = new CaseStore(':memory:', () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)));
  const agentServer = createAgentServer(store, () => new Date('2026-01-01T00:00:00Z'));
  const reviewServer = createReviewServer(store);
  t.after(() => {
    stop(agentServer);
    stop(reviewServer);
    store.close();
  });
  const agentUrl = await listen(agentServer);
  const reviewUrl = await listen(reviewServer);

  const mcp = new Client({ name: 'client-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${agentUrl}/mcp`), {
    requestInit: {
      headers: {
        [CONTEXT_HEADERS.messageId]: 'm1',
        [CONTEXT_HEADERS.receivedAt]: '2025-12-31T23:00:00Z',
        [CONTEXT_HEADERS.agentId]: 'intake-agent',
      },
    },
  });
  await mcp.connect(transport);
  const created = await mcp.callTool({ name: 'create_case', arguments: COMPLETE });
  assert.notEqual(created.isError, true);
  await mcp.close();

  const client = await startClient(t, { agents: [], caseReviewUrl: reviewUrl, webRoot: tempDir(t) });
  return { clientUrl: client.url, reviewUrl };
}

test('cases are listed through the client exactly as the review server lists them', async (t) => {
  const { clientUrl, reviewUrl } = await start(t);

  const listed = await getJson(`${clientUrl}/api/cases`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, (await getJson(`${reviewUrl}/cases`)).body);
  const cases = prop(listed.body, 'cases');
  assert.ok(Array.isArray(cases));
  assert.deepEqual(
    cases.map((found) => [prop(found, 'case_id'), prop(found, 'status')]),
    [['AE-000001', 'awaiting_review']],
  );

  const approved = await getJson(`${clientUrl}/api/cases?status=approved`);
  assert.deepEqual(approved.body, { cases: [], truncated: false });

  const bogus = await getJson(`${clientUrl}/api/cases?status=bogus`);
  assert.equal(bogus.status, 400);
  assert.deepEqual(bogus.body, (await getJson(`${reviewUrl}/cases?status=bogus`)).body);
});

test('one case is read through the client with its versions and audit trail; a missing one is 404', async (t) => {
  const { clientUrl, reviewUrl } = await start(t);

  const record = await getJson(`${clientUrl}/api/cases/AE-000001`);
  assert.equal(record.status, 200);
  assert.deepEqual(record.body, (await getJson(`${reviewUrl}/cases/AE-000001`)).body);
  assert.equal(prop(prop(record.body, 'case'), 'case_id'), 'AE-000001');

  const missing = await getJson(`${clientUrl}/api/cases/AE-999999`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'case_not_found' });
});

test('a review is forwarded: approve once is 200, twice is 409, and no reviewer is 400', async (t) => {
  const { clientUrl } = await start(t);
  const review = (payload: unknown): ReturnType<typeof postJson> =>
    postJson(`${clientUrl}/api/cases/AE-000001/review`, payload);

  const noReviewer = await review({ decision: 'approve' });
  assert.equal(noReviewer.status, 400);
  assert.deepEqual(noReviewer.body, { error: 'bad_request', detail: '"reviewer" is required' });

  const approved = await review({ reviewer: 'r.okafor', decision: 'approve' });
  assert.equal(approved.status, 200);
  assert.equal(prop(prop(approved.body, 'case'), 'status'), 'approved');

  const twice = await review({ reviewer: 'r.okafor', decision: 'approve' });
  assert.equal(twice.status, 409);
  assert.deepEqual(twice.body, {
    error: 'not_allowed',
    detail: 'A case that is approved cannot be given the decision approve.',
  });

  const record = await getJson(`${clientUrl}/api/cases/AE-000001`);
  const audit = prop(record.body, 'audit');
  assert.ok(Array.isArray(audit));
  assert.deepEqual(
    audit.map((entry) => [prop(entry, 'action'), prop(entry, 'actor')]),
    [
      ['case_created', 'intake-agent'],
      ['review_approve', 'r.okafor'],
    ],
  );
});

test('a case system that cannot be reached is 502 with an ApiError', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t) });
  for (const answer of [
    await getJson(`${client.url}/api/cases`),
    await getJson(`${client.url}/api/cases/AE-000001`),
    await postJson(`${client.url}/api/cases/AE-000001/review`, { reviewer: 'r.okafor', decision: 'approve' }),
  ]) {
    assert.equal(answer.status, 502);
    assert.equal(prop(answer.body, 'error'), 'case_system_unreachable');
    const detail = prop(answer.body, 'detail');
    assert.ok(typeof detail === 'string');
    assert.match(detail, /^Could not reach the case system: .+/);
  }
});
