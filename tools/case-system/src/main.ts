// Starts the case system: one store, the agent server on 8000 and the review server on 8001. Both
// require a valid access token on every route but GET /ping, each judged by its own check.

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import { LAB_QUEUE, startTelemetry } from '../../../shared/telemetry.ts';
import { createAgentServer, createReviewServer } from './http.ts';
import { settingsFrom } from './settings.ts';
import type { CaseSystemSettings } from './settings.ts';
import { CaseStore } from './store.ts';

const AGENT_PORT = 8000;
const REVIEW_PORT = 8001;
const HOST = '0.0.0.0';
// After a token names a key not yet seen, the provider's keys are fetched again at most this often.
const KEY_REFETCH_WAIT_MS = 30_000;
const IDENTITY_TIMEOUT_MS = 5_000;
// On SIGTERM, how long waiting spans are given to be sent before the process stops.
const TELEMETRY_SHUTDOWN_MS = 5_000;

let settings: CaseSystemSettings;
try {
  settings = settingsFrom(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const now = (): Date => new Date();
const telemetry = startTelemetry(
  { service: 'case-system', endpoint: settings.telemetryEndpoint, queue: LAB_QUEUE },
  { now: () => Date.now(), log: (line) => console.log(line) },
);
const store = new CaseStore(settings.databasePath, now);
const checkOptions = { now, keyRefetchWaitMs: KEY_REFETCH_WAIT_MS, timeoutMs: IDENTITY_TIMEOUT_MS };
const agentServer = createAgentServer(store, now, createAccessTokenCheck(settings.agentServerAuth, checkOptions), telemetry);
const reviewServer = createReviewServer(store, createAccessTokenCheck(settings.reviewServerAuth, checkOptions), telemetry);

agentServer.listen(AGENT_PORT, HOST, () => {
  console.log(`Agent server (MCP at /mcp) listening on ${HOST}:${AGENT_PORT}`);
});
reviewServer.listen(REVIEW_PORT, HOST, () => {
  console.log(`Review server listening on ${HOST}:${REVIEW_PORT}`);
});

let stopping = false;

// Stops taking requests, then gives telemetry its time limit to send what is waiting and says, in counts only,
// what was sent and what was not.
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  agentServer.close();
  reviewServer.close();
  agentServer.closeAllConnections();
  reviewServer.closeAllConnections();
  store.close();
  const { counts, notSent, timedOut } = await telemetry.shutdown(TELEMETRY_SHUTDOWN_MS);
  if (telemetry.on) {
    console.log(
      `telemetry: ${counts.ended} spans ended, ${counts.exported} exported, ${counts.failed} failed, ${counts.dropped} dropped, ` +
        `${notSent} not sent${timedOut ? ', the time limit ran out' : ''}`,
    );
  }
}

process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
