// Starts the intake agent with the hand-written loop.

import { setTimeout as sleep } from 'node:timers/promises';

import { createChatModel } from '../model/chat.ts';
import { connectCaseTools } from '../tools/case-system.ts';
import { handleInquiry } from './handwritten.ts';
import { serveIntakeAgent } from './serve.ts';

serveIntakeAgent('hand-written loop', ({ identity, now, limits, model, caseMcpUrl }) => {
  const chat = createChatModel(model);
  return (message, caller) =>
    handleInquiry(
      {
        identity,
        model: chat,
        connectTools: (inbound, token, timeoutMs) => connectCaseTools(caseMcpUrl, inbound, identity.id, token, timeoutMs),
        now,
        sleep: (ms) => sleep(ms),
        random: Math.random,
        limits,
      },
      message,
      caller,
    );
});
