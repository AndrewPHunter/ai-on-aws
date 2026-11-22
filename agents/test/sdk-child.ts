// Run by runtime.test.ts in a child process: a real BedrockAgentCoreApp, started by the production start-up in
// ../src/contract/runtime.ts with the edge on, on loopback ports the test chose. The SDK app cannot be closed, so
// each test ends its child with a signal.
//
// What is not production here: the ports, and two values written for the tests.
//   The token check  "Bearer refused" is refused, "Bearer unavailable" cannot be checked, any other Bearer token
//                    is accepted as a fixed caller holding that token.
//   The handler      message id "throws" throws an error quoting the message's text; "outside" answers outside the
//                    contract, quoting it; any other id answers inside the contract.
//
// One argument: a JSON object { edgePort: number, appPort: number }.

import type { AccessTokenCheck } from '../../shared/access-token.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import { startOnAgentCoreSdk } from '../src/contract/runtime.ts';

const ports: unknown = JSON.parse(process.argv[2] ?? '{}');
const port = (name: string): number => Number(typeof ports === 'object' && ports !== null ? Reflect.get(ports, name) : NaN);
const identity = { id: 'runtime-test-agent', implementation: 'the handler in agents/test/sdk-child.ts' };

const checkToken: AccessTokenCheck = (authorization) => {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (token === undefined || token === 'refused') return Promise.resolve({ kind: 'refused', reason: 'bad_signature', detail: 'Refused by the test.' });
  if (token === 'unavailable') return Promise.resolve({ kind: 'unavailable', detail: 'Not checked, by the test.' });
  return Promise.resolve({
    kind: 'caller',
    caller: { subject: 's', username: 'u', name: 'n', clientId: 'desk', roles: [], scopes: ['agents:intake'], expiresAt: new Date('2026-03-01T10:10:00.000Z'), token },
  });
};

startOnAgentCoreSdk({
  title: 'Runtime test agent',
  identity,
  checkToken,
  layout: { edge: 'on', edgeAt: { host: '127.0.0.1', port: port('edgePort') }, appAt: { host: '127.0.0.1', port: port('appPort') } },
  handler: (message) => {
    if (message.id === 'throws') return Promise.reject(new Error(`The handler failed on purpose, quoting: ${message.text}`));
    const answer: InvocationResponse = { agent: identity, outcome: 'completed', stop_reason: null, reply: 'Received.', citations: [], case_actions: [], steps: [] };
    if (message.id === 'outside') {
      return Promise.resolve({ ...answer, steps: [{ kind: 'error', started_at: 'yesterday', duration_ms: -1, message: message.text }] });
    }
    return Promise.resolve(answer);
  },
});
