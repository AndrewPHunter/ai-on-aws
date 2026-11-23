// Starts the orchestrator on port 8080, through the shared startup in ../run/serve.ts, served by the AgentCore SDK
// server. What it reads is in serve.ts, and LOCAL_RUNTIME_EDGE in ../contract/runtime-contract.ts.

import type { ModelSettings } from '../model/served.ts';
import { serveAgent } from '../run/serve.ts';
import type { BaseWiring, Handler } from '../run/serve.ts';
import { readSubAgentAddresses } from './serve.ts';
import { ORCHESTRATOR_LIMITS, ORCHESTRATOR_SETTINGS } from './settings.ts';
import { handleInquiry } from './strands.ts';
import { callOverHttp } from './sub-agents.ts';
import type { SubAgentId } from './sub-agents.ts';

function handlerFor(
  { identity, now, limits, exchange }: Omit<BaseWiring, 'model'>,
  addresses: Record<SubAgentId, string>,
  model: ModelSettings | { unavailable: string },
): Handler {
  const callSubAgent = callOverHttp(addresses, fetch);
  return (message, caller) => handleInquiry({ identity, now, limits, exchange, model, callSubAgent, settings: ORCHESTRATOR_SETTINGS }, message, caller);
}

serveAgent({
  implementation: 'Strands',
  server: 'AgentCore SDK server',
  limits: ORCHESTRATOR_LIMITS,
  readOwn: readSubAgentAddresses,
  title: 'Orchestrator (Strands)',
  build: (wiring, addresses) => handlerFor(wiring, addresses, wiring.model),
  // Screening runs whatever the model does, so a message is screened even while the model's name cannot be learnt.
  withoutModel: (wiring, addresses, reason) => handlerFor(wiring, addresses, { unavailable: reason }),
});
