// What the orchestrator reads from the environment: what ../run/serve.ts reads for every agent, and two settings
// of its own:
//   INTAKE_AGENT_URL       the address of the intake agent on Strands, without /invocations
//   EXPERT_AGENT_URL       the address of the label expert, without /invocations

import { required } from '../run/serve.ts';
import type { Environment } from '../run/serve.ts';
import type { SubAgentId } from './sub-agents.ts';

export function readSubAgentAddresses(env: Environment): Record<SubAgentId, string> {
  return {
    'intake-strands': required(env, 'INTAKE_AGENT_URL', 'the address of the intake agent on Strands').replace(/\/+$/, ''),
    expert: required(env, 'EXPERT_AGENT_URL', 'the address of the label expert').replace(/\/+$/, ''),
  };
}
