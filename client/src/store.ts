// The client's store: every inquiry received and every run made of it.
// An inquiry's id and receipt time are fixed here once, and every run of it reuses them.

import { DatabaseSync } from 'node:sqlite';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { Inquiry, InquiryList, InquirySummary, Run, RunState, RunSummary } from '../shared/api.ts';

export const LIST_LIMIT = 100;
export const INTERRUPTED_ERROR = 'The client restarted while this run was in progress.';
export const STALE_ERROR =
  'The answer stored for this run no longer matches the agent contract, so it cannot be shown.';

// Each table has an integer key in insertion order. Ordering uses it, not the timestamps, because
// two rows can carry the same time and "newest first" must still be one answer.
const SCHEMA = `
create table if not exists inquiries (
  n integer primary key autoincrement,
  id text not null unique,
  received_at text not null,
  sender text not null,
  text text not null
) strict;

create table if not exists runs (
  n integer primary key autoincrement,
  id text not null unique,
  inquiry_id text not null references inquiries(id),
  agent_id text not null,
  state text not null check (state in ('running', 'completed', 'failed')),
  started_at text not null,
  finished_at text,
  duration_ms integer,
  error text,
  response text
) strict;

create index if not exists runs_by_inquiry on runs(inquiry_id, n);
`;

const STATES = ['running', 'completed', 'failed'] as const;

export type NewInquiry = { id: string; receivedAt: string; sender: string; text: string };

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} does not hold text`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} holds neither text nor null`);
  }
  return value;
}

function optionalInteger(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Column ${column} holds neither an integer nor null`);
  }
  return value;
}

function stateOf(row: Row): RunState {
  const value = text(row, 'state');
  const state = STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new Error(`Unknown run state ${value}`);
  }
  return state;
}

// The response was validated against the contract before it was stored; parsing again on the way
// out gives a typed value and catches a row changed by hand.
// A stored answer is read back through the contract. If the contract has changed since it was stored,
// that one run is shown as failed with the reason; the rest of the inbox still loads.
function storedResponse(row: Row): { response: InvocationResponse | null; stale: boolean } {
  const stored = optionalText(row, 'response');
  if (stored === null) {
    return { response: null, stale: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return { response: null, stale: true };
  }
  const parsed = invocationResponseSchema.safeParse(value);
  return parsed.success ? { response: parsed.data, stale: false } : { response: null, stale: true };
}

function runOf(row: Row): Run {
  const { response, stale } = storedResponse(row);
  return {
    id: text(row, 'id'),
    inquiry_id: text(row, 'inquiry_id'),
    agent_id: text(row, 'agent_id'),
    state: stale ? 'failed' : stateOf(row),
    started_at: text(row, 'started_at'),
    finished_at: optionalText(row, 'finished_at'),
    duration_ms: optionalInteger(row, 'duration_ms'),
    error: stale ? STALE_ERROR : optionalText(row, 'error'),
    response,
  };
}

function summaryOf(run: Run): RunSummary {
  return {
    id: run.id,
    agent_id: run.agent_id,
    state: run.state,
    case_ids: run.response === null ? [] : run.response.case_actions.map((action) => action.case_id),
  };
}

export class InquiryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec('pragma foreign_keys = on');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createInquiry(inquiry: NewInquiry): void {
    this.db
      .prepare('insert into inquiries (id, received_at, sender, text) values (?, ?, ?, ?)')
      .run(inquiry.id, inquiry.receivedAt, inquiry.sender, inquiry.text);
  }

  // Returns undefined when the inquiry does not exist, so no run is started for nothing.
  startRun(runId: string, inquiryId: string, agentId: string): Run | undefined {
    if (this.db.prepare('select 1 from inquiries where id = ?').get(inquiryId) === undefined) {
      return undefined;
    }
    this.db
      .prepare("insert into runs (id, inquiry_id, agent_id, state, started_at) values (?, ?, ?, 'running', ?)")
      .run(runId, inquiryId, agentId, this.now().toISOString());
    return this.getRun(runId);
  }

  // Only a run still running is settled. A late answer for a run already failed, for example by
  // failInterruptedRuns, leaves it as it is. Returns whether the run was settled.
  completeRun(runId: string, response: InvocationResponse): boolean {
    return this.settle(runId, 'completed', null, JSON.stringify(response));
  }

  failRun(runId: string, error: string): boolean {
    return this.settle(runId, 'failed', error, null);
  }

  // Called once at startup. A run left running by a previous process will never be settled by it.
  failInterruptedRuns(): number {
    const running = this.db.prepare("select id from runs where state = 'running'").all();
    let failed = 0;
    for (const row of running) {
      if (this.failRun(text(row, 'id'), INTERRUPTED_ERROR)) {
        failed += 1;
      }
    }
    return failed;
  }

  getRun(runId: string): Run | undefined {
    const row = this.db.prepare('select * from runs where id = ?').get(runId);
    return row === undefined ? undefined : runOf(row);
  }

  getInquiry(inquiryId: string): Inquiry | undefined {
    const row = this.db.prepare('select * from inquiries where id = ?').get(inquiryId);
    if (row === undefined) {
      return undefined;
    }
    return {
      id: text(row, 'id'),
      received_at: text(row, 'received_at'),
      sender: text(row, 'sender'),
      text: text(row, 'text'),
      runs: this.runsOf(inquiryId),
    };
  }

  // Newest first. One more row than the limit is read to know whether the list is truncated.
  listInquiries(): InquiryList {
    const rows = this.db.prepare('select * from inquiries order by n desc limit ?').all(LIST_LIMIT + 1);
    const inquiries: InquirySummary[] = rows.slice(0, LIST_LIMIT).map((row) => {
      const id = text(row, 'id');
      return {
        id,
        received_at: text(row, 'received_at'),
        sender: text(row, 'sender'),
        text: text(row, 'text'),
        runs: this.runsOf(id).map(summaryOf),
      };
    });
    return { inquiries, truncated: rows.length > LIST_LIMIT };
  }

  private runsOf(inquiryId: string): Run[] {
    return this.db.prepare('select * from runs where inquiry_id = ? order by n').all(inquiryId).map(runOf);
  }

  private settle(runId: string, state: RunState, error: string | null, response: string | null): boolean {
    const row = this.db.prepare("select started_at from runs where id = ? and state = 'running'").get(runId);
    if (row === undefined) {
      return false;
    }
    const finished = this.now();
    const durationMs = Math.max(0, finished.getTime() - new Date(text(row, 'started_at')).getTime());
    const result = this.db
      .prepare(
        "update runs set state = ?, finished_at = ?, duration_ms = ?, error = ?, response = ? where id = ? and state = 'running'",
      )
      .run(state, finished.toISOString(), durationMs, error, response, runId);
    return result.changes === 1;
  }
}
