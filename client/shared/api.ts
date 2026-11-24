// The client's own API: what the React app asks the client's server for, under /api, under /lab/api for the lab
// explorer, and under /contact/api for the contact form.
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

// The member of staff who entered an inquiry or started a run, as the identity provider named them, or
// "Contact form" or "Lab explorer" for the two clients nobody signs in to. Null for rows written before staff
// signed in.
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
// A run with the agent's whole response, steps included: given only on the trace routes, on
// GET /lab/api/runs/<run_id> and on GET /lab/api/inquiries/<id>.
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

// GET /api/inquiries: the desk's inbox, every inquiry, newest first, to a session that may run an agent; empty to
// any other.
export type InquiryList = { inquiries: InquirySummary[]; truncated: boolean };

// POST /api/inquiries: receives a new message and starts one run. Answers 202 with the inquiry. GET
// /api/inquiries/<id> answers 200 with the same, to a session that may run an agent or read cases.
export type NewInquiryRequest = { sender: string; text: string; agent_id: string };
export type InquiryResponse = { inquiry: Inquiry };

// POST /api/inquiries/<id>/runs: sends the same message, unchanged, to an agent again, on any inquiry, by a session
// that may run that agent. Answers 202.
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

// POST /contact/api/messages: a clinician writes in through the public form. Nobody is signed in. Each of name,
// role and contact is at most 200 characters, and text at most what POST /api/inquiries takes. The message becomes
// an inquiry in the desk's inbox, entered by "Contact form", and is handled by the orchestrator. Answers 202; the
// sender is told only when it was received.
export type ContactMessageRequest = { name: string; role: string; contact: string; text: string };
export type ContactMessageResponse = { received_at: string };

// GET /lab/api/inquiries/<id>: one inquiry with every run of it, steps included, for the lab explorer.
export type LabInquiry = TraceInquiry & { runs: TracedRun[] };
export type LabInquiryResponse = { inquiry: LabInquiry };

// POST /lab/api/runs: the lab explorer runs a message through an agent, as its own client. Either a message
// already received (`inquiry_id`), sent again unchanged, or a new one (`sender` and `text`), entered by "Lab
// explorer"; a body with both is 400. Answers 202; the run is started by "Lab explorer".
export type LabRunRequest = { agent_id: string } & ({ inquiry_id: string } | { sender: string; text: string });
export type LabRunResponse = { inquiry_id: string; run_id: string };

// GET /lab/api/knowledge: what the label index holds, as the search engine reports it for the alias the retrieval
// service searches. `embedding` is the identity the index's mapping records, or null for an index built without
// vectors.
export type EmbeddingIdentity = { repository: string; revision: string; dimensions: number; recipe: string };
export type LabelIndex =
  | { state: 'built'; alias: string; index: string; passages: number; embedding: EmbeddingIdentity | null }
  | { state: 'not_built'; alias: string; detail: string };
export type KnowledgeResponse = { checked_at: string; index: LabelIndex };

// POST /lab/api/knowledge/search: a label search as the label expert makes one, find the label and then search it,
// run as the lab explorer's own client. Each field is required: medicine at most 200 characters, question at most
// 1,000.
export type KnowledgeSearchRequest = { medicine: string; question: string };

export type KnowledgeTool = 'find_labels' | 'search_label';
// One call made to the retrieval service: what was sent and how long it took, in milliseconds.
export type KnowledgeCall = { tool: KnowledgeTool; sent: Record<string, string>; duration_ms: number };

// A label as find_labels lists it.
export type FoundLabel = {
  set_id: string;
  version: number;
  effective_date: string;
  kind: string;
  names: string[];
  source: string;
};

// The passage's rank, from 1, in each list the service's strategy computed and that it is in; otherwise null.
export type PassageRanks = { keyword: number | null; vector: number | null; fused: number | null; reranked: number | null };

// A passage as search_label returns it, in the order returned (rank 1 first).
export type FoundPassage = {
  rank: number;
  chunk_id: string;
  text: string;
  score: number;
  part: string;
  section: { number: string | null; title: string | null; path: string[] };
  label: { set_id: string; version: number; effective_date: string; source: string };
  ranks: PassageRanks | null;
};

// 200: `found` (the labels found, the one searched, the strategy the service reports and the passages), or
// `no_label` with find_labels's own answer. 502: `failed`, with the error's code and sentence and the calls made
// before it.
export type KnowledgeSearchResponse =
  | { outcome: 'found'; calls: KnowledgeCall[]; labels: FoundLabel[]; searched: FoundLabel; strategy: string; passages: FoundPassage[] }
  | { outcome: 'no_label'; calls: KnowledgeCall[]; answer: unknown }
  | { outcome: 'failed'; calls: KnowledgeCall[]; error: string; detail: string };

// GET /lab/api/evaluation: the evaluation runs found in the harness's data folder, newest first by the time their
// file was last written. `data` is `not_configured` when the setting is not set, `empty` when the folder holds no run.
// `skipped` names each file that was found but could not be read, and why, in words that quote nothing of it.
export type EvaluationKind = 'benchmark' | 'attack';
export type EvaluationRunSummary = { id: string; kind: EvaluationKind; name: string; written_at: string };
export type EvaluationSkipped = { file: string; reason: string };
export type EvaluationList = { data: 'not_configured' | 'empty' | 'found'; runs: EvaluationRunSummary[]; skipped: EvaluationSkipped[] };

// A share as scores.json holds it: numerator of denominator, the share and its 95% Wilson interval, and whether it is
// over too few items to read.
export type EvaluationShare = { numerator: number; denominator: number; share: number | null; low: number | null; high: number | null; too_few: boolean };

// One line of a benchmark run's figures, under the name the harness's own table gives it.
export type EvaluationRow = { name: string } & (
  | { kind: 'share'; share: EvaluationShare }
  | { kind: 'count'; count: number }
  | { kind: 'effort'; count: number; median: number | null; p95: number | null }
  | { kind: 'fraction'; value: number | null }
  | { kind: 'not_judged' }
);
export type EvaluationGroup = { name: string; rows: EvaluationRow[] };

// What run.json says was run: the agent, the models and strategies its responses named, and when. Null when the run
// has no run.json this server can read.
export type BenchmarkRunFacts = { agent_id: string | null; models: string[]; strategies: string[]; started_at: string; ended_at: string | null };

// One attack, control or fault case of an attack run: identifiers and its verdict only. `failed` lists the kinds of
// the expectations that did not hold.
export type AttackVerdict = 'held' | 'failed' | 'inconclusive' | 'not_run';
export type AttackCaseResult = {
  id: string;
  class: string;
  target: string;
  decided_by: 'code' | 'model';
  verdict: AttackVerdict;
  failed: { kind: string; scope: string | null; decided_by: 'code' | 'model' }[];
};

// GET /lab/api/evaluation/<id>: one run's figures. 404 for an id that names no run found on disk.
export type EvaluationRunResponse =
  | { kind: 'benchmark'; id: string; name: string; written_at: string; run: BenchmarkRunFacts | null; variant: string; groups: EvaluationGroup[] }
  | { kind: 'attack'; id: string; name: string; written_at: string; cases: AttackCaseResult[]; totals: Record<AttackVerdict, number> };
