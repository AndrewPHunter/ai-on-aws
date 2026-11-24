// Telemetry handles for the case system's tests: one that records nothing, and one whose spans are kept in memory
// and read after shutdown. Nothing is sent over a network.

import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { LAB_QUEUE, startTelemetry } from '../../../shared/telemetry.ts';
import type { SpanExporter, Telemetry } from '../../../shared/telemetry.ts';

class KeptSpans implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function telemetryOff(): Telemetry {
  return startTelemetry({ service: 'case-system', endpoint: null, queue: LAB_QUEUE }, { now: () => 0, log: () => {} });
}

// A handle whose ended spans are returned, in the order they ended, by spans().
export function recordingTelemetry(): { telemetry: Telemetry; spans: () => Promise<ReadableSpan[]> } {
  const exporter = new KeptSpans();
  let clock = Date.parse('2026-01-01T09:00:00.000Z');
  const telemetry = startTelemetry(
    { service: 'case-system', endpoint: 'http://telemetry.test/v1/traces', queue: LAB_QUEUE },
    { now: () => (clock += 1), log: () => {}, exporter },
  );
  return {
    telemetry,
    spans: async () => {
      await telemetry.shutdown(5_000);
      return exporter.spans;
    },
  };
}
