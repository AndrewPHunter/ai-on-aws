// The client's own API: what the React app asks the client's server for, under /api, and under /lab/api for the lab explorer.
// Types only, so the same file is read by the server (Node) and the app (browser).

import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { ReviewDecision } from '../../shared/case-contract.ts';

export type { InvocationResponse, Step, Citation, CaseAction, LabelAnswer } from '../../shared/agent-contract.ts';
export type {
  AuditView,
  CaseRecord,
  CaseStatus,
  CaseView,
  ElementName,
  FoundCases,
  ReviewDecision,
  ReviewRequest,
  VersionView,
} from '../../shared/case-contract.ts';

// A failed request answers with this and a 4xx or 5xx status. `detail` is a sentence for a person.
// Errors passed through from the case system may carry only `error`.
export type ApiError = { error: string; detail?: string };

// GET /api/status, and GET /lab/api/status with no session
export type PieceState = 'up' | 'down' | 'not_configured';
export type PieceStatus = {
  id: string;
  name: string;
  // What the piece is for, in a sentence.
  role: string;
  state: PieceState;
  // Why it is in that state, for example the error from reaching it.
  detail: string;
};
export type SystemStatus = { checked_at: string; pieces: PieceStatus[] };

// GET /api/agents (the agents the session may run), and GET /lab/api/agents (every agent) with no session
export type AgentInfo = { id: string; name: string; description: string };
export type AgentList = { agents: AgentInfo[] };

// GET /api/samples, and GET /lab/api/samples with no session
export type SampleInquiry = {
  id: string;
  title: string;
  sender: string;
  text: string;
  // What sending it is meant to show.
  shows: string;
};
export type SampleList = { samples: SampleInquiry[] };

// The member of staff who entered an inquiry or started a run, as the identity provider named them.
// Null for rows written before staff signed in.
export type Author = { name: string };

// GET /api/session: who is signed in, and what the scopes granted at sign-in let them do: the ids of the
// agents they may run, whether they may read cases, whether they may decide one, whether they may read traces.
// Holds no token of any kind.
export type SessionUser = { name: string; username: string; roles: string[] };
export type SessionMay = { agents: string[]; read_cases: boolean; decide_cases: boolean; read_traces: boolean };
export type SessionView = { user: SessionUser; may: SessionMay };

// POST /auth/logout: where to send the browser to end the session at the identity provider too.
export type SignOutResponse = { sign_out_url: string };

// POST /api/cases/<id>/review from the app. Nobody names the reviewer: the client's server forwards this
// with the signed-in user's access token, and the case system takes the reviewer from the token.
export type ReviewDecisionRequest = { decision: ReviewDecision; note?: string };

// One attempt by one agent to handle an inquiry.
export type RunState = 'running' | 'completed' | 'failed';

// What the agent returned, without its steps: how a run's result is given on every /api route but the trace routes.
export type RunResult = Omit<InvocationResponse, 'steps'>;

type RunOf<Result> = {
  id: string;
  inquiry_id: string;
  agent_id: string;
  state: RunState;
  started_at: string;
  started_by: Author | null;
  finished_at: string | null;
  duration_ms: number | null;
  // Why the run failed: the agent could not be reached, timed out, or answered outside the contract.
  error: string | null;
  // What the agent returned. Present only when the run completed.
  response: Result | null;
};

// A run as every /api route but the trace routes gives it: the agent's response without its steps.
export type Run = RunOf<RunResult>;
// A run with the agent's whole response, steps included: given only on the trace routes and on
// GET /lab/api/runs/<run_id>.
export type TracedRun = RunOf<InvocationResponse>;

export type RunSummary = {
  id: string;
  agent_id: string;
  state: RunState;
  case_ids: string[];
};

// An inquiry is one inbound message and every run made of it.
export type Inquiry = {
  id: string;
  received_at: string;
  entered_by: Author | null;
  sender: string;
  text: string;
  runs: Run[];
};

export type InquirySummary = {
  id: string;
  received_at: string;
  sender: string;
  text: string;
  runs: RunSummary[];
};

// GET /api/inquiries: the ones the reader entered, newest first.
export type InquiryList = { inquiries: InquirySummary[]; truncated: boolean };

// POST /api/inquiries: receives a new message and starts one run. Answers 202 with the inquiry.
export type NewInquiryRequest = { sender: string; text: string; agent_id: string };
export type InquiryResponse = { inquiry: Inquiry };

// POST /api/inquiries/<id>/runs: sends the same message, unchanged, to an agent again. Answers 202.
export type NewRunRequest = { agent_id: string };
export type RunResponse = { run: Run };

// GET /api/traces: every person's runs, newest first, to a session granted traces:read. GET /lab/api/runs
// gives the same with no session.
export type TraceSummary = {
  run_id: string;
  inquiry_id: string;
  agent_id: string;
  state: RunState;
  started_at: string;
  started_by: Author | null;
  duration_ms: number | null;
  // The agent's outcome, or null when it did not answer.
  outcome: InvocationResponse['outcome'] | null;
};
export type TraceList = { traces: TraceSummary[]; truncated: boolean };

// GET /api/traces/<run_id>: the message as it was received, and the run with its steps. GET
// /lab/api/runs/<run_id> gives the same with no session.
export type TraceInquiry = Omit<Inquiry, 'runs'>;
export type Trace = { inquiry: TraceInquiry; run: TracedRun };
export type TraceResponse = { trace: Trace };
