// Starts the intake agent on Strands, served by the AgentCore SDK server.

import { createChatModel } from '../model/chat.ts';
import { createReportCheck } from './report-check.ts';
import { serveIntakeAgentOnSdk } from './serve.ts';
import { handleInquiry } from './strands.ts';

serveIntakeAgentOnSdk('Strands', ({ identity, now, limits, model, exchange, caseMcpUrl, telemetry }) => {
  // The report check is not part of Strands' loop: it is one chat request of its own, made by this agent's code.
  // On the SDK server the telemetry handle is off, so it records nothing.
  const reportCheck = createReportCheck(createChatModel(model), telemetry);
  return (message, caller) => handleInquiry({ identity, model, caseMcpUrl, exchange, now, limits, reportCheck }, message, caller);
});
