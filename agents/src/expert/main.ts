// Starts the label expert on port 8080, through the shared startup in ../run/serve.ts, served by the AgentCore
// SDK server. What it reads is in serve.ts, and LOCAL_RUNTIME_EDGE in ../contract/runtime-contract.ts.

import { serveAgent } from '../run/serve.ts';
import { readKnowledgeMcpUrl } from './serve.ts';
import { EXPERT_LIMITS, EXPERT_SETTINGS, OUTPUT_ALLOWANCE } from './settings.ts';
import { handleQuestion } from './strands.ts';

serveAgent({
  implementation: 'Strands',
  server: 'AgentCore SDK server',
  limits: EXPERT_LIMITS,
  readOwn: readKnowledgeMcpUrl,
  title: 'Label expert (Strands)',
  // The shared startup gives the shared output allowance; this agent's own is set here.
  build: ({ identity, now, limits, model }, knowledgeMcpUrl) => (message, caller) =>
    handleQuestion(
      { identity, now, limits, knowledgeMcpUrl, settings: EXPERT_SETTINGS, model: { ...model, maxTokens: OUTPUT_ALLOWANCE } },
      message,
      caller,
    ),
});
