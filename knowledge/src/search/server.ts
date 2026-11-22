// Starts the retrieval service: MCP at /mcp and /ping on port 8000. Every route but GET /ping requires a valid
// access token.

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import { createEngine } from './engine.ts';
import { createRetrievalServer } from './http.ts';
import { ENGINE_REQUEST_MS } from './limits.ts';
import { retrieverFrom } from './retriever.ts';
import { retrievalSettingsFrom } from './settings.ts';
import type { RetrievalSettings } from './settings.ts';

const PORT = 8000;
const HOST = '0.0.0.0';
// After a token names a key not yet seen, the provider's keys are fetched again at most this often.
const KEY_REFETCH_WAIT_MS = 30_000;
const IDENTITY_TIMEOUT_MS = 5_000;

let settings: RetrievalSettings;
try {
  settings = retrievalSettingsFrom(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const now = (): Date => new Date();
const checkToken = createAccessTokenCheck(settings.auth, { now, keyRefetchWaitMs: KEY_REFETCH_WAIT_MS, timeoutMs: IDENTITY_TIMEOUT_MS });
const engine = createEngine({ baseUrl: settings.searchUrl, fetch: globalThis.fetch, deadline: () => AbortSignal.timeout(ENGINE_REQUEST_MS) });
const server = createRetrievalServer(engine, settings.searchIndex, checkToken, retrieverFrom(settings, globalThis.fetch));

server.listen(PORT, HOST, () => {
  // The strategy, never an address or the key.
  console.log(`Retrieval service (MCP at /mcp, strategy ${settings.strategy}) listening on ${HOST}:${PORT}`);
});

function stop(): void {
  server.close();
  server.closeAllConnections();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
