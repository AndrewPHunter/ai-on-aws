// The agent contract through a real BedrockAgentCoreApp, started by the production start-up
// (agents/src/contract/runtime.ts) in a child process (agents/test/sdk-child.ts), with the local edge on or off.
// The SDK app cannot be closed and gives no port back, so a child is started on free loopback ports picked here,
// is used once GET /ping answers, and is ended with SIGTERM. Two children, one with the edge on and one with it
// off, are shared by the tests that only send requests and read answers, so that few heavy start-ups compete with
// the other test files for the machine; R12 and R13 start and end their own. A port taken in the moment between being picked and the
// child listening makes the child exit 1 and the test fail; it never passes silently.
// Real signed tokens from the stand-in issuer, checked by the real shared check.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import {
  APP_BEHIND_EDGE,
  FAILED_UNEXPECTEDLY,
  NO_VALID_TOKEN,
  OUTSIDE_CONTRACT,
  RUNTIME_PORT,
  TOKEN_NOT_CHECKED,
  runtimeLayoutFrom,
} from '../src/contract/runtime-contract.ts';
import { AGENT_START, TOKEN_CLAIMS, TOKEN_ISSUER, message, prop, startTokenRig } from './helpers.ts';
import type { TokenRig } from './helpers.ts';

// The same identity as CHILD_IDENTITY in sdk-child.ts.
const CHILD_IDENTITY = { id: 'sdk-server-test-agent', implementation: 'none: the handler in agents/test/sdk-child.ts' };
const CHILD_SCRIPT = fileURLToPath(new URL('./sdk-child.ts', import.meta.url));
const SESSION = 'x-amzn-bedrock-agentcore-runtime-session-id';
const SESSION_ID = 'a-session-id-of-the-tests-own-0000000001';
// Fastify's default body limit, which the SDK app keeps: 1 MiB.
const SDK_BODY_LIMIT = 1_048_576;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') {
    throw new Error('No port was given');
  }
  return address.port;
}

type Child = {
  // Where a caller sends requests: the edge when it is on, the SDK app when it is off.
  url: string;
  tokens: TokenRig;
  process: ChildProcess;
  // Everything the child wrote to stdout and stderr so far.
  output: () => string;
  exited: Promise<number | null>;
};

type Cleanup = { after(fn: () => unknown): void };

async function startChild(t: Cleanup, edge: 'on' | 'off'): Promise<Child> {
  const tokens = await startTokenRig(t);
  const appPort = await freePort();
  const edgePort = edge === 'on' ? await freePort() : null;
  const options = {
    edgePort,
    appPort,
    discoveryUrl: tokens.issuer.discoveryUrl,
    issuer: TOKEN_ISSUER,
    // A minute after the tokens are issued, with 540 s of their 600 left.
    now: new Date(new Date(AGENT_START).getTime() + 60_000).toISOString(),
  };
  const child = spawn(process.execPath, [CHILD_SCRIPT, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  // 'close' comes after the child's output has all been read; 'exit' can come before.
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const url = `http://127.0.0.1:${edgePort ?? appPort}`;
  // Generous: the child loads the SDK and its AWS clients while every other test file runs.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      assert.fail(`The child exited with ${child.exitCode} before it answered: ${output}`);
    }
    try {
      const ping = await fetch(`${url}/ping`);
      await ping.body?.cancel();
      if (ping.status === 200) {
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      assert.fail(`The child did not answer /ping within 60 s: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { url, tokens, process: child, output: () => output, exited };
}

// For this whole file: what the shared children need ended is collected here and run after the file's last test.
// (node:test's after(), called while a test runs, would attach to that test instead.)
const atFileEnd: Array<() => unknown> = [];
after(async () => {
  for (const fn of atFileEnd) {
    await fn();
  }
});
const fileLifetime: Cleanup = {
  after: (fn) => {
    atFileEnd.push(fn);
  },
};
const sharedChildren = new Map<'on' | 'off', Promise<Child>>();

function sharedChild(edge: 'on' | 'off'): Promise<Child> {
  let child = sharedChildren.get(edge);
  if (child === undefined) {
    child = startChild(fileLifetime, edge);
    sharedChildren.set(edge, child);
  }
  return child;
}

async function post(
  child: Child,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string; body: unknown }> {
  const response = await fetch(`${child.url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, body: parsed };
}

// A POST that declares a Content-Length and sends none of the body, then reads whatever the server answers. It does
// not race the server's closing of the connection: nothing is being written when the answer comes.
function postDeclaringLength(child: Child, length: number, headers: Record<string, string>): Promise<{ status: number; text: string; body: unknown }> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${child.url}/invocations`);
    const sent = request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(length), ...headers } },
      (response) => {
        const parts: Buffer[] = [];
        response.on('data', (chunk: Buffer) => parts.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          sent.destroy();
          resolve({ status: response.statusCode ?? 0, text, body: parsed });
        });
        response.on('error', reject);
      },
    );
    sent.on('error', reject);
    // The headers go now; the body never does.
    sent.flushHeaders();
  });
}

async function endChild(child: Child): Promise<number | null> {
  child.process.kill('SIGTERM');
  return child.exited;
}

test('R07. through the edge and the SDK app, a valid request with a valid token is 200, and the body is the handler\'s response inside the contract', async (t) => {
  const child = await sharedChild('on');
  const token = await child.tokens.mint();
  const answer = await post(child, JSON.stringify({ message: message('msg-1', 'Hello') }), { authorization: `Bearer ${token}` });
  // Every failure says what came back: the status and the body as text.
  const got = `status ${answer.status}, body ${answer.text}`;
  assert.equal(answer.status, 200, got);
  const parsed = invocationResponseSchema.safeParse(answer.body);
  assert.ok(parsed.success, `the answer is outside the contract: ${got}`);
  assert.deepEqual(parsed.data, {
    agent: CHILD_IDENTITY,
    outcome: 'completed',
    stop_reason: null,
    reply: `Received for ${TOKEN_CLAIMS.sub}.`,
    citations: [],
    case_actions: [],
    steps: [],
  }, got);
});

test('R08. a body outside the contract, a body that is not JSON, and a body over the limit, with the edge off and on', async (t) => {
  await t.test('edge off: the SDK app answers each itself', async () => {
    const child = await sharedChild('off');
    const headers = { authorization: `Bearer ${await child.tokens.mint()}`, [SESSION]: SESSION_ID };

    const { text: _left, ...withoutText } = message('msg-1', 'Hello');
    const mismatch = await post(child, JSON.stringify({ message: withoutText }), headers);
    assert.equal(mismatch.status, 400);
    assert.equal(prop(mismatch.body, 'error'), 'Invalid request body format');
    const details = prop(mismatch.body, 'details');
    assert.ok(Array.isArray(details) && details.length === 1);
    assert.deepEqual(prop(details[0], 'path'), ['message', 'text']);

    const notJson = await post(child, '{"message": ', headers);
    assert.equal(notJson.status, 400);
    assert.deepEqual(notJson.body, {
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      error: 'Bad Request',
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });

    // The SDK's server answers 413 as soon as the declared length is over its limit, and closes the connection; a
    // client still writing the body may see the connection fail instead of the answer (docs/architecture/
    // agent-runtime.md). So the request declares a length over the limit, sends none of the body, and reads the answer.
    const tooLarge = await postDeclaringLength(child, SDK_BODY_LIMIT + 1, headers);
    assert.equal(tooLarge.status, 413, tooLarge.text);
    assert.deepEqual(tooLarge.body, { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE', error: 'Payload Too Large', message: 'Request body is too large' });
  });

  await t.test('edge on: the edge answers a body over 1,000,000 bytes, every time; the SDK app answers the other two', async () => {
    const child = await sharedChild('on');
    const headers = { authorization: `Bearer ${await child.tokens.mint()}` };

    const { text: _left, ...withoutText } = message('msg-1', 'Hello');
    const mismatch = await post(child, JSON.stringify({ message: withoutText }), headers);
    assert.equal(mismatch.status, 400);
    assert.equal(prop(mismatch.body, 'error'), 'Invalid request body format');

    const notJson = await post(child, '{"message": ', headers);
    assert.equal(notJson.status, 400);
    assert.equal(prop(notJson.body, 'code'), 'FST_ERR_CTP_INVALID_JSON_BODY');

    // Over the edge's limit and under the SDK app's, so only the edge can refuse it.
    const body = JSON.stringify({ message: message('msg-1', 'x'.repeat(1_000_000)) });
    assert.ok(body.length > 1_000_000 && body.length < SDK_BODY_LIMIT);
    for (let attempt = 1; attempt <= 20; attempt++) {
      const tooLarge = await post(child, body, headers);
      assert.equal(tooLarge.status, 400, `attempt ${attempt}`);
      assert.deepEqual(tooLarge.body, { error: 'bad_request', detail: 'The request body is too large.' }, `attempt ${attempt}`);
    }
  });
});

test('R09. reaching the SDK app with no token, and with a bad one (edge off): 200 with a failed answer inside the contract that says so', async () => {
  const child = await sharedChild('off');
  const body = JSON.stringify({ message: message('msg-1', 'Hello') });
  const badToken = await child.tokens.mint({ claims: { aud: ['lab-case-system'] } });
  const rows: Record<string, string>[] = [{ [SESSION]: SESSION_ID }, { [SESSION]: SESSION_ID, authorization: `Bearer ${badToken}` }];
  for (const headers of rows) {
    const answer = await post(child, body, headers);
    assert.equal(answer.status, 200);
    const response = invocationResponseSchema.parse(answer.body);
    assert.equal(response.outcome, 'failed');
    assert.equal(response.stop_reason, NO_VALID_TOKEN);
    assert.deepEqual(response.agent, CHILD_IDENTITY);
    assert.equal(response.reply, '');
    assert.equal(answer.text.includes(badToken), false);
  }
});

test('R10. a handler that throws, and one that answers outside the contract: 200 with a failed answer inside the contract, never the error\'s message', async () => {
  const child = await sharedChild('off');
  const headers = { authorization: `Bearer ${await child.tokens.mint()}`, [SESSION]: SESSION_ID };
  const text = 'Text the caller sent, which no error answer may quote.';

  const thrown = await post(child, JSON.stringify({ message: message('throws', text) }), headers);
  assert.equal(thrown.status, 200);
  const failedOnThrow = invocationResponseSchema.parse(thrown.body);
  assert.equal(failedOnThrow.outcome, 'failed');
  assert.equal(failedOnThrow.stop_reason, FAILED_UNEXPECTEDLY);
  assert.equal(thrown.text.includes('on purpose'), false);
  assert.equal(thrown.text.includes(text), false);

  const outside = await post(child, JSON.stringify({ message: message('outside', text) }), headers);
  assert.equal(outside.status, 200);
  const failedOutside = invocationResponseSchema.parse(outside.body);
  assert.equal(failedOutside.outcome, 'failed');
  assert.equal(failedOutside.stop_reason, OUTSIDE_CONTRACT);
  assert.deepEqual(failedOutside.steps, []);
  assert.equal(outside.text.includes(text), false);
});

test('R11. with the edge off and no session id, the SDK app answers 400 itself', async () => {
  const child = await sharedChild('off');
  const answer = await post(child, JSON.stringify({ message: message('msg-1', 'Hello') }), { authorization: `Bearer ${await child.tokens.mint()}` });
  assert.equal(answer.status, 400);
  assert.deepEqual(answer.body, { error: 'Missing sessionId. Provide via x-amzn-bedrock-agentcore-runtime-session-id header or request body.' });
});

test('R12. with the logging shipped, a request\'s token and its message text appear in no line the process writes', async (t) => {
  const child = await startChild(t, 'on');
  const token = await child.tokens.mint();
  const headers = { authorization: `Bearer ${token}` };
  const text = 'Words-of-the-message-that-must-never-be-logged';

  const normal = await post(child, JSON.stringify({ message: message('msg-1', text) }), headers);
  assert.equal(normal.status, 200);
  const notJson = await post(child, `{"message": "${text}`, headers);
  assert.equal(notJson.status, 400);
  const mismatch = await post(child, JSON.stringify({ message: { id: 'msg-1', text } }), headers);
  assert.equal(mismatch.status, 400);
  const thrown = await post(child, JSON.stringify({ message: message('throws', text) }), headers);
  assert.equal(thrown.status, 200);
  const outside = await post(child, JSON.stringify({ message: message('outside', text) }), headers);
  assert.equal(outside.status, 200);

  // Ended, and its output read to the end, before anything is looked for in it.
  assert.equal(await endChild(child), 0);
  const output = child.output();
  // The logger is on and saw each request: the SDK app's request lines, the code of the body that is not JSON,
  // and this agent's own lines for the throw and the response outside the contract.
  assert.equal(output.match(/"msg":"incoming request"/g)?.length, 5, output);
  assert.match(output, /FST_ERR_CTP_INVALID_JSON_BODY/);
  assert.match(output, /The handler threw \(Error\)\./);
  assert.match(output, /The agent produced a response outside the contract at steps\.0\./);
  assert.equal(output.includes(token), false, 'a token was logged');
  assert.equal(output.includes(token.split('.')[1] ?? token), false, 'part of a token was logged');
  assert.equal(output.includes(text), false, 'message text was logged');
  assert.equal(output.includes('on purpose'), false, "an error's message was logged");
});

test('R13. SIGTERM ends the process with exit 0 within 5 s', async (t) => {
  const child = await startChild(t, 'on');
  const sent = Date.now();
  const code = await Promise.race([endChild(child), new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 5000).unref())]);
  assert.equal(code, 0);
  assert.ok(Date.now() - sent < 5000);
});

test('R14. LOCAL_RUNTIME_EDGE is required and must be on or off; on puts the SDK app on loopback behind the edge, off puts it on 0.0.0.0:8080', async (t) => {
  assert.throws(() => runtimeLayoutFrom({}), /^Error: LOCAL_RUNTIME_EDGE is not set/);
  assert.throws(() => runtimeLayoutFrom({ LOCAL_RUNTIME_EDGE: ' ' }), /^Error: LOCAL_RUNTIME_EDGE is not set/);
  assert.throws(() => runtimeLayoutFrom({ LOCAL_RUNTIME_EDGE: 'yes' }), /^Error: LOCAL_RUNTIME_EDGE must be on or off, not "yes"/);
  assert.deepEqual(runtimeLayoutFrom({ LOCAL_RUNTIME_EDGE: 'on' }), {
    edge: 'on',
    edgeAt: { host: '0.0.0.0', port: RUNTIME_PORT },
    appAt: { host: '127.0.0.1', port: APP_BEHIND_EDGE.port },
  });
  assert.equal(RUNTIME_PORT, 8080);
  assert.deepEqual(runtimeLayoutFrom({ LOCAL_RUNTIME_EDGE: 'off' }), { edge: 'off', appAt: { host: '0.0.0.0', port: 8080 } });

  // Each Strands agent's own start-up stops, exit 2, naming the setting, before it listens on anything.
  const env = {
    PATH: process.env['PATH'] ?? '',
    MODEL_BASE_URL: 'http://model.invalid/v1',
    MODEL_API_KEY: 'test-key',
    MODEL_ID: 'none',
    AGENT_ID: 'start-up-test',
    AUTH_DISCOVERY_URL: 'http://identity.invalid/.well-known/openid-configuration',
    AUTH_ISSUER: 'http://identity.invalid/realms/lab',
    AUTH_ALLOWED_AUDIENCE: 'lab-agents',
    AUTH_ALLOWED_CLIENTS: 'desk',
    AUTH_ROLES_CLAIM: 'roles',
    CASE_MCP_URL: 'http://case-system.invalid/mcp',
    KNOWLEDGE_MCP_URL: 'http://knowledge.invalid/mcp',
  };
  // One start-up each, as they load the whole agent: the expert without the setting, the intake agent with another value.
  for (const [main, value] of [['../src/expert/main.ts', undefined], ['../src/intake/main-strands.ts', 'maybe']] as const) {
    const started = spawn(process.execPath, [fileURLToPath(new URL(main, import.meta.url))], {
      env: value === undefined ? env : { ...env, LOCAL_RUNTIME_EDGE: value },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      started.kill('SIGKILL');
    });
    let stderr = '';
    started.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve) => {
      started.on('exit', (exitCode) => {
        resolve(exitCode);
      });
    });
    assert.equal(code, 2, `${main} ${String(value)}: ${stderr}`);
    assert.match(stderr, /LOCAL_RUNTIME_EDGE/, `${main} ${String(value)}`);
  }
});

test('R17. reaching the SDK app (edge off) when the identity provider cannot be asked: 200 with a failed answer inside the contract that says so, never 503 or 500', async (t) => {
  // A child of its own: the token check keeps the provider's keys once fetched, and this one has fetched none.
  const child = await startChild(t, 'off');
  const token = await child.tokens.mint();
  child.tokens.issuer.misbehave('no_answer');
  const answer = await post(child, JSON.stringify({ message: message('msg-1', 'Hello') }), { authorization: `Bearer ${token}`, [SESSION]: SESSION_ID });
  assert.equal(answer.status, 200);
  const response = invocationResponseSchema.parse(answer.body);
  assert.equal(response.outcome, 'failed');
  assert.equal(response.stop_reason, TOKEN_NOT_CHECKED);
  assert.deepEqual(response.agent, CHILD_IDENTITY);
});

test('R18. GET /ping through the real SDK app, directly and through the edge, is 200 Healthy with time_of_last_update in whole seconds', async () => {
  for (const edge of ['off', 'on'] as const) {
    const child = await sharedChild(edge);
    const response = await fetch(`${child.url}/ping`);
    assert.equal(response.status, 200, edge);
    const body: unknown = await response.json();
    assert.deepEqual(Object.keys(body as object).sort(), ['status', 'time_of_last_update'], edge);
    assert.equal(prop(body, 'status'), 'Healthy', edge);
    const seconds = prop(body, 'time_of_last_update');
    assert.ok(typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0, `${edge}: ${String(seconds)}`);
  }
});

test('R19. the hand-written agent still starts on the hand-written contract server, without LOCAL_RUNTIME_EDGE and without starting the SDK server', async (t) => {
  // It listens on port 8080, as in its container; the check container has nothing else on that port.
  const env = {
    PATH: process.env['PATH'] ?? '',
    MODEL_BASE_URL: 'http://model.invalid/v1',
    MODEL_API_KEY: 'test-key',
    MODEL_ID: 'none',
    AGENT_ID: 'start-up-test',
    AUTH_DISCOVERY_URL: 'http://identity.invalid/.well-known/openid-configuration',
    AUTH_ISSUER: 'http://identity.invalid/realms/lab',
    AUTH_ALLOWED_AUDIENCE: 'lab-agents',
    AUTH_ALLOWED_CLIENTS: 'desk',
    AUTH_ROLES_CLAIM: 'roles',
    CASE_MCP_URL: 'http://case-system.invalid/mcp',
  };
  const started = spawn(process.execPath, [fileURLToPath(new URL('../src/intake/main-handwritten.ts', import.meta.url))], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  started.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  started.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const closed = new Promise<number | null>((resolve) => {
    started.on('close', (code) => {
      resolve(code);
    });
  });
  t.after(() => {
    started.kill('SIGKILL');
  });
  const deadline = Date.now() + 60_000;
  while (!output.includes('listening on')) {
    if (started.exitCode !== null) {
      assert.fail(`The hand-written agent exited with ${started.exitCode}: ${output}`);
    }
    if (Date.now() > deadline) {
      assert.fail(`The hand-written agent did not start within 60 s: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /^Intake agent \(hand-written loop\) listening on 0\.0\.0\.0:8080$/m);

  // The hand-written server's own answers: /ping without time_of_last_update, and its 401.
  const ping = await fetch('http://127.0.0.1:8080/ping');
  assert.deepEqual(await ping.json(), { status: 'Healthy' });
  const refused = await fetch('http://127.0.0.1:8080/invocations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 401);
  assert.equal(prop(await refused.json(), 'reason'), 'missing');

  started.kill('SIGTERM');
  await closed;
  // Nothing of the SDK's server ran: no Fastify line, and no FSTDEP023 warning, which it prints at every start.
  assert.equal(output.includes('FSTDEP023'), false, output);
  assert.equal(output.includes('"msg":"Server listening'), false, output);
});
