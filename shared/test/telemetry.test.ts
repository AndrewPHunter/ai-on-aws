// The telemetry module's invariants 8 to 11 ("Always true" in shared/README.md). The exporter and the clock are passed
// in; nothing is sent over a network.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { AttributeRefused, startTelemetry } from '../telemetry.ts';
import type { QueueSettings, SpanAttributes, SpanExporter, Telemetry } from '../telemetry.ts';

const CONTENT = 'patient JD, 54, reported muscle pain on examplamab';
const QUEUE: QueueSettings = { maxSpans: 100, maxBatch: 10, delayMs: 60_000, exportTimeoutMs: 60_000 };

// Answers each export as told: at once with success or failure, or not until answer() is called.
class TestExporter implements SpanExporter {
  mode: 'succeed' | 'fail' | 'hold' = 'succeed';
  readonly spans: ReadableSpan[] = [];
  private readonly held: ((result: ExportResult) => void)[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    if (this.mode === 'hold') {
      this.held.push((result) => {
        if (result.code === ExportResultCode.SUCCESS) this.spans.push(...spans);
        done(result);
      });
      return;
    }
    if (this.mode === 'succeed') this.spans.push(...spans);
    done({ code: this.mode === 'succeed' ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
  }

  answer(code: ExportResultCode): void {
    for (const done of this.held.splice(0)) done({ code });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function start(exporter: TestExporter, queue: QueueSettings = QUEUE): Telemetry {
  let clock = Date.parse('2026-03-01T10:00:00.000Z');
  return startTelemetry(
    { service: 'test-piece', endpoint: 'http://telemetry.test/v1/traces', queue },
    { now: () => (clock += 5), log: () => {}, exporter },
  );
}

const named = (spans: ReadableSpan[], name: string): ReadableSpan => {
  const found = spans.find((span) => span.name === name);
  assert.ok(found, `no span ${name}`);
  return found;
};

test('shared 8. a span always ends; a throw ends it as a failure without the message and is thrown again; off records nothing', async () => {
  const rows: { name: string; work: (set: (a: SpanAttributes) => void) => unknown; thrown: boolean; status: number; outcome: string | undefined }[] = [
    { name: 'returns', work: () => 'answer', thrown: false, status: 1, outcome: undefined },
    { name: 'sets an outcome and returns', work: (set) => set({ 'lab.outcome': 'executed' }), thrown: false, status: 1, outcome: 'executed' },
    { name: 'throws an Error', work: () => { throw new Error(CONTENT); }, thrown: true, status: 2, outcome: 'failed' },
    { name: 'rejects with text', work: () => Promise.reject(new TypeError(CONTENT)), thrown: true, status: 2, outcome: 'failed' },
    { name: 'sets response_lost, then throws', work: (set) => { set({ 'lab.outcome': 'response_lost' }); throw new Error(CONTENT); }, thrown: true, status: 2, outcome: 'response_lost' },
  ];
  const exporter = new TestExporter();
  const telemetry = start(exporter);
  for (const row of rows) {
    const run = telemetry.span(row.name, { kind: 'internal' }, (span) => row.work((a) => span.set(a)));
    if (row.thrown) await assert.rejects(run, (error: Error) => error.message === CONTENT, row.name);
    else await run;
  }
  const report = await telemetry.shutdown(5_000);
  assert.equal(report.counts.ended, rows.length);
  for (const row of rows) {
    const span = named(exporter.spans, row.name);
    assert.ok(span.ended, row.name);
    assert.equal(span.status.code, row.status, row.name);
    assert.equal(span.attributes['lab.outcome'], row.outcome, row.name);
    assert.ok(!JSON.stringify([span.status, span.attributes, span.events]).includes('muscle pain'), row.name);
  }

  const off = startTelemetry({ service: 'test-piece', endpoint: null, queue: QUEUE }, { now: () => 0, log: () => {} });
  assert.equal(off.on, false);
  assert.equal(await off.span('off', { kind: 'internal', attributes: { 'lab.run.id': 'run-1' } }, () => 'answer'), 'answer');
  await assert.rejects(off.span('off', { kind: 'internal' }, () => { throw new Error(CONTENT); }));
  const headers: Record<string, string> = {};
  off.inject(headers);
  assert.deepEqual(headers, {});
  assert.deepEqual((await off.shutdown(1_000)).counts, { ended: 0, exported: 0, failed: 0, dropped: 0 });
});

test('shared 9. traceparent carries the current span across a boundary and an await; a missing or malformed one starts a new trace', async () => {
  const exporter = new TestExporter();
  const telemetry = start(exporter);
  const headers: Record<string, string> = {};
  await telemetry.span('caller', { kind: 'client' }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await telemetry.span('nested', { kind: 'internal' }, () => telemetry.inject(headers));
  });
  const parent = telemetry.extract(headers);
  assert.ok(parent);
  await telemetry.span('callee', { kind: 'server', parent }, () => {});

  const bad: Record<string, string | string[] | undefined>[] = [
    {},
    { traceparent: undefined },
    { traceparent: 'garbage' },
    { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
    { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01' },
    { traceparent: 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    { traceparent: ['garbage'] },
  ];
  for (const [index, row] of bad.entries()) {
    const found = telemetry.extract(row);
    assert.equal(found, null, JSON.stringify(row));
    await telemetry.span(`fresh-${index}`, { kind: 'server', parent: found }, () => {});
  }
  await telemetry.shutdown(5_000);

  const caller = named(exporter.spans, 'caller');
  const nested = named(exporter.spans, 'nested');
  const callee = named(exporter.spans, 'callee');
  assert.equal(nested.parentSpanContext?.spanId, caller.spanContext().spanId);
  assert.equal(callee.spanContext().traceId, caller.spanContext().traceId);
  assert.equal(callee.parentSpanContext?.spanId, nested.spanContext().spanId);
  for (const index of bad.keys()) {
    const fresh = named(exporter.spans, `fresh-${index}`);
    assert.equal(fresh.parentSpanContext, undefined);
    assert.notEqual(fresh.spanContext().traceId, caller.spanContext().traceId);
  }
});

test('shared 10. only declared attributes of their declared type are recorded; anything else is refused at the call; unknown usage is left out', async () => {
  const refused: { name: string; attributes: unknown }[] = [
    { name: 'an undeclared name', attributes: { 'message.text': CONTENT } },
    { name: 'an outcome outside the list', attributes: { 'lab.outcome': 'success' } },
    { name: 'a requester outside the list', attributes: { 'lab.requested_by': 'user' } },
    { name: 'an attempt of 0', attributes: { 'lab.attempt': 0 } },
    { name: 'a fractional attempt', attributes: { 'lab.attempt': 1.5 } },
    { name: 'an unknown attempt', attributes: { 'lab.attempt': null } },
    { name: 'a token count as text', attributes: { 'gen_ai.usage.input_tokens': '12' } },
    { name: 'a negative token count', attributes: { 'gen_ai.usage.output_tokens': -1 } },
    { name: 'an object as an id', attributes: { 'lab.run.id': { text: CONTENT } } },
    { name: 'an id too long', attributes: { 'lab.run.id': 'x'.repeat(257) } },
    { name: 'an empty id', attributes: { 'lab.run.id': '' } },
  ];
  const exporter = new TestExporter();
  const telemetry = start(exporter);
  for (const row of refused) {
    let ran = false;
    const attributes = row.attributes as SpanAttributes;
    await assert.rejects(telemetry.span(`start: ${row.name}`, { kind: 'internal', attributes }, () => { ran = true; }), AttributeRefused, row.name);
    assert.equal(ran, false, row.name);
    await assert.rejects(telemetry.span(`set: ${row.name}`, { kind: 'internal' }, (span) => span.set(attributes)), AttributeRefused, row.name);
  }
  await telemetry.span('usage', { kind: 'client', attributes: { 'gen_ai.request.model': 'chat', 'gen_ai.usage.input_tokens': null } }, (span) =>
    span.set({ 'gen_ai.usage.output_tokens': 12, 'lab.finish_reason': 'stop' }),
  );
  await telemetry.shutdown(5_000);

  const declared = new Set(['lab.outcome', 'gen_ai.request.model', 'gen_ai.usage.output_tokens', 'lab.finish_reason']);
  for (const span of exporter.spans) {
    assert.ok(!span.name.startsWith('start: '), `${span.name} was recorded`);
    for (const name of Object.keys(span.attributes)) assert.ok(declared.has(name), `${span.name} carries ${name}`);
  }
  assert.deepEqual(named(exporter.spans, 'usage').attributes, {
    'gen_ai.request.model': 'chat',
    'gen_ai.usage.output_tokens': 12,
    'lab.finish_reason': 'stop',
  });
});

test('shared 11. a full queue drops and counts, a failing exporter counts, and shutdown returns within its limit naming what was not sent', async () => {
  const exporter = new TestExporter();
  exporter.mode = 'hold';
  const telemetry = start(exporter, { maxSpans: 2, maxBatch: 1, delayMs: 60_000, exportTimeoutMs: 60_000 });
  // The first span is handed to the exporter, which holds it; two more wait; the last two find the queue full.
  for (const index of [1, 2, 3, 4, 5]) await telemetry.span(`span-${index}`, { kind: 'internal' }, () => {});
  assert.deepEqual(telemetry.counts(), { ended: 5, exported: 0, failed: 0, dropped: 2 });
  exporter.mode = 'succeed';
  exporter.answer(ExportResultCode.FAILED);
  const report = await telemetry.shutdown(5_000);
  assert.deepEqual(report, { counts: { ended: 5, exported: 2, failed: 1, dropped: 2 }, notSent: 0, timedOut: false });

  const stuck = new TestExporter();
  stuck.mode = 'hold';
  const slow = start(stuck, { maxSpans: 10, maxBatch: 10, delayMs: 60_000, exportTimeoutMs: 60_000 });
  for (const index of [1, 2, 3]) await slow.span(`stuck-${index}`, { kind: 'internal' }, () => {});
  const limited = await slow.shutdown(20);
  assert.deepEqual(limited, { counts: { ended: 3, exported: 0, failed: 0, dropped: 0 }, notSent: 3, timedOut: true });
});
