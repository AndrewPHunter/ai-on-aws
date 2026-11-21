// Starts the intake agent on Strands.

import { serveIntakeAgent } from './serve.ts';
import { handleInquiry } from './strands.ts';

serveIntakeAgent('Strands', ({ identity, now, limits, model, caseMcpUrl }) => (message) =>
  handleInquiry({ identity, model, caseMcpUrl, now, limits }, message),
);
