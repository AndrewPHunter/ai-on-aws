// What the label expert reads from the environment: what ../run/serve.ts reads for every agent, and one setting
// of its own:
//   KNOWLEDGE_MCP_URL      the address of the retrieval service's MCP endpoint

import { agentSettingsFrom, required } from '../run/serve.ts';
import type { AgentSettings, Environment } from '../run/serve.ts';
import { EXPERT_LIMITS } from './settings.ts';

export const readKnowledgeMcpUrl = (env: Environment): string =>
  required(env, 'KNOWLEDGE_MCP_URL', "the address of the retrieval service's MCP endpoint");

// Every setting the agent starts with, from the environment object given. Throws, naming the variable, when one
// is missing.
export function expertSettingsFrom(env: Environment): AgentSettings<string> {
  return agentSettingsFrom(env, EXPERT_LIMITS, readKnowledgeMcpUrl);
}
