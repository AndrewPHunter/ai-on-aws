// Starts an intake agent on port 8080. Shared by both implementations: each main file names its
// implementation and says how to build its handler, and everything else about starting is here.
//
// Reads from the environment, and nowhere else does:
//   MODEL_BASE_URL  the address of the model server, ending in /v1
//   MODEL_API_KEY   the key the model server expects
//   MODEL_ID        optional; the model server is asked which model it serves when this is unset
//   CASE_MCP_URL    the address of the case system's MCP endpoint
//   AGENT_ID        the name this agent records its changes under

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

export type Wiring = {
  identity: AgentIdentity;
  now: () => Date;
  limits: Limits;
  model: ModelSettings;
  caseMcpUrl: string;
};

export type Handler = (message: InboundMessage) => Promise<InvocationResponse>;

function required(name: string, meaning: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    console.error(`${name} is not set. It is ${meaning}.`);
    process.exit(2);
  }
  return value.trim();
}

export function serveIntakeAgent(implementation: string, build: (wiring: Wiring) => Handler): void {
  const baseUrl = required('MODEL_BASE_URL', 'the address of the model server, ending in /v1').replace(/\/+$/, '');
  const apiKey = required('MODEL_API_KEY', 'the key the model server expects');
  const caseMcpUrl = required('CASE_MCP_URL', "the address of the case system's MCP endpoint");
  const agentId = required('AGENT_ID', 'the name this agent records its changes under');
  const namedModel = process.env['MODEL_ID']?.trim();

  const identity: AgentIdentity = { id: agentId, implementation };
  const now = (): Date => new Date();

  // The model's name is asked of the server once, on first use, unless MODEL_ID names it.
  let handler: Handler | undefined;
  async function ready(): Promise<Handler | string> {
    if (handler !== undefined) {
      return handler;
    }
    let modelId = namedModel;
    if (modelId === undefined || modelId === '') {
      const served = await servedModelId(baseUrl, apiKey, 10_000);
      if (!served.ok) {
        return served.reason;
      }
      modelId = served.id;
    }
    handler = build({ identity, now, limits: LIMITS, model: { baseUrl, apiKey, modelId, ...SAMPLING }, caseMcpUrl });
    return handler;
  }

  const server = createContractServer(identity, async (message) => {
    const handle = await ready();
    if (typeof handle === 'string') {
      const run = startRun(identity, now, LIMITS);
      recordError(run, handle);
      return failed(run, handle);
    }
    return handle(message);
  });

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
