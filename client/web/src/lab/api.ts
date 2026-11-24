// Everything the lab explorer asks the client's server for, under /lab/api, as hooks. No sign-in: these
// routes are answered to anyone on this machine. Nothing here asks for /api or the session.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AgentList,
  LabInquiryResponse,
  LabRunRequest,
  LabRunResponse,
  SampleList,
  SystemStatus,
  TraceList,
  TraceResponse,
} from '../../../shared/api.ts';

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
  return ask<Result>(path, { headers: { accept: 'application/json' } });
}

function post<Result>(path: string, payload: unknown): Promise<Result> {
  return ask<Result>(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function ask<Result>(path: string, init: RequestInit): Promise<Result> {
  let response: Response;
  try {
    response = await fetch(path, init);
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

// One inquiry with every run of it, asked for again while any of them is still going.
export function useLabInquiry(inquiryId: string) {
  return useQuery({
    queryKey: ['lab', 'inquiry', inquiryId],
    queryFn: () => get<LabInquiryResponse>(`/lab/api/inquiries/${encodeURIComponent(inquiryId)}`),
    refetchInterval: (query) =>
      query.state.data?.inquiry.runs.some((run) => run.state === 'running') === true ? RUN_REFRESH_MS : false,
  });
}

// A message to run: a new one, by who sent it and what it says, or one the server already received.
export type LabMessage = { sender: string; text: string } | { inquiry_id: string };

// Some of the runs asked for were started and a later one was refused: says which started, and where the
// first one is, so nothing that did start is hidden behind the failure.
export class PartlyStarted extends Error {
  readonly first: LabRunResponse;

  constructor(first: LabRunResponse, message: string) {
    super(message);
    this.first = first;
  }
}

// Runs the message through each agent in turn, as the lab explorer. The first agent gets the message as
// given; every other one gets the message the first run made, by its inquiry, so all the runs are runs of one
// inquiry. Answers the first run. A refusal of the first stops everything; a refusal of a later one stops the
// rest and is thrown as PartlyStarted.
async function runThrough(agentIds: readonly string[], message: LabMessage): Promise<LabRunResponse> {
  const [firstAgent, ...others] = agentIds;
  if (firstAgent === undefined) {
    throw new LabFailure(0, 'no_agent', 'No agent was chosen to run the message through.');
  }
  const first = await post<LabRunResponse>('/lab/api/runs', { agent_id: firstAgent, ...message } satisfies LabRunRequest);
  const started = [firstAgent];
  for (const agentId of others) {
    try {
      await post<LabRunResponse>('/lab/api/runs', {
        agent_id: agentId,
        inquiry_id: first.inquiry_id,
      } satisfies LabRunRequest);
    } catch (error) {
      const notStarted = others.slice(others.indexOf(agentId));
      throw new PartlyStarted(
        first,
        `Started ${started.join(', ')}. ${agentId} was refused: ${failureText(error)} Not started: ${notStarted.join(', ')}.`,
      );
    }
    started.push(agentId);
  }
  return first;
}

export function useRunThrough() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentIds, message }: { agentIds: readonly string[]; message: LabMessage }) =>
      runThrough(agentIds, message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['lab', 'runs'] });
      void queryClient.invalidateQueries({ queryKey: ['lab', 'inquiry'] });
    },
  });
}
