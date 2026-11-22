// What AgentCore Runtime defines, and what this repository answers in its name, for the agents served by AWS's SDK
// server: the headers, the setting that chooses whether the local edge runs, where each part listens, and the
// sentences of the failed answers. Nothing here loads the SDK, so the edge, the start-up and the tests can read it
// without loading Fastify and the AWS clients.

// The headers AgentCore Runtime sets or forwards, as the SDK reads them.
export const SESSION_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
export const REQUEST_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-request-id';
export const CUSTOM_HEADER_PREFIX = 'x-amzn-bedrock-agentcore-runtime-custom-';

// The reasons of the failed answers the SDK app gives (contract/sdk-app.ts).
export const NO_VALID_TOKEN =
  "The request reached the agent with no valid access token. On AgentCore Runtime, Authorization must be in the agent's request header allowlist.";
export const TOKEN_NOT_CHECKED = 'The request reached the agent, and its access token could not be checked: the identity provider could not be asked.';
export const FAILED_UNEXPECTEDLY = 'The agent failed unexpectedly.';
export const OUTSIDE_CONTRACT = 'The agent produced a response outside its contract.';

export type Environment = Readonly<Record<string, string | undefined>>;

export type Address = { host: string; port: number };

export type RuntimeLayout = { edge: 'on'; edgeAt: Address; appAt: Address } | { edge: 'off'; appAt: Address };

// The port AgentCore Runtime sends requests to.
export const RUNTIME_PORT = 8080;
// Where the SDK app listens behind the edge: inside the container only.
export const APP_BEHIND_EDGE: Address = { host: '127.0.0.1', port: 9080 };

// LOCAL_RUNTIME_EDGE, required, with no default:
//   on:  the edge listens on 0.0.0.0:8080 and the SDK app on 127.0.0.1:9080, reachable only through the edge. For
//        running anywhere but AgentCore Runtime.
//   off: the SDK app alone on 0.0.0.0:8080, as it runs on AgentCore Runtime, which then does what the edge does.
export function runtimeLayoutFrom(env: Environment): RuntimeLayout {
  const value = env['LOCAL_RUNTIME_EDGE']?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      'LOCAL_RUNTIME_EDGE is not set. It is on to run the local stand-in for AgentCore Runtime in front of the agent, or off to serve as on AgentCore Runtime.',
    );
  }
  if (value === 'on') {
    return { edge: 'on', edgeAt: { host: '0.0.0.0', port: RUNTIME_PORT }, appAt: APP_BEHIND_EDGE };
  }
  if (value === 'off') {
    return { edge: 'off', appAt: { host: '0.0.0.0', port: RUNTIME_PORT } };
  }
  throw new Error(`LOCAL_RUNTIME_EDGE must be on or off, not "${value}".`);
}
