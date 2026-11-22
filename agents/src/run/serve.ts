// Starts an agent on port 8080. Shared by every agent: each says which server it is served by, how to read its
// own settings, the limits it runs with, its name for the line it logs at start, and how to build its handler;
// everything else about starting is here.
//
// Two servers serve the same contract:
//   the hand-written contract server   ../contract/server.ts, written here with nothing from an SDK
//   the AgentCore SDK server           AWS's BedrockAgentCoreApp, through ../contract/runtime.ts, loaded only for it
//
// Reads from the environment object it is given, and nowhere else:
//   MODEL_BASE_URL         the address of the model server, ending in /v1
//   MODEL_API_KEY          the key the model server expects
//   MODEL_ID               optional; the model server is asked which model it serves when this is unset
//   AGENT_ID               the name this agent records its changes under, and its client id at the identity provider
//   AUTH_DISCOVERY_URL     where to fetch the identity provider's discovery document
//   AUTH_ISSUER            the issuer that document and every access token must name
//   AUTH_ALLOWED_AUDIENCE  a value that must be in the access token's aud
//   AUTH_ALLOWED_CLIENTS   the client ids an access token may be issued to, separated by commas
//   AUTH_REQUIRED_SCOPES   the scopes an access token must hold at least one of, separated by commas
//   AUTH_ROLES_CLAIM       the access-token claim holding the caller's roles
//   EXCHANGE_TOKEN_ENDPOINT  the identity provider's token endpoint, where the caller's token is exchanged
//   EXCHANGE_CLIENT_SECRET   this agent's client secret at the identity provider, for the exchange
//   LOCAL_RUNTIME_EDGE     on the AgentCore SDK server only: on or off (see ../contract/runtime-contract.ts)
// and whatever the agent's own reader reads from the same object.

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import type { AccessTokenSettings, Caller } from '../../../shared/access-token.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import { createTokenExchange } from '../../../shared/token-exchange.ts';
import type { TokenExchange, TokenExchangeSettings } from '../../../shared/token-exchange.ts';
import { runtimeLayoutFrom } from '../contract/runtime-contract.ts';
import type { RuntimeLayout } from '../contract/runtime-contract.ts';
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
  // Exchanges the token the agent was called with for one meant for its tool server. One per process.
  exchange: TokenExchange;
};

export type Handler = (message: InboundMessage, caller: Caller) => Promise<InvocationResponse>;

export type AgentSettings<Own> = {
  baseUrl: string;
  apiKey: string;
  namedModel: string | undefined;
  agentId: string;
  // A token must still be valid for the run's whole time limit, so it cannot expire during a run.
  auth: AccessTokenSettings;
  // The client id is AGENT_ID. The secret is written in no line the agent logs.
  exchange: TokenExchangeSettings;
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
// one is missing. The agent's own settings are read after the model's and before AGENT_ID, and the exchange's
// after AGENT_ID, so when several are missing the one named first is always the same.
export function agentSettingsFrom<Own>(env: Environment, limits: Limits, readOwn: (env: Environment) => Own): AgentSettings<Own> {
  const clients = required(env, 'AUTH_ALLOWED_CLIENTS', 'the client ids an access token may be issued to, separated by commas')
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client !== '');
  if (clients.length === 0) {
    throw new Error('AUTH_ALLOWED_CLIENTS names no client id.');
  }
  const scopes = required(env, 'AUTH_REQUIRED_SCOPES', 'the scopes an access token must hold at least one of, separated by commas')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  if (scopes.length === 0) {
    throw new Error('AUTH_REQUIRED_SCOPES names no scope.');
  }
  const namedModel = env['MODEL_ID']?.trim();
  const baseUrl = required(env, 'MODEL_BASE_URL', 'the address of the model server, ending in /v1').replace(/\/+$/, '');
  const apiKey = required(env, 'MODEL_API_KEY', 'the key the model server expects');
  const own = readOwn(env);
  const agentId = required(env, 'AGENT_ID', 'the name this agent records its changes under, and its client id at the identity provider');
  const exchange: TokenExchangeSettings = {
    tokenEndpoint: required(env, 'EXCHANGE_TOKEN_ENDPOINT', "the identity provider's token endpoint, where the caller's token is exchanged"),
    clientId: agentId,
    clientSecret: required(env, 'EXCHANGE_CLIENT_SECRET', "this agent's client secret at the identity provider"),
  };
  return {
    baseUrl,
    apiKey,
    namedModel: namedModel === '' ? undefined : namedModel,
    agentId,
    auth: {
      discoveryUrl: required(env, 'AUTH_DISCOVERY_URL', "where to fetch the identity provider's discovery document"),
      issuer: required(env, 'AUTH_ISSUER', 'the issuer the discovery document and every access token must name'),
      audience: required(env, 'AUTH_ALLOWED_AUDIENCE', "a value that must be in the access token's aud"),
      allowedClients: clients,
      requiredScopes: scopes,
      rolesClaim: required(env, 'AUTH_ROLES_CLAIM', "the access-token claim holding the caller's roles"),
      minRemainingSeconds: limits.runMs / 1000,
    },
    exchange,
    own,
  };
}

export type Server = 'hand-written contract server' | 'AgentCore SDK server';

export type AgentDefinition<Own> = {
  implementation: string;
  server: Server;
  limits: Limits;
  readOwn: (env: Environment) => Own;
  // The agent's name as the line logged at start gives it, such as "Label expert (Strands)".
  title: string;
  build: (wiring: BaseWiring, own: Own) => Handler;
};

export function serveAgent<Own>(definition: AgentDefinition<Own>): void {
  const { implementation, limits } = definition;
  let settings: AgentSettings<Own>;
  let layout: RuntimeLayout | undefined;
  try {
    settings = agentSettingsFrom(process.env, limits, definition.readOwn);
    layout = definition.server === 'AgentCore SDK server' ? runtimeLayoutFrom(process.env) : undefined;
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
  const exchange = createTokenExchange(settings.exchange, { fetch, now });

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
    handler = definition.build({ identity, now, limits, model: { baseUrl, apiKey, modelId, ...SAMPLING }, exchange }, own);
    return handler;
  }

  const respond: Handler = async (message, caller) => {
    const handle = await ready();
    if (typeof handle === 'string') {
      const run = { ...startRunState(identity, now, limits), citations: [], caseActions: [] };
      recordError(run, handle);
      return failed(run, handle);
    }
    return handle(message, caller);
  };

  if (layout !== undefined) {
    // Loaded here only, so the hand-written agent never loads the SDK, Fastify or the AWS clients.
    const sdkLayout = layout;
    import('../contract/runtime.ts')
      .then(({ startOnAgentCoreSdk }) => {
        startOnAgentCoreSdk({ title: definition.title, identity, handler: respond, checkToken, layout: sdkLayout });
      })
      .catch((error: unknown) => {
        console.error(`The AgentCore SDK server could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
    return;
  }

  const server = createContractServer(identity, respond, checkToken);

  server.listen(PORT, HOST, () => {
    console.log(`${definition.title} listening on ${HOST}:${PORT}`);
  });

  function stop(): void {
    server.close();
    server.closeAllConnections();
  }

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
