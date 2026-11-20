// What the client's tests share: servers on loopback, a temporary directory, a deterministic clock,
// an example agent answer, and a bounded wait for background runs.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { AgentConfig } from '../src/config.ts';
import { createClientServer } from '../src/server.ts';
import { InquiryStore } from '../src/store.ts';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

export function stop(server: Server): void {
  server.close();
  server.closeAllConnections();
}

// A URL that cannot be reached: it accepts each connection and closes it at once. It is held until the
// test ends, so no other test can be given its port in the meantime.
export async function deadUrl(t: TestContext): Promise<string> {
  const server = createNetServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'client-test-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Starts at a fixed instant and moves one second forward each time it is read.
export function steppingClock(start: string): () => Date {
  let seconds = 0;
  const base = new Date(start).getTime();
  return () => new Date(base + 1000 * seconds++);
}

export function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// Reads a field of a JSON value the test does not otherwise need to type.
export function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entries: Record<string, unknown> = { ...value };
  return entries[key];
}

export type Answer = { status: number; headers: Headers; body: unknown };

export async function getJson(url: string): Promise<Answer> {
  const response = await fetch(url);
  const body: unknown = await response.json();
  return { status: response.status, headers: response.headers, body };
}

export async function postJson(url: string, payload: unknown): Promise<Answer> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, headers: response.headers, body };
}

// Polls until the check passes, a few milliseconds apart, and fails the test if it never does.
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await delay(10);
  }
  assert.fail('The condition was not met within the time allowed');
}

// An answer that keeps to the agent contract and names one case.
export const EXAMPLE_RESPONSE: InvocationResponse = {
  agent: { id: 'stand-in', implementation: 'test stand-in' },
  outcome: 'completed',
  stop_reason: null,
  reply: 'The maximum dose is in section 2 of the label.',
  citations: [{ drug: 'atorvastatin', section: '2 Dosage', quote: 'Do not exceed 20 mg.' }],
  case_actions: [{ kind: 'case_opened', case_id: 'AE-000001', status: 'awaiting_review' }],
  steps: [{ kind: 'error', started_at: '2026-01-01T00:00:00Z', duration_ms: 1, message: 'example step' }],
};

// --- The client under test ------------------------------------------------------------------------

export const CLIENT_START = '2026-03-01T09:00:00.000Z';

export type ClientOptions = {
  agents: AgentConfig[];
  caseReviewUrl: string;
  webRoot: string;
  agentTimeoutMs?: number;
  dbPath?: string;
};

export type RunningClient = { url: string; store: InquiryStore };

export async function startClient(t: TestContext, options: ClientOptions): Promise<RunningClient> {
  const now = steppingClock(CLIENT_START);
  const store = new InquiryStore(options.dbPath ?? ':memory:', now);
  const server = createClientServer({
    config: { dbPath: options.dbPath ?? ':memory:', caseReviewUrl: options.caseReviewUrl, agents: options.agents, webRoot: options.webRoot },
    store,
    now,
    newId: sequentialIds('id'),
    agentTimeoutMs: options.agentTimeoutMs ?? 5_000,
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
    store.close();
  });
  return { url, store };
}
