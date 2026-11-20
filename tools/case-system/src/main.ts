// Starts the case system: one store, the agent server on 8000 and the review server on 8001.

import { createAgentServer, createReviewServer } from './http.ts';
import { CaseStore } from './store.ts';

const AGENT_PORT = 8000;
const REVIEW_PORT = 8001;
const HOST = '0.0.0.0';

const databasePath = process.env['CASE_DB_PATH'];
if (databasePath === undefined || databasePath === '') {
  console.error('CASE_DB_PATH is not set. It is the path of the SQLite file that holds the cases.');
  process.exit(2);
}

const now = (): Date => new Date();
const store = new CaseStore(databasePath, now);
const agentServer = createAgentServer(store, now);
const reviewServer = createReviewServer(store);

agentServer.listen(AGENT_PORT, HOST, () => {
  console.log(`Agent server (MCP at /mcp) listening on ${HOST}:${AGENT_PORT}`);
});
reviewServer.listen(REVIEW_PORT, HOST, () => {
  console.log(`Review server listening on ${HOST}:${REVIEW_PORT}`);
});

function stop(): void {
  agentServer.close();
  reviewServer.close();
  agentServer.closeAllConnections();
  reviewServer.closeAllConnections();
  store.close();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
