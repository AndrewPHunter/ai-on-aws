// Everything the lab explorer asks the client's server for, under /lab/api, as hooks. No sign-in: these
// routes are answered to anyone on this machine. Nothing here asks for /api or the session.

import { useQuery } from '@tanstack/react-query';

import type { AgentList, SampleList, SystemStatus, TraceList, TraceResponse } from '../../../shared/api.ts';

// A request that did not give what was asked for: the server answered with an error, or could not be reached
// (status 0).
export class LabFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function textField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(body, name);
  return typeof value === 'string' ? value : undefined;
}

async function get<Result>(path: string): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new LabFailure(
      0,
      'unreachable',
      'The client’s server did not answer. Check that the lab is running with docker compose up, then reload.',
    );
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = textField(body, 'error') ?? `http_${response.status}`;
    const detail = textField(body, 'detail') ?? `The server answered ${path} with status ${response.status}.`;
    throw new LabFailure(response.status, code, detail);
  }
  if (body === null) {
    throw new LabFailure(response.status, 'not_json', `The server answered ${path} with something that is not JSON.`);
  }
  return body as Result;
}

export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong, and the browser gave no reason.';
}

// Every key starts with 'lab', so nothing here shares a cache entry with the desk app's queries.
export function useLabStatus() {
  return useQuery({
    queryKey: ['lab', 'status'],
    queryFn: () => get<SystemStatus>('/lab/api/status'),
    refetchInterval: 10_000,
  });
}

export function useLabAgents() {
  return useQuery({
    queryKey: ['lab', 'agents'],
    queryFn: () => get<AgentList>('/lab/api/agents'),
  });
}

export function useLabSamples() {
  return useQuery({
    queryKey: ['lab', 'samples'],
    queryFn: () => get<SampleList>('/lab/api/samples'),
  });
}

export function useLabRuns() {
  return useQuery({
    queryKey: ['lab', 'runs'],
    queryFn: () => get<TraceList>('/lab/api/runs'),
    // While a run is still going, ask again so its result appears without a reload.
    refetchInterval: (query) => (query.state.data?.traces.some((trace) => trace.state === 'running') ? 5000 : false),
  });
}

export const RUN_REFRESH_MS = 2000;

export function useLabRun(runId: string) {
  return useQuery({
    queryKey: ['lab', 'run', runId],
    queryFn: () => get<TraceResponse>(`/lab/api/runs/${encodeURIComponent(runId)}`),
    refetchInterval: (query) => (query.state.data?.trace.run.state === 'running' ? RUN_REFRESH_MS : false),
  });
}
