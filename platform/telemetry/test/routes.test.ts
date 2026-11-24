// The trace store's invariants 1 to 4 ("Always true" in platform/telemetry/README.md). The routes are called as a
// function given a request, over a store on an in-memory database; no socket is opened.

import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { MAX_BODY_BYTES, handle } from '../src/http.ts';
import type { Answer } from '../src/http.ts';
import { TraceStore } from '../src/store.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER_TRACE = '5ce03f4688c45eb7b4df030e1f1f5847';
const JSON_TYPE = { 'content-type': 'application/json' };

type SpanInput = { trace?: string; span: string; parent?: string; start: number; attributes?: unknown[] };

const text = (key: string, value: string): unknown => ({ key, value: { stringValue: value } });

function span(input: SpanInput): unknown {
  return {
    traceId: input.trace ?? TRACE,
    spanId: input.span,
    ...(input.parent === undefined ? {} : { parentSpanId: input.parent }),
    name: `op-${input.span}`,
    kind: 2,
    startTimeUnixNano: String(1_772_359_200_000_000_000n + BigInt(input.start)),
    endTimeUnixNano: String(1_772_359_200_000_000_000n + BigInt(input.start) + 1_000n),
    attributes: input.attributes ?? [],
    status: { code: 1 },
  };
}

function exportOf(spans: unknown[], resource: unknown[] = [text('service.name', 'intake'), text('lab.telemetry.schema_version', '1')]): unknown {
  return { resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope: { name: 'intake' }, spans }] }] };
}

async function* chunks(body: string | Buffer): AsyncIterable<Uint8Array> {
  yield typeof body === 'string' ? Buffer.from(body) : body;
}

function storeFor(t: TestContext, retain = 1_000): TraceStore {
  const store = new TraceStore(':memory:', retain);
  t.after(() => store.close());
  return store;
}

const call = (store: TraceStore, method: string, url: string, headers: IncomingHttpHeaders = {}, body: string | Buffer = ''): Promise<Answer> =>
  handle(store, { method, url, headers, body: chunks(body) });

const post = (store: TraceStore, body: unknown, headers: IncomingHttpHeaders = JSON_TYPE): Promise<Answer> =>
  call(store, 'POST', '/v1/traces', headers, typeof body === 'string' ? body : JSON.stringify(body));

const spanIds = (answer: Answer): string[] => (answer.body as { spans: { span_id: string }[] }).spans.map((s) => s.span_id);
const held = (store: TraceStore): number => store.status().spans_held;

test('telemetry 1. a valid export is stored once and read back by trace, ordered by start, and by run', async (t) => {
  const store = storeFor(t);
  const run = [text('lab.run.id', 'run-7'), { key: 'lab.attempt', value: { intValue: '2' } }];
  const first = exportOf([
    span({ span: 'bbbbbbbbbbbbbbbb', parent: 'aaaaaaaaaaaaaaaa', start: 20, attributes: run }),
    span({ span: 'AAAAAAAAAAAAAAAA', start: 10, attributes: run }),
  ]);
  const rows: { name: string; body: unknown; held: number }[] = [
    { name: 'first delivery', body: first, held: 2 },
    { name: 'the same export again', body: first, held: 2 },
    { name: 'an empty export', body: {}, held: 2 },
    { name: 'another trace of the run, and one of no run', body: exportOf([span({ trace: OTHER_TRACE, span: 'cccccccccccccccc', start: 5, attributes: run }), span({ trace: OTHER_TRACE.replace('5', '6'), span: 'dddddddddddddddd', start: 1 })]), held: 4 },
  ];
  for (const row of rows) {
    assert.deepEqual(await post(store, row.body), { status: 200, body: {} }, row.name);
    assert.equal(held(store), row.held, row.name);
  }

  const trace = await call(store, 'GET', `/traces/${TRACE}`);
  assert.equal(trace.status, 200);
  assert.deepEqual(spanIds(trace), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  const [root, child] = (trace.body as { spans: Record<string, unknown>[] }).spans;
  assert.deepEqual(root, {
    trace_id: TRACE, span_id: 'aaaaaaaaaaaaaaaa', parent_span_id: null, service: 'intake', name: 'op-AAAAAAAAAAAAAAAA', kind: 'server',
    start_time_unix_nano: '1772359200000000010', end_time_unix_nano: '1772359200000001010', status: 'ok',
    attributes: { 'lab.run.id': 'run-7', 'lab.attempt': 2 }, resource: { 'service.name': 'intake', 'lab.telemetry.schema_version': '1' }, schema_version: '1',
  });
  assert.equal(child?.parent_span_id, 'aaaaaaaaaaaaaaaa');
  assert.deepEqual(await call(store, 'GET', '/traces?run_id=run-7'), { status: 200, body: { run_id: 'run-7', trace_ids: [OTHER_TRACE, TRACE] } });
  assert.deepEqual(await call(store, 'GET', '/traces?run_id=run-8'), { status: 200, body: { run_id: 'run-8', trace_ids: [] } });
  assert.equal((await call(store, 'GET', `/traces/${'e'.repeat(32)}`)).status, 404);
});

test('telemetry 2. an invalid, oversized or non-JSON export is refused with its status and nothing of it is stored', async (t) => {
  const store = storeFor(t);
  const good = span({ span: 'aaaaaaaaaaaaaaaa', start: 1 });
  const rows: { name: string; body: unknown; headers?: IncomingHttpHeaders; status: number }[] = [
    { name: 'not JSON', body: '{"resourceSpans": [', status: 400 },
    { name: 'not an object', body: [good], status: 400 },
    { name: 'resourceSpans not a list', body: { resourceSpans: {} }, status: 400 },
    { name: 'a short trace id beside a good span', body: exportOf([good, { ...(good as object), spanId: 'bbbbbbbbbbbbbbbb', traceId: 'abc' }]), status: 400 },
    { name: 'an all-zero span id', body: exportOf([{ ...(good as object), spanId: '0000000000000000' }]), status: 400 },
    { name: 'a time that is not a number', body: exportOf([{ ...(good as object), startTimeUnixNano: 'yesterday' }]), status: 400 },
    { name: 'a kind out of range', body: exportOf([{ ...(good as object), kind: 9 }]), status: 400 },
    { name: 'an attribute without a key', body: exportOf([{ ...(good as object), attributes: [{ value: { stringValue: 'x' } }] }]), status: 400 },
    { name: 'over the size limit', body: exportOf([{ ...(good as object), name: 'x'.repeat(MAX_BODY_BYTES) }]), status: 413 },
    { name: 'a declared length over the limit', body: exportOf([good]), headers: { ...JSON_TYPE, 'content-length': String(MAX_BODY_BYTES + 1) }, status: 413 },
    { name: 'protobuf', body: exportOf([good]), headers: { 'content-type': 'application/x-protobuf' }, status: 415 },
    { name: 'gzip', body: exportOf([good]), headers: { ...JSON_TYPE, 'content-encoding': 'gzip' }, status: 415 },
  ];
  for (const row of rows) {
    const answer = await post(store, row.body, row.headers);
    assert.equal(answer.status, row.status, row.name);
    assert.equal(held(store), 0, row.name);
  }
  assert.deepEqual(store.status().refused, {});
});

test('telemetry 3. only the newest spans by arrival are held', async (t) => {
  const store = storeFor(t, 3);
  const ids = ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444', '5555555555555555'];
  // Arrival order is not start order: the newest to arrive starts earliest.
  for (const [index, id] of ids.entries()) await post(store, exportOf([span({ span: id, start: 100 - index })]));
  assert.equal(held(store), 3);
  assert.deepEqual(spanIds(await call(store, 'GET', `/traces/${TRACE}`)), ['5555555555555555', '4444444444444444', '3333333333333333']);
});

test('telemetry 4. no route asks for a token; a span over a limit is refused whole, counted in the answer and in /status', async (t) => {
  const store = storeFor(t);
  const many = Array.from({ length: 65 }, (_, n) => text(`k${n}`, 'v'));
  const answer = await post(store, exportOf([
    span({ span: 'aaaaaaaaaaaaaaaa', start: 1 }),
    span({ span: 'bbbbbbbbbbbbbbbb', start: 2, attributes: many }),
    span({ span: 'cccccccccccccccc', start: 3, attributes: [text('lab.run.id', 'x'.repeat(257))] }),
    span({ span: 'dddddddddddddddd', start: 4, attributes: [{ key: 'lab.run.id', value: { arrayValue: { values: [] } } }] }),
  ]));
  assert.equal(answer.status, 200);
  assert.equal((answer.body as { partialSuccess: { rejectedSpans: string } }).partialSuccess.rejectedSpans, '3');
  assert.equal((await post(store, exportOf([span({ trace: OTHER_TRACE, span: 'eeeeeeeeeeeeeeee', start: 5 })], [text('service.name', 'y'.repeat(300))]))).status, 200);
  assert.deepEqual(store.status(), {
    spans_held: 1,
    retain_spans: 1_000,
    oldest_span_start: '2026-03-01T10:00:00.000Z',
    refused: { too_many_attributes: 1, unsupported_value: 1, value_too_long: 2 },
  });
  // Every route answers a request that carries no authorization header.
  const routes: [string, string][] = [['GET', '/ping'], ['GET', '/status'], ['GET', `/traces/${TRACE}`], ['GET', '/traces?run_id=run-7']];
  for (const [method, url] of routes) {
    const status = (await call(store, method, url)).status;
    assert.ok(status !== 401 && status !== 403, `${method} ${url}: ${status}`);
  }
  assert.deepEqual(spanIds(await call(store, 'GET', `/traces/${TRACE}`)), ['aaaaaaaaaaaaaaaa']);
});
