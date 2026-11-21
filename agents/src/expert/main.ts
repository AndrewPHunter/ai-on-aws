// Starts the label expert on port 8080, through the shared startup in ../run/serve.ts. What it reads is in
// serve.ts.

import { serveAgent } from '../run/serve.ts';
import { readKnowledgeMcpUrl } from './serve.ts';
import { EXPERT_LIMITS, EXPERT_SETTINGS, OUTPUT_ALLOWANCE } from './settings.ts';
import { handleQuestion } from './strands.ts';

serveAgent({
  implementation: 'Strands',
  limits: EXPERT_LIMITS,
  readOwn: readKnowledgeMcpUrl,
  listening: (host, port) => `Label expert (Strands) listening on ${host}:${port}`,
  // The shared startup gives the shared output allowance; this agent's own is set here.
  build: ({ identity, now, limits, model }, knowledgeMcpUrl) => (message, caller) =>
    handleQuestion(
      { identity, now, limits, knowledgeMcpUrl, settings: EXPERT_SETTINGS, model: { ...model, maxTokens: OUTPUT_ALLOWANCE } },
      message,
      caller,
    ),
});
