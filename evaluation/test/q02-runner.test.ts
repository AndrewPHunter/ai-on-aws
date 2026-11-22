// Q02 to Q06. The runner, against a labelled stand-in agent: the contract's request with a bearer token, at most 4 at
// once, each response recorded whole with its status and duration; tokens replaced before they have under 200 s left,
// and a 401 recorded, not retried; resuming and --retry-failed; each kind of failed call; two strategies stop the run.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { inboundMessageSchema } from '../../shared/agent-contract.ts';
import { readRecords, runQuestions } from '../src/run.ts';
import type { RunOptions } from '../src/run.ts';
import { TokenSource } from '../src/sign-in.ts';
import type { Question } from '../src/benchmark.ts';
import { folder, question, response, startAgentStandIn } from './support.ts';
import type { AgentReply, AgentRequest } from './support.ts';

const questions = (n: number): Question[] => Array.from({ length: n }, (_, i) => question(`q${i}`, 'factual'));

async function options(runDir: string, url: string, overrides: Partial<RunOptions> = {}): Promise<RunOptions> {
  return {
    questions: questions(6),
    sampleSha256: 'a'.repeat(64),
    runDir,
    agentUrl: url,
    token: () => Promise.resolve('token-1'),
    retryFailed: false,
    now: () => new Date('2026-03-01T10:00:00.000Z'),
    fetch: globalThis.fetch,
    log: () => {},
    ...overrides,
  };
}

const ok = (): AgentReply => ({ status: 200, body: response({ labelAnswer: 'answered' }), delayMs: 30 });

test('Q02. the contract request with a bearer token, at most 4 at once, each response recorded whole with status and duration', async (t) => {
  const dir = await folder(t);
  const agent = await startAgentStandIn(t, ok);

  const result = await runQuestions(await options(dir, agent.url, { questions: questions(10) }));

  assert.equal(result.exitCode, 0);
  assert.equal(agent.received.length, 10);
  assert.ok(agent.mostAtOnce() <= 4 && agent.mostAtOnce() >= 2, `${agent.mostAtOnce()} at once`);
  for (const request of agent.received) {
    assert.equal(request.path, '/invocations');
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, 'Bearer token-1');
    const message = inboundMessageSchema.parse((request.body as { message: unknown }).message);
    assert.match(message.text, /^Invented question q\d+\?$/);
  }
  const records = await readRecords(dir);
  assert.equal(records.length, 10);
  for (const record of records) {
    assert.equal(record.status, 200);
    assert.equal(record.ok, true);
    assert.ok(record.duration_ms >= 0);
    assert.deepEqual(record.response, response({ labelAnswer: 'answered' }));
  }
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as { agent_id: string; models: string[]; strategies: string[] };
  assert.equal(run.agent_id, 'expert');
  assert.deepEqual(run.models, ['test-model']);
});

test('Q03. a token is replaced before it has under 200 s left; a 401 is recorded as a failure, not retried', async (t) => {
  let now = 0;
  let issued = 0;
  const tokens = new TokenSource(() => Promise.resolve({ token: `token-${++issued}`, expiresAt: now + 600_000 }), () => now);
  assert.equal(await tokens.token(), 'token-1');
  now += 399_000; // 201 s left: kept
  assert.equal(await tokens.token(), 'token-1');
  now += 2_000; // 199 s left: replaced
  assert.equal(await tokens.token(), 'token-2');
  assert.equal(tokens.signIns, 2);

  const dir = await folder(t);
  const agent = await startAgentStandIn(t, () => ({ status: 401, body: { error: 'unauthorized', reason: 'expired' } }));
  const result = await runQuestions(await options(dir, agent.url, { questions: questions(2) }));
  assert.equal(result.exitCode, 1);
  assert.equal(agent.received.length, 2);
  const records = await readRecords(dir);
  assert.deepEqual(records.map((r) => [r.status, r.ok, r.reason]), [
    [401, false, 'status 401'],
    [401, false, 'status 401'],
  ]);
});

test('Q04. resuming sends nothing already recorded; --retry-failed sends only the failures', async (t) => {
  const dir = await folder(t);
  let failing = true;
  const agent = await startAgentStandIn(t, (request: AgentRequest) => {
    const id = (request.body as { message: { id: string } }).message.id;
    return failing && (id === 'eval-q1' || id === 'eval-q4') ? { status: 503, body: { error: 'busy' } } : ok();
  });

  assert.equal((await runQuestions(await options(dir, agent.url))).exitCode, 1);
  assert.equal(agent.received.length, 6);

  // Started again: nothing sent, the failures stay failures.
  const again = await runQuestions(await options(dir, agent.url));
  assert.equal(again.sent, 0);
  assert.equal(again.exitCode, 1);
  assert.equal(agent.received.length, 6);

  failing = false;
  const retried = await runQuestions(await options(dir, agent.url, { retryFailed: true }));
  assert.equal(retried.exitCode, 0);
  assert.deepEqual(agent.received.slice(6).map((r) => (r.body as { message: { id: string } }).message.id).sort(), ['eval-q1', 'eval-q4']);
});

test('Q05. each kind of failed call is recorded with its reason', async (t) => {
  const rows: { reply: AgentReply; reason: string; status: number | null }[] = [
    { reply: 'hold', reason: 'no answer within 0.2 s', status: null },
    { reply: { status: 500, body: { error: 'internal' } }, reason: 'status 500', status: 500 },
    { reply: { status: 200, raw: 'not json at all' }, reason: 'the body is not JSON', status: 200 },
    { reply: { status: 200, body: { outcome: 'completed' } }, reason: 'the answer is outside the agent contract', status: 200 },
  ];
  for (const row of rows) {
    const dir = await folder(t);
    const agent = await startAgentStandIn(t, () => row.reply);
    const result = await runQuestions(await options(dir, agent.url, { questions: questions(1), callTimeoutMs: 200 }));
    assert.equal(result.exitCode, 1, row.reason);
    const [only] = await readRecords(dir);
    assert.equal(only?.ok, false);
    assert.equal(only?.reason, row.reason);
    assert.equal(only?.status, row.status);
  }
});

test('Q06. two strategies in one run stop it', async (t) => {
  const dir = await folder(t);
  let n = 0;
  const agent = await startAgentStandIn(t, () => ({
    status: 200,
    body: response({ labelAnswer: 'answered', searches: [{ strategy: n++ < 2 ? 'keyword' : 'vector', hits: [] }] }),
  }));
  const result = await runQuestions(await options(dir, agent.url, { questions: questions(8), concurrency: 1 }));
  assert.equal(result.exitCode, 2);
  assert.ok(agent.received.length < 8);
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as { strategies: string[] };
  assert.deepEqual(run.strategies, ['keyword', 'vector']);
});
