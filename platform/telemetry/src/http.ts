// The trace store's routes, as a function of one request: its method, its path and query, its headers, and its body
// as a stream, read only by POST /v1/traces and never past the size limit. main.ts gives it Node's requests. No route
// reads a token: the store is reachable on this machine and the lab's internal network only.

import type { IncomingHttpHeaders } from 'node:http';

import { InvalidExport, readExport } from './otlp.ts';
import type { TraceStore } from './store.ts';

export const MAX_BODY_BYTES = 1_000_000;

export type Request = { method: string; url: string; headers: IncomingHttpHeaders; body: AsyncIterable<Uint8Array> };
export type Answer = { status: number; body: unknown };

const ok = (body: unknown): Answer => ({ status: 200, body });
// google.rpc.Status in JSON, as OTLP/HTTP answers an error. Code 3 is INVALID_ARGUMENT.
const invalid = (message: string): Answer => ({ status: 400, body: { code: 3, message } });
const tooLarge: Answer = { status: 413, body: { code: 3, message: `The body is over ${MAX_BODY_BYTES} bytes.` } };

class TooLarge extends Error {}

async function readLimited(body: AsyncIterable<Uint8Array>, declaredLength: string | undefined): Promise<Buffer> {
  if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES) throw new TooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function receive(store: TraceStore, request: Request): Promise<Answer> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  const encoding = request.headers['content-encoding']?.trim().toLowerCase();
  if (contentType !== 'application/json' || (encoding !== undefined && encoding !== 'identity')) {
    return { status: 415, body: { code: 3, message: 'Only content-type application/json, with no content encoding, is accepted.' } };
  }
  let raw: Buffer;
  try {
    raw = await readLimited(request.body, request.headers['content-length']);
  } catch (error) {
    if (error instanceof TooLarge) return tooLarge;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return invalid('The body is not JSON.');
  }
  let read;
  try {
    read = readExport(parsed);
  } catch (error) {
    if (error instanceof InvalidExport) return invalid(`The body is not an OTLP trace export: ${error.message}.`);
    throw error;
  }
  store.record(read.spans, read.refused);
  if (read.refused.length === 0) return ok({});
  const reasons = [...new Set(read.refused)].sort().join(', ');
  return ok({ partialSuccess: { rejectedSpans: String(read.refused.length), errorMessage: `Spans over a limit were refused: ${reasons}.` } });
}

export async function handle(store: TraceStore, request: Request): Promise<Answer> {
  const url = new URL(request.url, 'http://trace-store');
  const path = url.pathname;
  const allow = (method: string, answer: () => Answer | Promise<Answer>): Answer | Promise<Answer> =>
    request.method === method ? answer() : { status: 405, body: { error: 'method_not_allowed' } };

  if (path === '/v1/traces') return allow('POST', () => receive(store, request));
  if (path === '/ping') return allow('GET', () => ok({ ok: true }));
  if (path === '/status') return allow('GET', () => ok(store.status()));
  if (path === '/traces') {
    return allow('GET', () => {
      const runId = url.searchParams.get('run_id');
      if (runId === null || runId === '') return { status: 400, body: { error: 'run_id_required' } };
      return ok({ run_id: runId, trace_ids: store.tracesOfRun(runId) });
    });
  }
  const traceId = /^\/traces\/([^/]+)$/.exec(path)?.[1];
  if (traceId !== undefined) {
    return allow('GET', () => {
      const spans = store.trace(traceId);
      return spans.length === 0 ? { status: 404, body: { error: 'trace_not_found' } } : ok({ trace_id: spans[0]?.trace_id, spans });
    });
  }
  return { status: 404, body: { error: 'not_found' } };
}
