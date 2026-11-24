// Invariant 15 of client/README.md ("Always true"): every run exports its accepted span, its root span when it ends,
// and its call to the agent as a span of its own whose outcome tells an answer inside the contract from one outside it
// and from no answer; the request to the agent carries that span's trace context. The telemetry handle is passed in and
// exports to an exporter in this file's memory; the agent is a scripted server that answers by the message's text.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { SpanKind } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { startTelemetry } from '../../shared/telemetry.ts';
import type { SpanExporter } from '../../shared/telemetry.ts';
import type { Answer } from './support.ts';
import { EXAMPLE_RESPONSE, at, call, clock, deskConfig, machineTokens, scripted, startDesk } from './support.ts';

// Keeps every span exported, and wakes whoever waits for one.
class Exported implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  private readonly waiting: (() => void)[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    for (const wake of this.waiting.splice(0)) wake();
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  async waitFor(match: (span: ReadableSpan) => boolean): Promise<ReadableSpan> {
    for (;;) {
      const found = this.spans.find(match);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }
}

const ANSWERS: Record<string, () => Answer | Promise<Answer>> = {
  'outside the contract': () => ({ status: 200, body: { ...EXAMPLE_RESPONSE, reply: 42 } }),
  'no answer': () => new Promise(() => undefined),
};
const agent = await scripted({ after }, (r) => ANSWERS[String(at(r.body, 'message', 'text'))]?.() ?? { status: 200, body: EXAMPLE_RESPONSE });
const time = clock();
const machine = machineTokens(time.now);
const exported = new Exported();
// Exported a millisecond after a span ends; the wait for the agent is a tenth of a second, for "no answer in time".
const telemetry = startTelemetry(
  { service: 'client', endpoint: 'http://telemetry.test/v1/traces', queue: { maxSpans: 100, maxBatch: 100, delayMs: 1, exportTimeoutMs: 1_000 } },
  { now: () => time.now().getTime(), log: () => undefined, exporter: exported },
);
const config = deskConfig({ agents: [{ id: 'scripted', name: 'Scripted', description: 'scripted', url: agent.url, wait_seconds: 0.1 }], caseReviewUrl: 'http://127.0.0.1:1' });
const desk = await startDesk({ after }, config, time, undefined, machine, undefined, { telemetry });

// Runs a new message through the lab explorer's route, and gives the spans of its trace once its root span is exported.
async function run(text: string): Promise<{ ids: Record<string, string>; trace: ReadableSpan[] }> {
  const { body } = await call(`${desk.url}/lab/api/runs`, { method: 'POST', body: { agent_id: 'scripted', sender: 'A clinician', text } });
  const ids = { 'lab.run.id': String(at(body, 'run_id')), 'lab.inquiry.id': String(at(body, 'inquiry_id')), 'gen_ai.agent.id': 'scripted' };
  const root = await exported.waitFor((span) => span.name === 'desk.run' && span.attributes['lab.run.id'] === ids['lab.run.id']);
  return { ids, trace: exported.spans.filter((span) => span.spanContext().traceId === root.spanContext().traceId) };
}

// Each span of a trace as its name, kind, parent's name and attributes, by name.
function shape(trace: ReadableSpan[]): unknown[] {
  const nameOf = (spanId: string | undefined) => trace.find((span) => span.spanContext().spanId === spanId)?.name ?? null;
  return trace
    .map((span) => ({ name: span.name, kind: span.kind, parent: nameOf(span.parentSpanContext?.spanId), attributes: span.attributes }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('invariant 15: every run exports its accepted span, its root span when it ends, and its call to the agent with an outcome of its own; the request carries that span\'s context', { timeout: 10_000 }, async (t) => {
  const rows = [
    { name: 'an answer inside the contract', text: 'inside the contract', refuse: false, run: 'completed', call: 'executed' },
    { name: 'an answer outside the contract', text: 'outside the contract', refuse: false, run: 'failed', call: 'failed' },
    { name: 'no answer in time', text: 'no answer', refuse: false, run: 'failed', call: 'response_lost' },
    { name: 'a token that cannot be got: no call is made', text: 'token refused', refuse: true, run: 'failed', call: null },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      machine.refuse = row.refuse;
      try {
        const { ids, trace } = await run(row.text);
        const invoke = { name: 'agent.invoke', kind: SpanKind.CLIENT, parent: 'desk.run', attributes: { 'lab.operation.id': ids['lab.run.id'], 'lab.attempt': 1, 'lab.outcome': row.call } };
        assert.deepEqual(shape(trace), [
          ...(row.call === null ? [] : [invoke]),
          { name: 'desk.run', kind: SpanKind.INTERNAL, parent: null, attributes: { ...ids, 'lab.outcome': row.run } },
          { name: 'desk.run.accepted', kind: SpanKind.INTERNAL, parent: 'desk.run', attributes: ids },
        ]);
      } finally {
        machine.refuse = false;
      }
    });
  }
  await t.test('the traceparent the agent received names the agent.invoke span', async () => {
    const { trace } = await run('carries the context');
    const invoke = trace.find((span) => span.name === 'agent.invoke')?.spanContext();
    const received = await agent.waitFor((r) => at(r.body, 'message', 'text') === 'carries the context');
    assert.equal(received.traceparent, `00-${String(invoke?.traceId)}-${String(invoke?.spanId)}-01`);
  });
});
