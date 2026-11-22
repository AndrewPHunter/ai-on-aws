// Starts the intake agent on Strands, served by the AgentCore SDK server.

import { serveIntakeAgentOnSdk } from './serve.ts';
import { handleInquiry } from './strands.ts';

serveIntakeAgentOnSdk('Strands', ({ identity, now, limits, model, caseMcpUrl }) => (message, caller) =>
  handleInquiry({ identity, model, caseMcpUrl, now, limits }, message, caller),
);
