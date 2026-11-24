// Starts the intake agent with the hand-written loop.

import { setTimeout as sleep } from 'node:timers/promises';

import { createChatModel } from '../model/chat.ts';
import { connectCaseTools } from '../tools/case-system.ts';
import { CASE_SYSTEM, connectWithToolToken } from '../tools/tool-token.ts';
import { handleInquiry } from './handwritten.ts';
import { createReportCheck } from './report-check.ts';
import { serveIntakeAgent } from './serve.ts';

serveIntakeAgent('hand-written loop', ({ identity, now, limits, model, exchange, caseMcpUrl, telemetry }) => {
  const chat = createChatModel(model);
  const reportCheck = createReportCheck(chat, telemetry);
  // The caller's token is exchanged for one meant for the case system, and only that one is connected with.
  const connectTools = connectWithToolToken(
    exchange,
    CASE_SYSTEM,
    (inbound, token, timeoutMs) => connectCaseTools(caseMcpUrl, inbound, identity.id, token, timeoutMs, telemetry),
    now,
  );
  return (message, caller) =>
    handleInquiry(
      {
        identity,
        model: chat,
        connectTools,
        now,
        sleep: (ms) => sleep(ms),
        random: Math.random,
        reportCheck,
        limits,
        telemetry,
      },
      message,
      caller,
    );
});
