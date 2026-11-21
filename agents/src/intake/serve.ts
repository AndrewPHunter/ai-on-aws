// Starts an intake agent on port 8080. Shared by both implementations: each main file names its
// implementation and says how to build its handler, and everything else about starting is here.
//
// Reads from the environment, through settingsFrom, and nowhere else does:
//   MODEL_BASE_URL         the address of the model server, ending in /v1
//   MODEL_API_KEY          the key the model server expects
//   MODEL_ID               optional; the model server is asked which model it serves when this is unset
//   CASE_MCP_URL           the address of the case system's MCP endpoint
//   AGENT_ID               the name this agent records its changes under
//   AUTH_DISCOVERY_URL     where to fetch the identity provider's discovery document
//   AUTH_ISSUER            the issuer that document and every access token must name
//   AUTH_ALLOWED_AUDIENCE  a value that must be in the access token's aud
//   AUTH_ALLOWED_CLIENTS   the client ids an access token may be issued to, separated by commas
//   AUTH_ROLES_CLAIM       the access-token claim holding the caller's roles

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import type { AccessTokenSettings, Caller } from '../../../shared/access-token.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import { createContractServer } from '../contract/server.ts';
import type { AgentIdentity } from '../contract/server.ts';
import { servedModelId } from '../model/served.ts';
import type { ModelSettings } from '../model/served.ts';
import { failed, recordError, startRun } from './run.ts';
import type { Limits } from './run.ts';
import { LIMITS, SAMPLING } from './settings.ts';

const PORT = 8080;
const HOST = '0.0.0.0';
// After a token names a key the agent has not seen, the provider's keys are fetched again at most this
// often. Keycloak makes new keys when it restarts; this is how soon the agent can follow.
const KEY_REFETCH_WAIT_MS = 30_000;
const IDENTITY_TIMEOUT_MS = 5_000;

export type Wiring = {
  identity: AgentIdentity;
  now: () => Date;
  limits: Limits;
  model: ModelSettings;
  caseMcpUrl: string;
};

export type Handler = (message: InboundMessage, caller: Caller) => Promise<InvocationResponse>;

export type AgentSettings = {
  baseUrl: string;
  apiKey: string;
  namedModel: string | undefined;
  caseMcpUrl: string;
  agentId: string;
  // A token must still be valid for the run's whole time limit, so it cannot expire during a run.
  auth: AccessTokenSettings;
};

function required(env: Readonly<Record<string, string | undefined>>, name: string, meaning: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value.trim();
}

// Every setting the agent starts with, from the environment object given. Throws, naming the variable,
// when one is missing.
export function settingsFrom(env: Readonly<Record<string, string | undefined>>): AgentSettings {
  const clients = required(env, 'AUTH_ALLOWED_CLIENTS', 'the client ids an access token may be issued to, separated by commas')
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client !== '');
  if (clients.length === 0) {
    throw new Error('AUTH_ALLOWED_CLIENTS names no client id.');
  }
  const namedModel = env['MODEL_ID']?.trim();
  return {
    baseUrl: required(env, 'MODEL_BASE_URL', 'the address of the model server, ending in /v1').replace(/\/+$/, ''),
    apiKey: required(env, 'MODEL_API_KEY', 'the key the model server expects'),
    namedModel: namedModel === '' ? undefined : namedModel,
    caseMcpUrl: required(env, 'CASE_MCP_URL', "the address of the case system's MCP endpoint"),
    agentId: required(env, 'AGENT_ID', 'the name this agent records its changes under'),
    auth: {
      discoveryUrl: required(env, 'AUTH_DISCOVERY_URL', "where to fetch the identity provider's discovery document"),
      issuer: required(env, 'AUTH_ISSUER', 'the issuer the discovery document and every access token must name'),
      audience: required(env, 'AUTH_ALLOWED_AUDIENCE', "a value that must be in the access token's aud"),
      allowedClients: clients,
      rolesClaim: required(env, 'AUTH_ROLES_CLAIM', "the access-token claim holding the caller's roles"),
      minRemainingSeconds: LIMITS.runMs / 1000,
    },
  };
}

export function serveIntakeAgent(implementation: string, build: (wiring: Wiring) => Handler): void {
  let settings: AgentSettings;
  try {
    settings = settingsFrom(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const { baseUrl, apiKey, namedModel, caseMcpUrl, agentId } = settings;

  const identity: AgentIdentity = { id: agentId, implementation };
  const now = (): Date => new Date();
  const checkToken = createAccessTokenCheck(settings.auth, {
    now,
    keyRefetchWaitMs: KEY_REFETCH_WAIT_MS,
    timeoutMs: IDENTITY_TIMEOUT_MS,
  });

  // The model's name is asked of the server once, on first use, unless MODEL_ID names it.
  let handler: Handler | undefined;
  async function ready(): Promise<Handler | string> {
    if (handler !== undefined) {
      return handler;
    }
    let modelId = namedModel;
    if (modelId === undefined) {
      const served = await servedModelId(baseUrl, apiKey, 10_000);
      if (!served.ok) {
        return served.reason;
      }
      modelId = served.id;
    }
    handler = build({ identity, now, limits: LIMITS, model: { baseUrl, apiKey, modelId, ...SAMPLING }, caseMcpUrl });
    return handler;
  }

  const server = createContractServer(
    identity,
    async (message, caller) => {
      const handle = await ready();
      if (typeof handle === 'string') {
        const run = startRun(identity, now, LIMITS);
        recordError(run, handle);
        return failed(run, handle);
      }
      return handle(message, caller);
    },
    checkToken,
  );

  server.listen(PORT, HOST, () => {
    console.log(`Intake agent (${implementation}) listening on ${HOST}:${PORT}`);
  });

  function stop(): void {
    server.close();
    server.closeAllConnections();
  }

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
