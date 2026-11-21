// Starts the intake agent with the hand-written loop, on port 8080.

import { createContractServer } from '../contract/server.ts';
import { createChatModel, servedModelId } from '../model/chat.ts';
import type { ChatModel } from '../model/chat.ts';
import { connectCaseTools } from '../tools/case-system.ts';
import { handleInquiry } from './handwritten.ts';

const PORT = 8080;
const HOST = '0.0.0.0';

function required(name: string, meaning: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    console.error(`${name} is not set. It is ${meaning}.`);
    process.exit(2);
  }
  return value.trim();
}

const baseUrl = required('MODEL_BASE_URL', 'the address of the model server, ending in /v1').replace(/\/+$/, '');
const apiKey = required('MODEL_API_KEY', 'the key the model server expects');
const caseMcpUrl = required('CASE_MCP_URL', 'the address of the case system\'s MCP endpoint');
const agentId = required('AGENT_ID', 'the name this agent records its changes under');
const namedModel = process.env['MODEL_ID']?.trim();

const identity = { id: agentId, implementation: 'hand-written loop' };
const now = (): Date => new Date();

// The model's name is asked of the server once, on first use, unless MODEL_ID names it.
let model: ChatModel | undefined;
async function chatModel(): Promise<ChatModel | string> {
  if (model !== undefined) {
    return model;
  }
  let modelId = namedModel;
  if (modelId === undefined || modelId === '') {
    const served = await servedModelId(baseUrl, apiKey, 10_000);
    if (!served.ok) {
      return served.reason;
    }
    modelId = served.id;
  }
  model = createChatModel({ baseUrl, apiKey, modelId, temperature: 0, maxTokens: 2048, seed: 20261120 });
  return model;
}

const server = createContractServer(identity, async (message) => {
  const ready = await chatModel();
  if (typeof ready === 'string') {
    return {
      agent: identity,
      outcome: 'failed',
      stop_reason: ready,
      reply: '',
      citations: [],
      case_actions: [],
      steps: [{ kind: 'error', started_at: now().toISOString(), duration_ms: 0, message: ready }],
    };
  }
  return handleInquiry(
    {
      identity,
      model: ready,
      connectTools: (inbound, timeoutMs) => connectCaseTools(caseMcpUrl, inbound, agentId, timeoutMs),
      now,
      // The client waits 180 s for an agent. The run stops itself well inside that.
      limits: { maxTurns: 6, runMs: 150_000, modelMs: 90_000, toolMs: 10_000 },
    },
    message,
  );
});

server.listen(PORT, HOST, () => {
  console.log(`Intake agent (${identity.implementation}) listening on ${HOST}:${PORT}`);
});

function stop(): void {
  server.close();
  server.closeAllConnections();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
