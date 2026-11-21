// The client's own API: what the React app asks the client's server for, under /api.
// Types only, so the same file is read by the server (Node) and the app (browser).

import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { ReviewDecision } from '../../shared/case-contract.ts';

export type { InvocationResponse, Step, Citation, CaseAction } from '../../shared/agent-contract.ts';
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

// GET /api/status
export type PieceState = 'up' | 'down' | 'not_built';
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

// GET /api/agents
export type AgentInfo = { id: string; name: string; description: string };
export type AgentList = { agents: AgentInfo[] };

// GET /api/samples
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

// GET /api/session: who is signed in. Holds no token of any kind.
export type SessionUser = { name: string; username: string; roles: string[]; is_reviewer: boolean };
export type SessionView = { user: SessionUser };

// POST /auth/logout: where to send the browser to end the session at the identity provider too.
export type SignOutResponse = { sign_out_url: string };

// POST /api/cases/<id>/review from the app. The server adds the reviewer: the signed-in user's name.
export type ReviewDecisionRequest = { decision: ReviewDecision; note?: string };

// One attempt by one agent to handle an inquiry.
export type RunState = 'running' | 'completed' | 'failed';
export type Run = {
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
  response: InvocationResponse | null;
};

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

// GET /api/inquiries: newest first.
export type InquiryList = { inquiries: InquirySummary[]; truncated: boolean };

// POST /api/inquiries: receives a new message and starts one run. Answers 202 with the inquiry.
export type NewInquiryRequest = { sender: string; text: string; agent_id: string };
export type InquiryResponse = { inquiry: Inquiry };

// POST /api/inquiries/<id>/runs: sends the same message, unchanged, to an agent again. Answers 202.
export type NewRunRequest = { agent_id: string };
export type RunResponse = { run: Run };
