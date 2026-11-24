// Starts the trace store: one SQLite store and one HTTP server on 4318, the OTLP/HTTP port. No route reads a token;
// compose publishes the port on this machine only.

import { createServer } from 'node:http';

import { handle } from './http.ts';
import { settingsFrom } from './settings.ts';
import type { TraceStoreSettings } from './settings.ts';
import { TraceStore } from './store.ts';

const PORT = 4318;
const HOST = '0.0.0.0';

let settings: TraceStoreSettings;
try {
  settings = settingsFrom(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const store = new TraceStore(settings.databasePath, settings.retainSpans);

const server = createServer((request, response) => {
  const send = (status: number, body: unknown): void => {
    // A body left unread (an answer before or past the size limit) ends the connection rather than being drained.
    response.writeHead(status, { 'content-type': 'application/json', ...(request.method === 'POST' && !request.readableEnded ? { connection: 'close' } : {}) });
    response.end(JSON.stringify(body));
  };
  handle(store, { method: request.method ?? '', url: request.url ?? '/', headers: request.headers, body: request })
    .then((answer) => send(answer.status, answer.body))
    .catch((error: unknown) => {
      console.error(`trace store: request failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      send(500, { code: 13, message: 'The store could not complete the request.' });
    });
});

server.listen(PORT, HOST, () => {
  console.log(`Trace store listening on ${HOST}:${PORT}, keeping the newest ${settings.retainSpans} spans`);
});

function stop(): void {
  server.close();
  server.closeAllConnections();
  store.close();
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
