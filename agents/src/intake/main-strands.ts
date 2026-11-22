// Starts the intake agent on Strands, served by the AgentCore SDK server.

import { serveIntakeAgentOnSdk } from './serve.ts';
import { handleInquiry } from './strands.ts';

serveIntakeAgentOnSdk('Strands', ({ identity, now, limits, model, exchange, caseMcpUrl }) => (message, caller) =>
  handleInquiry({ identity, model, caseMcpUrl, exchange, now, limits }, message, caller),
);
