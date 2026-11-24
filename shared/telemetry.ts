// Execution evidence: the spans a piece records as its operations end, exported over OTLP/HTTP JSON while the work
// goes on, and joined across pieces by the W3C traceparent header. See docs/architecture/telemetry.md.
//
// Everything is passed in: the settings, the clock (span start and end times), the log function and, for tests, the
// exporter. It reads no environment variable and registers no OpenTelemetry global (tracer provider, context manager
// or propagator), so a library recording through the global API records nothing. The current span is kept per
// handle, in its own AsyncLocalStorage, so it follows the work across awaits.
//
// Loss is counted where this module owns the boundary: spans ended, handed to the exporter, exported, failed, and
// dropped because no more than maxSpans may wait. The SDK's batch processor keeps its own drop count private, so the
// bound is checked here before a span reaches it, with the processor's queue set to the same size.

import { AsyncLocalStorage } from 'node:async_hooks';

import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, defaultTextMapGetter, defaultTextMapSetter, isSpanContextValid, trace } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOnSampler, BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { RESOURCE_ATTRIBUTES, TELEMETRY_SCHEMA_VERSION, checkedAttributes } from './telemetry-attributes.ts';
import type { Outcome, SpanAttributes } from './telemetry-attributes.ts';

export { AttributeRefused, TELEMETRY_SCHEMA_VERSION } from './telemetry-attributes.ts';
export type { Outcome, Requester, SpanAttributes } from './telemetry-attributes.ts';
export type { SpanExporter } from '@opentelemetry/sdk-trace-base';

export type QueueSettings = {
  // At most this many ended spans wait to be exported; one more is dropped and counted.
  maxSpans: number;
  // At most this many spans go in one export.
  maxBatch: number;
  // Waiting spans are exported at least this often.
  delayMs: number;
  // An export not answered in this time is counted as failed.
  exportTimeoutMs: number;
};

// The queue every piece of the lab uses: enough for a run's spans many times over, sent at least once a second,
// with an export given five seconds to be answered.
export const LAB_QUEUE: QueueSettings = { maxSpans: 2048, maxBatch: 512, delayMs: 1000, exportTimeoutMs: 5000 };

export type TelemetrySettings = {
  service: string;
  // The OTLP/HTTP traces URL, such as http://telemetry:4318/v1/traces. null: telemetry is off.
  endpoint: string | null;
  queue: QueueSettings;
};

export type TelemetryOptions = {
  // Milliseconds since the epoch: when a span starts and ends.
  now: () => number;
  log: (line: string) => void;
  // Replaces the OTLP/HTTP exporter. For tests.
  exporter?: SpanExporter;
};

export type SpanKindName = 'internal' | 'server' | 'client';

// A parent taken from a request by extract.
export type TraceParent = { readonly traceId: string; readonly spanId: string };

export type SpanStart = {
  kind: SpanKindName;
  attributes?: SpanAttributes;
  // Left out: a child of the current span, or a new trace when there is none. A TraceParent: a child of it.
  // null: a new trace.
  parent?: TraceParent | null;
};

export type ActiveSpan = {
  // Adds attributes, such as the outcome, before the span ends. Refuses what is not declared, as at the start.
  set(attributes: SpanAttributes): void;
};

export type TelemetryCounts = { ended: number; exported: number; failed: number; dropped: number };

export type ShutdownReport = {
  counts: TelemetryCounts;
  // Spans ended but neither exported, failed nor dropped when shutdown returned.
  notSent: number;
  // True when the time limit ran out before the flush finished.
  timedOut: boolean;
};

export type Telemetry = {
  readonly on: boolean;
  span<T>(name: string, start: SpanStart, work: (span: ActiveSpan) => T | Promise<T>): Promise<T>;
  inject(headers: Record<string, string>): void;
  extract(headers: Readonly<Record<string, string | string[] | undefined>>): TraceParent | null;
  counts(): TelemetryCounts;
  shutdown(timeoutMs: number): Promise<ShutdownReport>;
};

const KINDS: Record<SpanKindName, SpanKind> = { internal: SpanKind.INTERNAL, server: SpanKind.SERVER, client: SpanKind.CLIENT };
// The outcomes that are a failure of the span's own operation.
const ERROR_OUTCOMES: readonly Outcome[] = ['failed', 'response_lost'];
const OUTCOME = 'lab.outcome';

function wholeAtLeastOne(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Telemetry setting ${name} must be a whole number of 1 or more.`);
}

function checkSettings(settings: TelemetrySettings): void {
  if (settings.service.trim() === '') throw new Error('Telemetry setting service is empty.');
  const { maxSpans, maxBatch, delayMs, exportTimeoutMs } = settings.queue;
  wholeAtLeastOne('queue.maxSpans', maxSpans);
  wholeAtLeastOne('queue.maxBatch', maxBatch);
  wholeAtLeastOne('queue.delayMs', delayMs);
  wholeAtLeastOne('queue.exportTimeoutMs', exportTimeoutMs);
  if (maxBatch > maxSpans) throw new Error('Telemetry setting queue.maxBatch must not be more than queue.maxSpans.');
  if (settings.endpoint !== null) {
    let protocol: string;
    try {
      protocol = new URL(settings.endpoint).protocol;
    } catch {
      throw new Error('Telemetry setting endpoint is not a URL.');
    }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('Telemetry setting endpoint must be an http or https URL.');
  }
}

const zero = (): TelemetryCounts => ({ ended: 0, exported: 0, failed: 0, dropped: 0 });

// Telemetry off: the work runs, attributes are still checked, nothing is recorded.
function offTelemetry(): Telemetry {
  const active: ActiveSpan = { set: (attributes) => void checkedAttributes(attributes) };
  return {
    on: false,
    async span(_name, start, work) {
      checkedAttributes(start.attributes);
      return await work(active);
    },
    inject() {},
    extract: () => null,
    counts: zero,
    shutdown: () => Promise.resolve({ counts: zero(), notSent: 0, timedOut: false }),
  };
}

// Counts each batch as exported or failed, once, and fails one not answered within the time limit.
class CountingExporter implements SpanExporter {
  handed = 0;
  private readonly unanswered = new Set<(result: ExportResult) => void>();
  private readonly inner: SpanExporter;
  private readonly counts: TelemetryCounts;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(inner: SpanExporter, counts: TelemetryCounts, timeoutMs: number, log: (line: string) => void) {
    this.inner = inner;
    this.counts = counts;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const size = spans.length;
    this.handed += size;
    let answered = false;
    const finish = (result: ExportResult): void => {
      if (answered) return;
      answered = true;
      this.unanswered.delete(finish);
      clearTimeout(timer);
      if (result.code === ExportResultCode.SUCCESS) {
        this.counts.exported += size;
      } else {
        this.counts.failed += size;
        this.log(`telemetry: an export of ${size} spans failed`);
      }
      resultCallback(result);
    };
    const timer = setTimeout(() => finish({ code: ExportResultCode.FAILED }), this.timeoutMs);
    timer.unref();
    this.unanswered.add(finish);
    try {
      this.inner.export(spans, finish);
    } catch {
      finish({ code: ExportResultCode.FAILED });
    }
  }

  // Gives up on every export not yet answered: each is counted as failed and the batch processor is told so, which
  // ends its wait. A late answer is ignored.
  abandon(): void {
    for (const finish of [...this.unanswered]) finish({ code: ExportResultCode.FAILED });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

// Counts every ended span and lets no more than maxSpans wait: the rest are dropped and counted.
class BoundedQueue implements SpanProcessor {
  private accepted = 0;
  private dropsUnlogged = 0;
  private stopped = false;
  private readonly inner: SpanProcessor;
  private readonly exporter: CountingExporter;
  private readonly counts: TelemetryCounts;
  private readonly maxSpans: number;
  private readonly log: (line: string) => void;

  constructor(inner: SpanProcessor, exporter: CountingExporter, counts: TelemetryCounts, maxSpans: number, log: (line: string) => void) {
    this.inner = inner;
    this.exporter = exporter;
    this.counts = counts;
    this.maxSpans = maxSpans;
    this.log = log;
  }

  onStart(...args: Parameters<SpanProcessor['onStart']>): void {
    this.inner.onStart(...args);
  }

  onEnd(span: ReadableSpan): void {
    this.counts.ended += 1;
    if (this.stopped || this.accepted - this.exporter.handed >= this.maxSpans) {
      this.counts.dropped += 1;
      this.dropsUnlogged += 1;
      return;
    }
    this.logDrops();
    this.accepted += 1;
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.logDrops();
    await this.inner.shutdown();
  }

  private logDrops(): void {
    if (this.dropsUnlogged === 0) return;
    this.log(`telemetry: ${this.dropsUnlogged} spans dropped, the queue of ${this.maxSpans} was full`);
    this.dropsUnlogged = 0;
  }
}

function parentContext(parent: TraceParent | null | undefined, current: Context): Context {
  if (parent === undefined) return current;
  if (parent === null) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: parent.traceId, spanId: parent.spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true });
}

export function startTelemetry(settings: TelemetrySettings, options: TelemetryOptions): Telemetry {
  checkSettings(settings);
  if (settings.endpoint === null) {
    options.log(`telemetry: off for ${settings.service}, no endpoint is set`);
    return offTelemetry();
  }

  const { maxSpans, maxBatch, delayMs, exportTimeoutMs } = settings.queue;
  const counts = zero();
  const exporter = new CountingExporter(
    options.exporter ??
      new OTLPTraceExporter({
        url: settings.endpoint,
        timeoutMillis: exportTimeoutMs,
        // Every batch waiting at a flush is handed over at once, and the exporter fails one past its limit.
        concurrencyLimit: Math.ceil(maxSpans / maxBatch) + 1,
        compression: CompressionAlgorithm.NONE,
        httpAgentOptions: { keepAlive: true },
      }),
    counts,
    exportTimeoutMs,
    options.log,
  );
  const batches = new BatchSpanProcessor(exporter, {
    maxQueueSize: maxSpans,
    maxExportBatchSize: maxBatch,
    scheduledDelayMillis: delayMs,
    exportTimeoutMillis: exportTimeoutMs,
  });
  // Every limit is given, so none is taken from an OTEL_* variable. Attribute counts and lengths are bounded by the
  // declared attributes; no span here has events or links.
  const limits = { attributeCountLimit: 128, attributeValueLengthLimit: Infinity };
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [RESOURCE_ATTRIBUTES.service]: settings.service,
      [RESOURCE_ATTRIBUTES.schemaVersion]: TELEMETRY_SCHEMA_VERSION,
    }),
    sampler: new AlwaysOnSampler(),
    generalLimits: limits,
    spanLimits: { ...limits, linkCountLimit: 0, eventCountLimit: 0, attributePerEventCountLimit: 0, attributePerLinkCountLimit: 0 },
    forceFlushTimeoutMillis: exportTimeoutMs,
    spanProcessors: [new BoundedQueue(batches, exporter, counts, maxSpans, options.log)],
  });
  const tracer = provider.getTracer(settings.service);
  const propagator = new W3CTraceContextPropagator();
  const currentContext = new AsyncLocalStorage<Context>();
  const current = (): Context => currentContext.getStore() ?? ROOT_CONTEXT;

  async function span<T>(name: string, start: SpanStart, work: (span: ActiveSpan) => T | Promise<T>): Promise<T> {
    const initial = checkedAttributes(start.attributes);
    const parent = parentContext(start.parent, current());
    const recorded: Span = tracer.startSpan(name, { kind: KINDS[start.kind], attributes: initial, startTime: new Date(options.now()) }, parent);
    let outcome = initial[OUTCOME];
    const active: ActiveSpan = {
      set(attributes) {
        const more = checkedAttributes(attributes);
        recorded.setAttributes(more);
        if (more[OUTCOME] !== undefined) outcome = more[OUTCOME];
      },
    };
    try {
      const result = await currentContext.run(trace.setSpan(parent, recorded), () => work(active));
      const failed = typeof outcome === 'string' && (ERROR_OUTCOMES as readonly string[]).includes(outcome);
      recorded.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      return result;
    } catch (error) {
      // The error's message is not recorded: it may hold content.
      if (outcome === undefined) recorded.setAttribute(OUTCOME, 'failed');
      recorded.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      recorded.end(new Date(options.now()));
    }
  }

  async function shutdown(timeoutMs: number): Promise<ShutdownReport> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    // A failed batch is already counted; the flush's own rejection adds nothing.
    const flushed = provider.shutdown().then(() => 'done' as const, () => 'done' as const);
    const how = await Promise.race([flushed, limit]);
    clearTimeout(timer);
    const snapshot = { ...counts };
    const notSent = snapshot.ended - snapshot.exported - snapshot.failed - snapshot.dropped;
    // Then stop: what is still being exported is given up, so nothing waits on it.
    if (how === 'timeout') exporter.abandon();
    if (notSent > 0) options.log(`telemetry: shutdown left ${notSent} spans unsent`);
    return { counts: snapshot, notSent, timedOut: how === 'timeout' };
  }

  return {
    on: true,
    span,
    inject(headers) {
      propagator.inject(current(), headers, defaultTextMapSetter);
    },
    extract(headers) {
      const context = propagator.extract(ROOT_CONTEXT, headers, defaultTextMapGetter);
      const found = trace.getSpanContext(context);
      return found !== undefined && isSpanContextValid(found) ? { traceId: found.traceId, spanId: found.spanId } : null;
    },
    counts: () => ({ ...counts }),
    shutdown,
  };
}
