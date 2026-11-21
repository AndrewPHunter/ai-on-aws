// Starts the client: reads its settings, opens the store, settles runs a previous process left
// running, and serves sign-in, the API and the web app on 3000. The identity provider is not asked
// anything until someone signs in, so the client starts while it is down.

import { randomBytes, randomUUID } from 'node:crypto';

import { configFrom } from './config.ts';
import type { Config } from './config.ts';
import { IdentityProvider } from './identity.ts';
import { AGENT_TOKEN_MIN_LIFE_MS, createClientServer } from './server.ts';
import { SessionStore } from './sessions.ts';
import { InquiryStore } from './store.ts';

const PORT = 3000;
const HOST = '0.0.0.0';
// Long enough for an agent that makes several model and tool calls on a self-hosted model. The access
// token sent with a run must outlive this wait, so the two are one number.
const AGENT_TIMEOUT_MS = AGENT_TOKEN_MIN_LIFE_MS;

let config: Config;
try {
  config = configFrom(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const now = (): Date => new Date();
const store = new InquiryStore(config.dbPath, now);
const interrupted = store.failInterruptedRuns();
if (interrupted > 0) {
  console.log(`Marked ${interrupted} run(s) left running by a previous process as failed.`);
}

const identity = new IdentityProvider(config.oidc, { claim: config.rolesClaim, reviewerRole: config.reviewerRole }, now);
const sessions = new SessionStore(now, randomBytes);

const server = createClientServer({
  config,
  store,
  now,
  newId: randomUUID,
  agentTimeoutMs: AGENT_TIMEOUT_MS,
  identity,
  sessions,
});

server.listen(PORT, HOST, () => {
  console.log(`Client listening on ${HOST}:${PORT} with ${config.agents.length} agent(s) configured`);
});

// An agent call still in flight would keep the process alive until it times out. It is not waited
// for: its run stays running in the store and is marked failed by failInterruptedRuns at next start.
function stop(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
