// Run by agents/test/sdk-server.test.ts in a child process: a real BedrockAgentCoreApp, started by the
// production start-up in ../src/contract/runtime.ts, with the edge on or off. The SDK app cannot be closed and
// gives no port back, so each test starts one of these on ports it chose and ends it with SIGTERM.
//
// What is not production here: the ports and hosts (loopback only), the token check's clock (fixed at the
// instant the test's tokens were issued), and the handler, which is written for the tests:
//   message id "throws"    the handler throws an error whose message carries the message's text
//   message id "outside"   the handler returns a response outside the contract, carrying the message's text
//   any other id           the handler answers inside the contract, naming the caller's subject
//
// One argument: a JSON object { edgePort: number | null, appPort: number, discoveryUrl, issuer, now }.

import { z } from 'zod';

import { createAccessTokenCheck } from '../../shared/access-token.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import { startOnAgentCoreSdk } from '../src/contract/runtime.ts';
import type { RuntimeLayout } from '../src/contract/runtime-contract.ts';

const options = z
  .object({ edgePort: z.number().int().nullable(), appPort: z.number().int(), discoveryUrl: z.string(), issuer: z.string(), now: z.iso.datetime() })
  .parse(JSON.parse(process.argv[2] ?? '{}'));
// The same identity as CHILD_IDENTITY in sdk-server.test.ts.
const CHILD_IDENTITY = { id: 'sdk-server-test-agent', implementation: 'none: the handler in agents/test/sdk-child.ts' };

const now = new Date(options.now);
const checkToken = createAccessTokenCheck(
  {
    discoveryUrl: options.discoveryUrl,
    issuer: options.issuer,
    audience: 'lab-agents',
    allowedClients: ['desk'],
    rolesClaim: 'roles',
    minRemainingSeconds: 150,
  },
  { now: () => now, keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
);

const loopback = '127.0.0.1';
const layout: RuntimeLayout =
  options.edgePort === null
    ? { edge: 'off', appAt: { host: loopback, port: options.appPort } }
    : { edge: 'on', edgeAt: { host: loopback, port: options.edgePort }, appAt: { host: loopback, port: options.appPort } };

startOnAgentCoreSdk({
  title: 'SDK server test agent',
  identity: CHILD_IDENTITY,
  checkToken,
  layout,
  handler: (message, caller) => {
    if (message.id === 'throws') {
      return Promise.reject(new Error(`The handler failed on purpose, quoting: ${message.text}`));
    }
    const answer: InvocationResponse = {
      agent: CHILD_IDENTITY,
      outcome: 'completed',
      stop_reason: null,
      reply: `Received for ${caller.subject}.`,
      citations: [],
      case_actions: [],
      steps: [],
    };
    if (message.id === 'outside') {
      return Promise.resolve({ ...answer, steps: [{ kind: 'error', started_at: 'yesterday', duration_ms: -1, message: message.text }] });
    }
    return Promise.resolve(answer);
  },
});
