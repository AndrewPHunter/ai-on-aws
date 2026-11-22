// The agent contract served through AWS's SDK server: BedrockAgentCoreApp from the npm package
// bedrock-agentcore. The SDK owns the HTTP side: GET /ping, POST /invocations, the session id it requires,
// parsing the body and checking it against the request schema. This file gives it the agent's request schema
// and the function it calls for each valid request.
//
// The SDK checks no access token: on AWS, AgentCore Runtime's JWT authorizer does that before the container is
// reached, and locally the edge in ./edge.ts does. The token is checked here again, as contract/server.ts does,
// to get the caller and so one behaviour holds everywhere. The SDK gives the function no way to answer 401, so a
// request that reaches it with no valid token gets a failed answer inside the contract saying so.
//
// Nothing the handler does surfaces as the SDK's own 500, which would carry an error's message: a throw and a
// response outside the contract both become a failed answer inside the contract.

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';

import type { AccessTokenCheck } from '../../../shared/access-token.ts';
import { invocationRequestSchema, invocationResponseSchema } from '../../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import { FAILED_UNEXPECTEDLY, NO_VALID_TOKEN, OUTSIDE_CONTRACT, TOKEN_NOT_CHECKED } from './runtime-contract.ts';
import type { AgentIdentity, Handler } from './server.ts';

// Where this file writes a line about a failure. A line never carries a token, a message's text, or an error's
// message, which can quote either.
export type Log = (line: string) => void;

function failedAnswer(identity: AgentIdentity, reason: string): InvocationResponse {
  return { agent: identity, outcome: 'failed', stop_reason: reason, reply: '', citations: [], case_actions: [], steps: [] };
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

// What the SDK app answers a request that has passed its checks: always a response inside the contract.
export async function answerInvocation(
  identity: AgentIdentity,
  handler: Handler,
  checkToken: AccessTokenCheck,
  log: Log,
  message: InboundMessage,
  headers: Readonly<Record<string, string>>,
): Promise<InvocationResponse> {
  const checked = await checkToken(headerValue(headers, 'authorization'));
  if (checked.kind === 'refused') {
    log(`A request reached the agent with no valid access token (${checked.reason}).`);
    return failedAnswer(identity, NO_VALID_TOKEN);
  }
  if (checked.kind === 'unavailable') {
    log('A request reached the agent and its access token could not be checked.');
    return failedAnswer(identity, TOKEN_NOT_CHECKED);
  }

  let result: InvocationResponse;
  try {
    result = await handler(message, checked.caller);
  } catch (error) {
    log(`The handler threw (${error instanceof Error ? error.name : typeof error}).`);
    return failedAnswer(identity, FAILED_UNEXPECTEDLY);
  }
  const valid = invocationResponseSchema.safeParse(result);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    log(`The agent produced a response outside the contract${issue === undefined ? '' : ` at ${issue.path.join('.') || 'the top level'} (${issue.code})`}.`);
    return failedAnswer(identity, OUTSIDE_CONTRACT);
  }
  return valid.data;
}

type SdkConfig = NonNullable<ConstructorParameters<typeof BedrockAgentCoreApp>[0]['config']>;
type LoggerOptions = NonNullable<NonNullable<SdkConfig['logging']>['options']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const NOT_LOGGED = 'not logged: it can quote the request';

type ErrorFields = { type: string; code: unknown; statusCode: unknown; message: string; stack: string };

function errorFields(error: unknown): ErrorFields {
  if (!isRecord(error)) {
    return { type: typeof error, code: undefined, statusCode: undefined, message: NOT_LOGGED, stack: NOT_LOGGED };
  }
  return { type: String(error.name), code: error.code, statusCode: error.statusCode, message: NOT_LOGGED, stack: NOT_LOGGED };
}

// The SDK's logger (Fastify's, which is pino) stays on, with request lines as the SDK sets them. Three things are
// changed so that no token and no message text can reach a line (four, counting the query):
//   - a request is logged as its method and path only, never its query, headers or body;
//   - an error is logged as its type, code and status, never its message or stack (both fields say so);
//   - a line about an error has its message replaced by the error's code, because Fastify uses the error's
//     message as the line's message;
//   - the line for a path that does not exist gives the path without its query.
type LogMethodHook = { logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void): void };

const loggerOptions: LoggerOptions & { hooks: LogMethodHook } = {
  level: 'info',
  serializers: {
    req: (request: { method?: string; url?: string }) => ({ method: request.method, url: request.url?.split('?')[0] }),
    err: errorFields,
  },
  hooks: {
    logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void): void {
      const [first] = args;
      if (first instanceof Error) {
        method.apply(this, [{ err: first }, `error ${String(errorFields(first).code ?? first.name)}`]);
        return;
      }
      if (isRecord(first) && 'err' in first) {
        method.apply(this, [first, `error ${String(errorFields(first.err).code ?? errorFields(first.err).type)}`]);
        return;
      }
      if (typeof first === 'string') {
        method.apply(this, [first.replace(/^(Route \S+?:[^?\s]*)\?\S*( not found)$/, '$1$2'), ...args.slice(1)]);
        return;
      }
      method.apply(this, args);
    },
  },
};

// The hook is pino's own option, which Fastify passes on to pino with the rest.
export const SDK_LOGGING: SdkConfig['logging'] = { enabled: true, options: loggerOptions };

export function createSdkApp(identity: AgentIdentity, handler: Handler, checkToken: AccessTokenCheck, log: Log): BedrockAgentCoreApp {
  return new BedrockAgentCoreApp({
    invocationHandler: {
      requestSchema: invocationRequestSchema,
      process: (request, context) => answerInvocation(identity, handler, checkToken, log, request.message, context.headers),
    },
    config: { logging: SDK_LOGGING },
  });
}
