// Starts an agent on port 8080. Shared by every agent: each says how to read its own settings, the limits it
// runs with, the line it logs when listening, and how to build its handler; everything else about starting is
// here.
//
// Reads from the environment object it is given, and nowhere else:
//   MODEL_BASE_URL         the address of the model server, ending in /v1
//   MODEL_API_KEY          the key the model server expects
//   MODEL_ID               optional; the model server is asked which model it serves when this is unset
//   AGENT_ID               the name this agent records its changes under
//   AUTH_DISCOVERY_URL     where to fetch the identity provider's discovery document
//   AUTH_ISSUER            the issuer that document and every access token must name
//   AUTH_ALLOWED_AUDIENCE  a value that must be in the access token's aud
//   AUTH_ALLOWED_CLIENTS   the client ids an access token may be issued to, separated by commas
//   AUTH_ROLES_CLAIM       the access-token claim holding the caller's roles
// and whatever the agent's own reader reads from the same object.

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import type { AccessTokenSettings, Caller } from '../../../shared/access-token.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import { createContractServer } from '../contract/server.ts';
import type { AgentIdentity } from '../contract/server.ts';
import { servedModelId } from '../model/served.ts';
import type { ModelSettings } from '../model/served.ts';
import { failed } from './endings.ts';
import type { Limits } from './limits.ts';
import { SAMPLING } from './sampling.ts';
import { startRunState } from './state.ts';
import { recordError } from './steps.ts';

const PORT = 8080;
const HOST = '0.0.0.0';
// After a token names a key the agent has not seen, the provider's keys are fetched again at most this
// often. Keycloak makes new keys when it restarts; this is how soon the agent can follow.
const KEY_REFETCH_WAIT_MS = 30_000;
const IDENTITY_TIMEOUT_MS = 5_000;

export type Environment = Readonly<Record<string, string | undefined>>;

// What every agent is built with, whatever its own settings add.
export type BaseWiring = {
  identity: AgentIdentity;
  now: () => Date;
  limits: Limits;
  model: ModelSettings;
};

export type Handler = (message: InboundMessage, caller: Caller) => Promise<InvocationResponse>;

export type AgentSettings<Own> = {
  baseUrl: string;
  apiKey: string;
  namedModel: string | undefined;
  agentId: string;
  // A token must still be valid for the run's whole time limit, so it cannot expire during a run.
  auth: AccessTokenSettings;
  own: Own;
};

export function required(env: Environment, name: string, meaning: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value.trim();
}

// Every setting an agent starts with, from the environment object given. Throws, naming the variable, when
// one is missing. The agent's own settings are read after the model's and before AGENT_ID, so when several
// are missing the one named first is always the same.
export function agentSettingsFrom<Own>(env: Environment, limits: Limits, readOwn: (env: Environment) => Own): AgentSettings<Own> {
  const clients = required(env, 'AUTH_ALLOWED_CLIENTS', 'the client ids an access token may be issued to, separated by commas')
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client !== '');
  if (clients.length === 0) {
    throw new Error('AUTH_ALLOWED_CLIENTS names no client id.');
  }
  const namedModel = env['MODEL_ID']?.trim();
  const baseUrl = required(env, 'MODEL_BASE_URL', 'the address of the model server, ending in /v1').replace(/\/+$/, '');
  const apiKey = required(env, 'MODEL_API_KEY', 'the key the model server expects');
  const own = readOwn(env);
  return {
    baseUrl,
    apiKey,
    namedModel: namedModel === '' ? undefined : namedModel,
    agentId: required(env, 'AGENT_ID', 'the name this agent records its changes under'),
    auth: {
      discoveryUrl: required(env, 'AUTH_DISCOVERY_URL', "where to fetch the identity provider's discovery document"),
      issuer: required(env, 'AUTH_ISSUER', 'the issuer the discovery document and every access token must name'),
      audience: required(env, 'AUTH_ALLOWED_AUDIENCE', "a value that must be in the access token's aud"),
      allowedClients: clients,
      rolesClaim: required(env, 'AUTH_ROLES_CLAIM', "the access-token claim holding the caller's roles"),
      minRemainingSeconds: limits.runMs / 1000,
    },
    own,
  };
}

export type AgentDefinition<Own> = {
  implementation: string;
  limits: Limits;
  readOwn: (env: Environment) => Own;
  // The line logged once the server listens.
  listening: (host: string, port: number) => string;
  build: (wiring: BaseWiring, own: Own) => Handler;
};

export function serveAgent<Own>(definition: AgentDefinition<Own>): void {
  const { implementation, limits } = definition;
  let settings: AgentSettings<Own>;
  try {
    settings = agentSettingsFrom(process.env, limits, definition.readOwn);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const { baseUrl, apiKey, namedModel, agentId, own } = settings;

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
    handler = definition.build({ identity, now, limits, model: { baseUrl, apiKey, modelId, ...SAMPLING } }, own);
    return handler;
  }

  const server = createContractServer(
    identity,
    async (message, caller) => {
      const handle = await ready();
      if (typeof handle === 'string') {
        const run = { ...startRunState(identity, now, limits), citations: [], caseActions: [] };
        recordError(run, handle);
        return failed(run, handle);
      }
      return handle(message, caller);
    },
    checkToken,
  );

  server.listen(PORT, HOST, () => {
    console.log(definition.listening(HOST, PORT));
  });

  function stop(): void {
    server.close();
    server.closeAllConnections();
  }

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
