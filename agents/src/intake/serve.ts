// Starts an intake agent on port 8080, through the shared startup in ../run/serve.ts. Shared by both
// implementations: each main file names its implementation and says how to build its handler.
//
// Reads from the environment what ../run/serve.ts reads for every agent, and one setting of its own:
//   CASE_MCP_URL           the address of the case system's MCP endpoint

import type { AccessTokenSettings } from '../../../shared/access-token.ts';
import { agentSettingsFrom, required, serveAgent } from '../run/serve.ts';
import type { BaseWiring, Environment, Handler } from '../run/serve.ts';
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
};

const readCaseMcpUrl = (env: Environment): string => required(env, 'CASE_MCP_URL', "the address of the case system's MCP endpoint");

// Every setting the agent starts with, from the environment object given. Throws, naming the variable,
// when one is missing.
export function settingsFrom(env: Environment): AgentSettings {
  const { baseUrl, apiKey, namedModel, agentId, auth, own } = agentSettingsFrom(env, LIMITS, readCaseMcpUrl);
  return { baseUrl, apiKey, namedModel, caseMcpUrl: own, agentId, auth };
}

export function serveIntakeAgent(implementation: string, build: (wiring: Wiring) => Handler): void {
  serveAgent({
    implementation,
    limits: LIMITS,
    readOwn: readCaseMcpUrl,
    listening: (host, port) => `Intake agent (${implementation}) listening on ${host}:${port}`,
    build: (wiring, caseMcpUrl) => build({ ...wiring, caseMcpUrl }),
  });
}
