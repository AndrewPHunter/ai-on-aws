// The spans, in SQLite: each once by trace id and span id, the newest `retainSpans` by arrival, and a count of the
// spans refused, by reason. Times are kept as zero-padded decimal text of nanoseconds, so they sort and lose nothing.

import { DatabaseSync } from 'node:sqlite';

import type { RefusalReason, Scalar, StoredSpan } from './otlp.ts';

const SCHEMA = `
create table if not exists spans (
  seq integer primary key autoincrement,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  service text,
  name text not null,
  kind text not null,
  start_ns text not null,
  end_ns text not null,
  status text not null,
  attributes text not null,
  resource text not null,
  schema_version text,
  run_id text,
  unique (trace_id, span_id)
) strict;
create index if not exists spans_by_trace on spans (trace_id, start_ns);
create index if not exists spans_by_run on spans (run_id);

create table if not exists refusals (
  reason text primary key,
  count integer not null
) strict;
`;

const PAD = 20;

export type SpanView = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service: string | null;
  name: string;
  kind: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  status: string;
  attributes: Record<string, Scalar>;
  resource: Record<string, Scalar>;
  schema_version: string | null;
};

export type StoreStatus = {
  spans_held: number;
  retain_spans: number;
  oldest_span_start: string | null;
  refused: Record<string, number>;
};

type Row = Record<string, unknown>;

function column(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw new Error(`Column ${name} is not text`);
  return value;
}

function nullable(row: Row, name: string): string | null {
  return row[name] === null ? null : column(row, name);
}

function count(row: Row | undefined, name: string): number {
  const value = row?.[name];
  if (typeof value !== 'number') throw new Error(`Column ${name} is not a number`);
  return value;
}

const unpad = (padded: string): string => BigInt(padded).toString();

function scalars(json: string): Record<string, Scalar> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Stored attributes are not an object');
  return parsed as Record<string, Scalar>;
}

export class TraceStore {
  private readonly db: DatabaseSync;
  private readonly retainSpans: number;

  constructor(path: string, retainSpans: number) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.retainSpans = retainSpans;
  }

  // Stores the spans not already held and counts the refusals, then deletes all but the newest retainSpans, in one
  // transaction: nothing of a failed write is kept.
  record(spans: readonly StoredSpan[], refused: readonly RefusalReason[]): void {
    const insert = this.db.prepare(`insert or ignore into spans
      (trace_id, span_id, parent_span_id, service, name, kind, start_ns, end_ns, status, attributes, resource, schema_version, run_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const refusal = this.db.prepare('insert into refusals (reason, count) values (?, 1) on conflict (reason) do update set count = count + 1');
    this.db.exec('begin immediate');
    try {
      for (const span of spans) {
        insert.run(
          span.traceId, span.spanId, span.parentSpanId, span.service, span.name, span.kind,
          span.start.padStart(PAD, '0'), span.end.padStart(PAD, '0'), span.status,
          JSON.stringify(span.attributes), JSON.stringify(span.resource), span.schemaVersion, span.runId,
        );
      }
      for (const reason of refused) refusal.run(reason);
      this.db.prepare('delete from spans where seq <= (select seq from spans order by seq desc limit 1 offset ?)').run(this.retainSpans);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  trace(traceId: string): SpanView[] {
    const rows = this.db.prepare('select * from spans where trace_id = ? order by start_ns, seq').all(traceId.toLowerCase());
    return rows.map((row) => ({
      trace_id: column(row, 'trace_id'),
      span_id: column(row, 'span_id'),
      parent_span_id: nullable(row, 'parent_span_id'),
      service: nullable(row, 'service'),
      name: column(row, 'name'),
      kind: column(row, 'kind'),
      start_time_unix_nano: unpad(column(row, 'start_ns')),
      end_time_unix_nano: unpad(column(row, 'end_ns')),
      status: column(row, 'status'),
      attributes: scalars(column(row, 'attributes')),
      resource: scalars(column(row, 'resource')),
      schema_version: nullable(row, 'schema_version'),
    }));
  }

  // The traces with a span carrying this run id, the earliest-starting first.
  tracesOfRun(runId: string): string[] {
    const rows = this.db.prepare('select trace_id, min(start_ns) as first from spans where run_id = ? group by trace_id order by first, trace_id').all(runId);
    return rows.map((row) => column(row, 'trace_id'));
  }

  status(): StoreStatus {
    const held = this.db.prepare('select count(*) as n, min(start_ns) as oldest from spans').get();
    const oldest = held?.oldest;
    const refused: Record<string, number> = {};
    for (const row of this.db.prepare('select reason, count from refusals order by reason').all()) {
      refused[column(row, 'reason')] = count(row, 'count');
    }
    return {
      spans_held: count(held, 'n'),
      retain_spans: this.retainSpans,
      oldest_span_start: typeof oldest === 'string' ? new Date(Number(BigInt(oldest) / 1_000_000n)).toISOString() : null,
      refused,
    };
  }

  close(): void {
    this.db.close();
  }
}
