// Everything the lab explorer asks the client's server for, under /lab/api, as hooks. No sign-in: these
// routes are answered to anyone on this machine. Nothing here asks for /api or the session.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AgentList,
  EvaluationList,
  EvaluationRunResponse,
  KnowledgeResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  LabInquiryResponse,
  LabRunRequest,
  LabRunResponse,
  RunSpansResponse,
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

// The server's answer and its body, parsed as JSON (null when it is empty or not JSON).
async function send(path: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
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
  return { response, body };
}

function refusal(path: string, response: Response, body: unknown): LabFailure {
  const code = textField(body, 'error') ?? `http_${response.status}`;
  const detail = textField(body, 'detail') ?? `The server answered ${path} with status ${response.status}.`;
  return new LabFailure(response.status, code, detail);
}

async function ask<Result>(path: string, init: RequestInit): Promise<Result> {
  const { response, body } = await send(path, init);
  if (!response.ok) {
    throw refusal(path, response, body);
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

// How long after a run finished its spans are still asked for: the client exports its root span within a second or so
// of the run's end, and the other pieces' spans come on their own schedule.
export const EVIDENCE_GRACE_MS = 30_000;

// Whether evidence read at `readAt` (milliseconds) was read within EVIDENCE_GRACE_MS of the run's end, when what
// was exported may not all have reached the trace store yet.
export function readWhileSettling(readAt: number, finishedAt: string | null): boolean {
  const finished = finishedAt === null ? Number.NaN : Date.parse(finishedAt);
  return readAt - finished < EVIDENCE_GRACE_MS;
}

// The spans the trace store holds for a run, asked for again while the run is running and for EVIDENCE_GRACE_MS after
// it finished.
export function useLabRunSpans(runId: string, running: boolean, finishedAt: string | null) {
  return useQuery({
    queryKey: ['lab', 'run', runId, 'spans'],
    queryFn: () => get<RunSpansResponse>(`/lab/api/runs/${encodeURIComponent(runId)}/spans`),
    refetchInterval: (query) => {
      if (running) return RUN_REFRESH_MS;
      const settling = query.state.data?.evidence !== 'not_configured' && readWhileSettling(query.state.dataUpdatedAt, finishedAt);
      return settling ? RUN_REFRESH_MS : false;
    },
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

// What the label index holds. Asked for once; "Read again" on the page asks again.
export function useLabKnowledge() {
  return useQuery({
    queryKey: ['lab', 'knowledge'],
    queryFn: () => get<KnowledgeResponse>('/lab/api/knowledge'),
  });
}

const SEARCH_PATH = '/lab/api/knowledge/search';

// A label search. A failure of the token or the retrieval service is answered 502 with the calls made before it, so
// that answer is returned like a 200 one; any other refusal (a field the server would not take, a setting not set) is
// thrown.
async function searchLabels(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
  const { response, body } = await send(SEARCH_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const outcome = textField(body, 'outcome');
  if ((response.status === 200 && (outcome === 'found' || outcome === 'no_label')) || (response.status === 502 && outcome === 'failed')) {
    return body as KnowledgeSearchResponse;
  }
  throw refusal(SEARCH_PATH, response, body);
}

export function useLabelSearch() {
  return useMutation({ mutationFn: searchLabels });
}

// The evaluation runs found in the harness's data folder.
export function useLabEvaluation() {
  return useQuery({
    queryKey: ['lab', 'evaluation'],
    queryFn: () => get<EvaluationList>('/lab/api/evaluation'),
  });
}

// One evaluation run's figures, by the id the list gave.
export function useLabEvaluationRun(runId: string | null) {
  return useQuery({
    queryKey: ['lab', 'evaluation', runId],
    queryFn: () => get<EvaluationRunResponse>(`/lab/api/evaluation/${encodeURIComponent(runId ?? '')}`),
    enabled: runId !== null,
  });
}
