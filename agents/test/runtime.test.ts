// The front doors' invariants ("Always true" in docs/architecture/agent-runtime.md), the one probe of the
// hand-written agent's model client (runtime P1, a probe that matches no invariant), and the token an agent
// sends its tool server (runtime 5). The token check and the token exchange are plain functions that answer as each row says: no token
// is signed. The SDK app cannot be closed, so it runs in a child process (sdk-child.ts),
// behind the edge, on loopback ports picked here; a port taken in the moment between being picked and the child
// listening makes the child exit and the test fail.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AccessTokenCheck } from '../../shared/access-token.ts';
import type { TokenExchangeRequest, TokenExchangeResult } from '../../shared/token-exchange.ts';
import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import { createLocalEdge } from '../src/contract/edge.ts';
import { createContractServer } from '../src/contract/server.ts';
import { createChatModel } from '../src/model/chat.ts';
import { CASE_SYSTEM, connectWithToolToken } from '../src/tools/tool-token.ts';
import { ask, listen, message, say, startModel, stop } from './support.ts';

const IDENTITY = { id: 'runtime-test-agent', implementation: 'none' };
const CHILD = fileURLToPath(new URL('./sdk-child.ts', import.meta.url));
const SECRET_TEXT = 'Words-of-the-message-that-must-never-be-logged';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port was given');
  return address.port;
}

type Child = { url: string; output: () => string; end: (signal: NodeJS.Signals) => Promise<number | null> };

async function startChild(t: TestContext): Promise<Child> {
  const ports = { edgePort: await freePort(), appPort: await freePort() };
  const child = spawn(process.execPath, [CHILD, JSON.stringify(ports)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  // 'close' comes after the child's output has all been read.
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const url = `http://127.0.0.1:${ports.edgePort}`;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`The child exited with ${child.exitCode} before it answered: ${output}`);
    const ping = await fetch(`${url}/ping`).catch(() => undefined);
    await ping?.body?.cancel();
    if (ping?.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    url,
    output: () => output,
    end: (signal) => {
      child.kill(signal);
      return closed;
    },
  };
}

async function invoke(url: string, token: string, id: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: message(id, SECRET_TEXT) }),
  });
  return { status: response.status, text: await response.text() };
}

// The status of a POST whose headers are sent and whose body never ends.
function statusBeforeBody(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}/invocations`);
    const sent = request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-length': '1000' } }, (response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
      sent.destroy();
    });
    sent.on('error', reject);
    sent.write('{"message":');
  });
}

test('runtime 1. a request with no accepted token is answered 401 before its body is read, and 503 when the token cannot be checked', { timeout: 30_000 }, async (t) => {
  const handled: string[] = [];
  const rows: Array<{ check: AccessTokenCheck; status: number }> = [
    { check: () => Promise.resolve({ kind: 'refused', reason: 'missing', detail: 'No token.' }), status: 401 },
    { check: () => Promise.resolve({ kind: 'unavailable', detail: 'The provider could not be asked.' }), status: 503 },
  ];
  for (const row of rows) {
    const contract = createContractServer(
      IDENTITY,
      (m) => {
        handled.push(m.id);
        return Promise.reject(new Error('not to be called'));
      },
      row.check,
    );
    const contractUrl = await listen(contract);
    const edge = createLocalEdge({ upstream: { host: '127.0.0.1', port: Number(new URL(contractUrl).port) }, checkToken: row.check, newId: randomUUID, log: () => undefined });
    const edgeUrl = await listen(edge);
    t.after(() => {
      stop(contract);
      stop(edge);
    });
    const doors: Array<[string, string]> = [['contract server', contractUrl], ['edge', edgeUrl]];
    for (const [door, url] of doors) assert.equal(await statusBeforeBody(url), row.status, door);
  }
  assert.deepEqual(handled, []);
});

test('runtime 2. on the SDK server, a valid request always gets an answer inside the contract, never the SDK\'s own 500', async (t) => {
  const child = await startChild(t);
  for (const id of ['throws', 'outside']) {
    const answer = await invoke(child.url, 'accepted-token', id);
    assert.equal(answer.status, 200, id);
    assert.equal(invocationResponseSchema.parse(JSON.parse(answer.text)).outcome, 'failed', id);
    assert.equal(answer.text.includes(SECRET_TEXT), false, `${id}: the answer quotes the message`);
  }
});

test('runtime 3. no line written by the SDK\'s logger, the edge or the SDK app carries a token, a message\'s text or an error\'s message', async (t) => {
  const child = await startChild(t);
  const token = 'token-of-runtime-3-never-to-be-logged';
  for (const id of ['msg-1', 'throws', 'outside']) assert.equal((await invoke(child.url, token, id)).status, 200);
  assert.equal((await invoke(child.url, 'refused', 'msg-2')).status, 401);
  assert.equal(await child.end('SIGTERM'), 0);
  const output = child.output();
  assert.equal(output.match(/"msg":"incoming request"/g)?.length, 3, `the logger did not log each request: ${output}`);
  assert.deepEqual(
    [token, SECRET_TEXT, 'on purpose'].filter((secret) => output.includes(secret)),
    [],
  );
});

test('runtime 4. on the SDK server SIGTERM and SIGINT end the process with exit 0', async (t) => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const child = await startChild(t);
    assert.equal(await child.end(signal), 0, signal);
  }
});

test('runtime P1. the hand-written agent\'s model client reaches a model server and reads back a text answer and a tool call', async (t) => {
  const model = await startModel(t, (_request, nth) => (nth === 0 ? say('Hello.') : ask(['find_case', { patient: 'JD' }])));
  const client = createChatModel(model.settings);
  const asked = (): ReturnType<typeof client.complete> => client.complete([{ role: 'user', content: 'Hi' }], [], { timeoutMs: 30_000, thinking: true });
  const first = await asked();
  const second = await asked();
  assert.ok(first.ok && second.ok);
  assert.equal(first.completion.content, 'Hello.');
  assert.deepEqual(
    second.completion.toolCalls.map((c) => c.function),
    [{ name: 'find_case', arguments: '{"patient":"JD"}' }],
  );
});

test('runtime 5. an agent connects to its tool server only with a token it got for that server by one exchange of the caller\'s, and a refused or unavailable exchange connects nothing', async () => {
  const callerToken = 'token-the-agent-was-called-with';
  const inbound = message('msg-runtime-6', 'Patient JD had a rash after Examplamab.');
  const rows: Array<{ name: string; answer: TokenExchangeResult; connected: string[] }> = [
    { name: 'granted', answer: { kind: 'token', token: 'token-for-the-case-system', expiresAt: new Date('2026-03-01T10:05:00.000Z'), scopes: ['cases:write', 'cases:lookup'] }, connected: ['token-for-the-case-system'] },
    { name: 'refused', answer: { kind: 'refused', reason: 'provider_refused', detail: 'Detail-of-the-refused-exchange.' }, connected: [] },
    { name: 'unavailable', answer: { kind: 'unavailable', detail: 'the token exchange could not reach the identity provider: fetch failed (getaddrinfo ENOTFOUND identity.example:8080).' }, connected: [] },
  ];
  for (const row of rows) {
    const asked: TokenExchangeRequest[] = [];
    const connected: string[] = [];
    const connect = connectWithToolToken(
      (request) => {
        asked.push(request);
        return Promise.resolve(row.answer);
      },
      CASE_SYSTEM,
      (_message, token) => {
        connected.push(token);
        return Promise.resolve({ ok: true, tools: { definitions: [], call: () => Promise.resolve({ kind: 'no_answer', reason: 'Not called.' }), close: () => Promise.resolve() } });
      },
    );
    const result = await connect(inbound, callerToken, 10_000);
    assert.deepEqual(
      asked.map(({ subjectToken, audience, scopes }) => ({ subjectToken, audience, scopes: [...scopes] })),
      [{ subjectToken: callerToken, audience: 'case-system', scopes: ['cases:write', 'cases:lookup'] }],
      `${row.name}: the exchange was not asked once, for the case system`,
    );
    assert.deepEqual(connected, row.connected, `${row.name}: what was connected with`);
    if (row.answer.kind === 'refused') assert.ok(!result.ok && result.reason.includes(row.answer.detail), `${row.name}: the reason does not carry the detail`);
    if (row.answer.kind === 'unavailable') assert.ok(!result.ok && !result.reason.includes(row.answer.detail) && !result.reason.includes('identity.example'), `${row.name}: the reason carries the detail or its address`);
  }
});
