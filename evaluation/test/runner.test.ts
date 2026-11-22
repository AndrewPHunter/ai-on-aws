// The runner's invariants ("Always true" 1 to 5 in docs/architecture/evaluation.md), against an in-memory agent: the
// runner is given its fetch function, its token function and its clock as values, so no server is started.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { invocationRequestSchema } from '../../shared/agent-contract.ts';
import { readRecords, runQuestions } from '../src/run.ts';
import type { RunOptions } from '../src/run.ts';
import { TokenSource } from '../src/sign-in.ts';
import { agent, answered, folder, question, response } from './support.ts';
import type { Answer } from './support.ts';

const questions = (n: number) => Array.from({ length: n }, (_, i) => question(`q${i}`, 'factual'));
const qidOf = (text: string): string => text.replace(/^Invented question (.*)\?$/, '$1');

const options = (runDir: string, fetch: typeof globalThis.fetch, overrides: Partial<RunOptions> = {}): RunOptions => ({
  questions: questions(1),
  variant: 'original',
  sampleSha256: 'a'.repeat(64),
  runDir,
  agentUrl: 'http://agent.test',
  token: () => Promise.resolve('token-1'),
  retryFailed: false,
  now: () => new Date('2026-03-01T10:00:00.000Z'),
  fetch,
  log: () => {},
  ...overrides,
});

test('evaluation 1. a question is sent as a client sends it: POST /invocations, the contract request, a bearer token; the response is recorded whole', async (t) => {
  const dir = await folder(t);
  const body = response({ labelAnswer: 'answered' });
  const stand = agent(() => answered(body));
  const sent = question('q1', 'factual', { question: 'Invented question one?' });

  const result = await runQuestions(options(dir, stand.fetch, { questions: [sent], token: () => Promise.resolve('token-from-sign-in') }));

  assert.equal(result.exitCode, 0);
  const [call] = stand.sent;
  assert.deepEqual([call?.url, call?.method, call?.authorization], ['http://agent.test/invocations', 'POST', 'Bearer token-from-sign-in']);
  assert.equal(invocationRequestSchema.parse(call?.body).message.text, 'Invented question one?');
  const [stored] = await readRecords(dir);
  assert.deepEqual(stored?.response, body);
});

test('evaluation 2. a token is replaced before it has under 200 s left', async () => {
  let now = 0;
  let issued = 0;
  const tokens = new TokenSource(() => Promise.resolve({ token: `token-${++issued}`, expiresAt: now + 600_000 }), () => now);
  assert.equal(await tokens.token(), 'token-1');
  for (const [at, expected] of [
    [399_000, 'token-1'], // 201 s left: kept
    [401_000, 'token-2'], // 199 s left: replaced
  ] as const) {
    now = at;
    assert.equal(await tokens.token(), expected, `at ${at} ms`);
  }
});

test('evaluation 3. at most 4 calls to the agent are in flight at once', async (t) => {
  const dir = await folder(t);
  let open = 0;
  let most = 0;
  const held: (() => void)[] = [];
  const stand = agent(async () => {
    open++;
    most = Math.max(most, open);
    await new Promise<void>((resolve) => held.push(resolve));
    open--;
    return answered();
  });

  let done = false;
  const running = runQuestions(options(dir, stand.fetch, { questions: questions(10) })).finally(() => (done = true));
  // Each time the runner has nothing more to do, one held call is answered.
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    held.shift()?.();
  }

  assert.equal((await running).exitCode, 0);
  assert.equal(stand.sent.length, 10);
  assert.ok(most <= 4 && most > 1, `${most} at once`);
});

test('evaluation 4. every call is recorded once with its result; a failed call is recorded with its reason, counted, and sent again only when asked', async (t) => {
  const dir = await folder(t);
  const failures: [string, Answer][] = [
    ['a status other than 200', { status: 401, body: '{"error":"unauthorized"}' }],
    ['a connection that fails', new TypeError('fetch failed')],
    ['no answer in time', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['a body that is not JSON', { status: 200, body: 'not json' }],
    ['an answer outside the agent contract', { status: 200, body: '{"outcome":"completed"}' }],
  ];
  const all = [...failures.map((_, at) => question(`f${at}`, 'factual')), question('good', 'factual')];
  let failing = true;
  const stand = agent((text) => {
    const at = Number(qidOf(text).slice(1));
    return failing && qidOf(text) !== 'good' ? (failures[at]?.[1] ?? answered()) : answered();
  });

  const first = await runQuestions(options(dir, stand.fetch, { questions: all }));
  assert.deepEqual([first.exitCode, first.failures, stand.sent.length], [1, failures.length, all.length]);
  const records = await readRecords(dir);
  assert.deepEqual(records.map((r) => r.qid).sort(), all.map((q) => q.qid).sort());
  for (const [at, [kind]] of failures.entries()) {
    const failed = records.find((r) => r.qid === `f${at}`);
    assert.equal(failed?.ok, false, kind);
    assert.ok(failed?.reason, kind);
  }
  assert.equal(records.find((r) => r.qid === 'good')?.ok, true);

  // Started again: nothing is sent, and the failures still count.
  const again = await runQuestions(options(dir, stand.fetch, { questions: all }));
  assert.deepEqual([again.exitCode, again.sent, stand.sent.length], [1, 0, all.length]);

  // Asked to: only the failures are sent again.
  failing = false;
  const retried = await runQuestions(options(dir, stand.fetch, { questions: all, retryFailed: true }));
  assert.equal(retried.exitCode, 0);
  assert.deepEqual(stand.sent.slice(all.length).map((s) => qidOf(s.body.message.text)).sort(), failures.map((_, at) => `f${at}`));
});

test('evaluation 5. a run holds one strategy and one variant: a second strategy stops it, the other variant is refused', async (t) => {
  const dir = await folder(t);
  let n = 0;
  const stand = agent(() => answered(response({ labelAnswer: 'answered', strategy: n++ === 0 ? 'keyword' : 'vector' })));

  const mixed = await runQuestions(options(dir, stand.fetch, { questions: questions(12) }));
  assert.equal(mixed.exitCode, 2);
  assert.ok(stand.sent.length < 12, `${stand.sent.length} sent`);
  assert.equal((await readRecords(dir)).length, stand.sent.length);
  const run = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as { strategies: string[] };
  assert.deepEqual(run.strategies, ['keyword', 'vector']);

  const sentBefore = stand.sent.length;
  const other = await runQuestions(options(dir, stand.fetch, { questions: questions(12), variant: 'reworded' }));
  assert.equal(other.exitCode, 2);
  assert.equal(stand.sent.length, sentBefore);
});
