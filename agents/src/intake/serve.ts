// Starts an intake agent on port 8080, through the shared startup in ../run/serve.ts. Shared by both
// implementations: each main file names its implementation, says how to build its handler, and chooses its
// server by the function it calls: the hand-written agent serveIntakeAgent (the hand-written contract server),
// the agent on Strands serveIntakeAgentOnSdk (the AgentCore SDK server, which also reads LOCAL_RUNTIME_EDGE).
//
// Reads from the environment what ../run/serve.ts reads for every agent, and one setting of its own:
//   CASE_MCP_URL           the address of the case system's MCP endpoint

import type { AccessTokenSettings } from '../../../shared/access-token.ts';
import type { TokenExchangeSettings } from '../../../shared/token-exchange.ts';
import { agentSettingsFrom, required, serveAgent } from '../run/serve.ts';
import type { BaseWiring, Environment, Handler, Server } from '../run/serve.ts';
import { LIMITS } from './settings.ts';

export type { Handler } from '../run/serve.ts';

export type Wiring = BaseWiring & { caseMcpUrl: string };

export type AgentSettings = {
  baseUrl: string;
  apiKey: string;
  namedModel: string | undefined;
  caseMcpUrl: string;
  agentId: string;
  // A token must still be valid for the run's whole time limit, so it cannot expire during a run.
  auth: AccessTokenSettings;
  exchange: TokenExchangeSettings;
};

const readCaseMcpUrl = (env: Environment): string => required(env, 'CASE_MCP_URL', "the address of the case system's MCP endpoint");

// Every setting the agent starts with, from the environment object given. Throws, naming the variable,
// when one is missing.
export function settingsFrom(env: Environment): AgentSettings {
  const { baseUrl, apiKey, namedModel, agentId, auth, exchange, own } = agentSettingsFrom(env, LIMITS, readCaseMcpUrl);
  return { baseUrl, apiKey, namedModel, caseMcpUrl: own, agentId, auth, exchange };
}

// The hand-written agent: served by the hand-written contract server.
export function serveIntakeAgent(implementation: string, build: (wiring: Wiring) => Handler): void {
  serveIntake(implementation, 'hand-written contract server', build);
}

// The agent on Strands: served by the AgentCore SDK server.
export function serveIntakeAgentOnSdk(implementation: string, build: (wiring: Wiring) => Handler): void {
  serveIntake(implementation, 'AgentCore SDK server', build);
}

function serveIntake(implementation: string, server: Server, build: (wiring: Wiring) => Handler): void {
  serveAgent({
    implementation,
    server,
    limits: LIMITS,
    readOwn: readCaseMcpUrl,
    title: `Intake agent (${implementation})`,
    build: (wiring, caseMcpUrl) => build({ ...wiring, caseMcpUrl }),
  });
}
