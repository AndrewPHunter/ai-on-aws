// The lab explorer's view of a run's execution evidence: the spans the trace store holds for it. The run's id finds the
// traces whose spans carry it (GET /traces?run_id=), and every span of those traces is returned (GET /traces/<id>), so
// the spans of the agents and the case system in the same trace come back with the client's own.
//
// The store is reached through the same small interface as the search engine (knowledge.ts), so the server is given it
// as a value; traceStoreAt is the one that talks to the real store. Every way a read can fail comes back as a code and a
// sentence that never holds the store's address; nothing is retried, and no answer is read until it has the shape
// expected.

import { z } from 'zod';

import type { ExportedSpan, RunSpansResponse } from '../shared/api.ts';
import { engineAt } from './knowledge.ts';
import type { EngineAnswer } from './knowledge.ts';

export const TRACE_STORE_TIMEOUT_MS = 5_000;

export type TraceStore = { get: (path: string) => Promise<EngineAnswer> };

// A GET of JSON from the store at baseUrl, with the search engine's reader: the reason for no answer names only the
// error code.
export function traceStoreAt(baseUrl: string): TraceStore {
  return engineAt(baseUrl, TRACE_STORE_TIMEOUT_MS);
}

export type SpansRead = { ok: true; answer: RunSpansResponse } | { ok: false; code: string; detail: string };

const runTracesSchema = z.object({ trace_ids: z.array(z.string().min(1)) });

const nanos = z.string().regex(/^\d+$/);
const spanSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  service: z.string().nullable(),
  name: z.string(),
  kind: z.enum(['internal', 'server', 'client', 'producer', 'consumer', 'unspecified']),
  start_time_unix_nano: nanos,
  end_time_unix_nano: nanos,
  status: z.enum(['unset', 'ok', 'error']),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
const traceSchema = z.object({ spans: z.array(spanSchema) });
type StoredSpan = z.infer<typeof spanSchema>;

function failed(path: string, answer: EngineAnswer): SpansRead {
  if (answer.outcome === 'down') return { ok: false, code: 'trace_store_unreachable', detail: `The trace store did not answer GET ${path}: ${answer.reason}` };
  return { ok: false, code: 'trace_store_error', detail: `The trace store answered GET ${path} with status ${answer.status}.` };
}

const unexpected = (path: string): SpansRead => ({ ok: false, code: 'trace_store_unexpected_answer', detail: `The trace store's answer to GET ${path} is not in the form this server reads.` });

// Nanoseconds since the epoch, as the store gives them, to an ISO 8601 time in milliseconds.
function isoOf(unixNano: string): string {
  return new Date(Number(BigInt(unixNano) / 1_000_000n)).toISOString();
}

function exported(span: StoredSpan): ExportedSpan {
  return {
    trace_id: span.trace_id,
    span_id: span.span_id,
    parent: span.parent_span_id,
    service: span.service,
    name: span.name,
    kind: span.kind,
    start: isoOf(span.start_time_unix_nano),
    end: isoOf(span.end_time_unix_nano),
    status: span.status,
    attributes: span.attributes,
  };
}

// Every span of the traces that carry the run's id, in start order. A trace the list named that the store no longer
// holds (404, deleted by its retention between the two reads) has no spans to give.
export async function readRunSpans(store: TraceStore, runId: string): Promise<SpansRead> {
  const listPath = `/traces?run_id=${encodeURIComponent(runId)}`;
  const listed = await store.get(listPath);
  if (listed.outcome === 'down' || listed.status !== 200) return failed(listPath, listed);
  const traces = runTracesSchema.safeParse(listed.body);
  if (!traces.success) return unexpected(listPath);

  const spans: StoredSpan[] = [];
  for (const traceId of traces.data.trace_ids) {
    const tracePath = `/traces/${encodeURIComponent(traceId)}`;
    const answer = await store.get(tracePath);
    if (answer.outcome === 'answered' && answer.status === 404) continue;
    if (answer.outcome === 'down' || answer.status !== 200) return failed(tracePath, answer);
    const trace = traceSchema.safeParse(answer.body);
    if (!trace.success) return unexpected(tracePath);
    spans.push(...trace.data.spans);
  }
  // The times are past the safe-integer range as numbers, so they are compared as BigInt. The sort is stable.
  spans.sort((a, b) => {
    const [x, y] = [BigInt(a.start_time_unix_nano), BigInt(b.start_time_unix_nano)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { ok: true, answer: { evidence: spans.length === 0 ? 'none' : 'found', spans: spans.map(exported) } };
}
