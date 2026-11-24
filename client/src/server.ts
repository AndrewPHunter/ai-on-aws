// The client's server. Under /auth it signs desk staff in and out through the identity provider. Under
// /api, for a signed-in user only, it receives inquiries, sends them to agents, keeps every inquiry and
// run in the desk's shared inbox, forwards case review to the case system and reports the state of each
// piece. On /api a run's steps are given only by the trace routes, to a session granted traces:read; every
// other /api route strips them. What a session may do comes from the scopes granted at sign-in, and every
// call to an agent or the case system carries a token got for that target alone.
//
// Two routes have nobody signed in, and call agents with a token got by client credentials as their own
// client: POST /contact/api/messages, where a clinician writes in and the message goes to the orchestrator,
// and, under /lab/api, the lab explorer, which reads what the status, agent, sample and trace routes give,
// reads an inquiry with its runs' steps, runs a message through any agent, reads what the label index holds, and
// runs a label search through the retrieval service, reads the evaluation harness's runs, and reads the spans the trace
// store holds for a run. The server is published on its own machine only. /ping and the built web app need no session.
//
// Every run is recorded as spans of its own trace as it goes (startRun), whatever route starts it.
//
// Tokens stay here: the browser holds only a session cookie.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import type { InvocationRequest } from '../../shared/agent-contract.ts';
import { AttributeRefused } from '../../shared/telemetry.ts';
import type { Outcome, SpanAttributes, Telemetry } from '../../shared/telemetry.ts';
import type {
  AgentList,
  ApiError,
  ContactMessageResponse,
  EvaluationList,
  EvaluationRunResponse,
  Inquiry,
  InquiryList,
  InquiryResponse,
  KnowledgeResponse,
  KnowledgeSearchResponse,
  LabInquiryResponse,
  LabRunResponse,
  PieceStatus,
  Run,
  RunResponse,
  RunSpansResponse,
  SampleList,
  SessionMay,
  SessionView,
  SignOutResponse,
  SystemStatus,
  TraceList,
  TraceResponse,
  TracedRun,
} from '../shared/api.ts';
import { invokeAgent, isTimeout, ping, pingAgent, seconds } from './agents.ts';
import type { PingResult } from './agents.ts';
import { getCase, listCases, postReview } from './cases.ts';
import type { Forwarded } from './cases.ts';
import { HEALTH_SETTINGS } from './config.ts';
import type { AgentConfig, Config, HealthChecked, MachineClient } from './config.ts';
import { readRunSpans } from './evidence.ts';
import type { TraceStore } from './evidence.ts';
import { IdentityUnreachable, SignInRefused } from './identity.ts';
import type { IdentityProvider, MachineTokenResult } from './identity.ts';
import { findRuns, runFigures, runList } from './evaluation.ts';
import { LABELS_SCOPE, MAX_MEDICINE_LENGTH, MAX_QUESTION_LENGTH, labelSearch, readLabelIndex } from './knowledge.ts';
import type { KnowledgeServices } from './knowledge.ts';
import { SAMPLES } from './samples.ts';
import type { Session, SessionStore } from './sessions.ts';
import type { Actor, InquiryStore, StoredInquiry } from './store.ts';
import { tokenFor } from './tokens.ts';

export type ClientDeps = {
  config: Config;
  store: InquiryStore;
  // The clock records are stamped with and tokens' remaining life is read by. Sessions and the identity
  // provider have their own.
  now: () => Date;
  newId: () => string;
  identity: IdentityProvider;
  sessions: SessionStore;
  // A token for a machine client, as itself, for one scope, by client credentials (IdentityProvider.clientCredentials
  // in the running server). Never throws: a failure comes back with its reason.
  machineToken: (client: MachineClient, scope: string) => Promise<MachineTokenResult>;
  // The search engine the lab explorer reads the label index from, and the retrieval service it searches; each null
  // when its setting is not set.
  knowledge: KnowledgeServices;
  // Records the spans of every run (agents.ts makes the call's). Off, a working no-op, when TELEMETRY_ENDPOINT is
  // not set.
  telemetry: Telemetry;
  // The trace store the lab explorer reads a run's spans from; null when TELEMETRY_STORE_URL is not set.
  traceStore: TraceStore | null;
};

// The agent a run is sent to and the token it is sent with, or why it is not sent.
type Access = { outcome: 'call'; agent: AgentConfig; token: string } | { outcome: 'failed'; reason: string };

// The spans a run is recorded under (README, "Execution evidence"). agent.invoke is made in agents.ts.
export const RUN_SPAN = 'desk.run';
export const ACCEPTED_SPAN = 'desk.run.accepted';

// Who enters an inquiry and starts a run when nobody is signed in: the machine client, by its client id.
export const MACHINE_ACTORS: Record<MachineClient, Actor> = {
  'contact-form': { sub: 'contact-form', name: 'Contact form' },
  'lab-explorer': { sub: 'lab-explorer', name: 'Lab explorer' },
};

// The subject whose inquiries and runs the desk's /api inquiry routes leave out: the lab explorer's. The trace routes
// and /lab/api give everything.
const DESK_LEAVES_OUT = MACHINE_ACTORS['lab-explorer'].sub;

// The agent a message from the contact form is handed to.
export const ORCHESTRATOR_ID = 'orchestrator';
// The most characters each of the contact form's name, role and contact may hold.
export const MAX_CONTACT_FIELD_LENGTH = 200;

// How long a user's access token must still live when it is sent to the case system: a margin over its
// 10-second timeout. A token sent to an agent must outlive the wait for that agent (agentWaitMs).
export const CASE_TOKEN_MIN_LIFE_MS = 30_000;

// How long the client waits for an agent's answer, and so how long the token sent to it must still live.
function agentWaitMs(agent: AgentConfig): number {
  return agent.wait_seconds * 1000;
}

// The case system's review server's two scopes: reading cases, and deciding one.
export const CASES_READ = 'cases:read';
export const CASES_REVIEW = 'cases:review';
// Reading a run's steps, on the trace routes.
export const TRACES_READ = 'traces:read';
export const SESSION_COOKIE = 'desk_session';

export const MAX_TEXT_LENGTH = 10_000;
export const PING_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const NO_AGENT: PieceStatus = {
  id: 'agents',
  name: 'Agents',
  role: 'Handle inquiries: answer from the label and open adverse event cases.',
  state: 'not_configured',
  detail: 'No agent is configured.',
};

// The pieces the status checks by their health route alone, after the ones above, in this order. Each is sent no
// key or token: the client is never given the model servers' key, and their /health needs none.
const HEALTH_PIECES: readonly { id: HealthChecked; name: string; role: string; check: (url: string, timeoutMs: number) => Promise<PingResult> }[] = [
  {
    id: 'retrieval',
    name: 'Retrieval service',
    role: 'Finds a label and searches its passages for the label expert.',
    check: (url, timeoutMs) => answersHealth(`${url}/ping`, timeoutMs),
  },
  { id: 'search', name: 'Search engine', role: 'Holds the index of label passages.', check: clusterHealth },
  {
    id: 'model-chat',
    name: 'Chat model',
    role: 'The model every agent asks.',
    check: (url, timeoutMs) => answersHealth(`${url}/health`, timeoutMs),
  },
  {
    id: 'model-embedding',
    name: 'Embedding model',
    role: 'Turns a question into a vector for the search.',
    check: (url, timeoutMs) => answersHealth(`${url}/health`, timeoutMs),
  },
  {
    id: 'model-reranker',
    name: 'Reranker',
    role: 'Puts the passages found in order.',
    check: (url, timeoutMs) => answersHealth(`${url}/health`, timeoutMs),
  },
  {
    id: 'trace-store',
    name: 'Trace store',
    role: 'Keeps the spans each piece exports as it works.',
    check: (url, timeoutMs) => answersHealth(`${url}/ping`, timeoutMs),
  },
];

type HealthAnswer = { outcome: 'answered'; status: number; body: string } | { outcome: 'down'; reason: string };

// A health check whose reason never holds the address: the model servers are a machine on the local network, and
// fetch names the address in the cause of a failed connection. Only the cause's error code is kept. The body is read
// under the same time limit as the answer.
async function healthAnswer(target: string, timeoutMs: number): Promise<HealthAnswer> {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    return { outcome: 'answered', status: response.status, body: await response.text() };
  } catch (error) {
    if (isTimeout(error)) {
      return { outcome: 'down', reason: `It did not answer the health check within ${seconds(timeoutMs)}.` };
    }
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
    return { outcome: 'down', reason: code === undefined ? 'Could not reach it.' : `Could not reach it (${code}).` };
  }
}

function notAnswered(status: number): PingResult {
  return { outcome: 'down', reason: `It answered the health check with status ${status}.` };
}

// Up when the health route answers 2xx.
async function answersHealth(target: string, timeoutMs: number): Promise<PingResult> {
  const answer = await healthAnswer(target, timeoutMs);
  if (answer.outcome === 'down') return answer;
  return answer.status >= 200 && answer.status <= 299 ? { outcome: 'up' } : notAnswered(answer.status);
}

// The search engine is up when /_cluster/health answers 2xx with a cluster status of green or yellow.
async function clusterHealth(url: string, timeoutMs: number): Promise<PingResult> {
  const answer = await healthAnswer(`${url}/_cluster/health`, timeoutMs);
  if (answer.outcome === 'down') return answer;
  if (answer.status < 200 || answer.status > 299) return notAnswered(answer.status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { outcome: 'down', reason: 'Its health check answer is not JSON.' };
  }
  const cluster = typeof parsed === 'object' && parsed !== null && 'status' in parsed ? parsed.status : undefined;
  if (cluster === 'green' || cluster === 'yellow') return { outcome: 'up' };
  if (cluster === 'red') return { outcome: 'down', reason: "The cluster's status is red." };
  return { outcome: 'down', reason: 'Its health check answer has no cluster status of green, yellow or red.' };
}

// A failure the caller caused or can act on, answered with its status and an ApiError body.
class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function badRequest(detail: string): ApiFailure {
  return new ApiFailure(400, 'bad_request', detail);
}

function notSignedIn(detail: string): ApiFailure {
  return new ApiFailure(401, 'not_signed_in', detail);
}

function notAllowed(detail: string): ApiFailure {
  return new ApiFailure(403, 'not_allowed', detail);
}

// An inquiry a session may not read is answered exactly as one that does not exist.
function inquiryNotFound(): ApiFailure {
  return new ApiFailure(404, 'inquiry_not_found', 'There is no inquiry with that id.');
}

function unknownAgent(id: string): ApiFailure {
  return new ApiFailure(400, 'unknown_agent', `No agent with the id "${id}" is configured.`);
}

// A run as it leaves the server on every /api route but the trace routes: the agent's response without the
// key steps.
function withoutSteps(run: TracedRun): Run {
  if (run.response === null) {
    return { ...run, response: null };
  }
  const { steps, ...result } = run.response;
  void steps;
  return { ...run, response: result };
}

function inquiryView(inquiry: StoredInquiry): Inquiry {
  return { ...inquiry, runs: inquiry.runs.map(withoutSteps) };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

// A short page for the browser, for the sign-in routes. Every piece of text is escaped.
function sendPage(response: ServerResponse, status: number, title: string, sentence: string, signInAgain: boolean): void {
  const link = signInAgain ? '<p><a href="/auth/login">Sign in again</a></p>' : '<p><a href="/">Back to the desk</a></p>';
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(sentence)}</p>${link}</body></html>`,
  );
}

function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/`;
}

const CLEARED_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// The browser that started a sign-in, named by a random value only the callback reads.
export const SIGN_IN_COOKIE = 'desk_signin';

function signInCookie(binding: string): string {
  return `${SIGN_IN_COOKIE}=${binding}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`;
}

const CLEARED_SIGN_IN_COOKIE = `${SIGN_IN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0`;

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, status: number, error: string, detail: string): void {
  const payload: ApiError = { error, detail };
  sendJson(response, status, payload);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function listener(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ApiFailure) {
        sendError(response, error.status, error.code, error.message);
        return;
      }
      console.error('Request failed:', error);
      sendError(response, 500, 'internal_error', 'The client failed while handling the request. The cause is in its log.');
    });
  };
}

// Reads the whole body even past the limit, so the caller is still sent the 400. Stopping early
// would destroy the socket and the caller would see a reset connection instead of the reason.
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('The request body is larger than 1 MB.'));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed);
      } catch {
        reject(badRequest('The request body is not JSON.'));
      }
    });
  });
}

function field(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('The request body is not a JSON object.');
  }
  const entries: Record<string, unknown> = { ...body };
  return entries[name];
}

function requiredString(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${name}" is required and must be text.`);
  }
  return value.trim();
}

// A required string of at most `limit` characters once trimmed.
function boundedString(body: unknown, name: string, limit: number): string {
  const value = requiredString(body, name);
  if (value.length > limit) {
    throw badRequest(`"${name}" is longer than ${limit} characters.`);
  }
  return value;
}

function pieceFrom(id: string, name: string, role: string, result: PingResult): PieceStatus {
  return result.outcome === 'up'
    ? { id, name, role, state: 'up', detail: 'Answered the health check.' }
    : { id, name, role, state: 'down', detail: result.reason };
}

function sendForwarded(response: ServerResponse, forwarded: Forwarded): void {
  if (forwarded.outcome === 'unreachable') {
    sendError(response, 502, 'case_system_unreachable', forwarded.reason);
    return;
  }
  sendJson(response, forwarded.status, forwarded.body);
}

// A path segment as the caller meant it. One that cannot be decoded names nothing that exists.
function segment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function createClientServer(deps: ClientDeps): Server {
  const { config, store, now, newId, identity, sessions, machineToken, knowledge, telemetry, traceStore } = deps;

  // Asked for at sign-in: each distinct agent scope configured, the case system's two and traces:read. The
  // provider leaves out any the person's role does not grant.
  const signInScopes = [...new Set(config.agents.map((agent) => agent.scope)), CASES_READ, CASES_REVIEW, TRACES_READ];

  function sessionOf(request: IncomingMessage): Session | undefined {
    const id = cookieValue(request, SESSION_COOKIE);
    return id === undefined ? undefined : sessions.get(id);
  }

  function actorOf(session: Session): Actor {
    return { sub: session.user.sub, name: session.user.name };
  }

  // Answers 403 unless the session was granted the scope at sign-in. Called before the identity provider
  // or the target is asked anything.
  function requireGranted(session: Session, scope: string): void {
    if (!session.granted.has(scope)) {
      throw notAllowed(`Your account was not granted ${scope}.`);
    }
  }

  // The access token for one target scope (tokens.ts). A refresh that fails ends the session and answers
  // 401; one whose token lacks the scope answers 403. Nothing is sent with a token that would expire on
  // the way.
  async function accessToken(session: Session, scope: string, minLifeMs: number): Promise<string> {
    const got = await tokenFor(session, scope, minLifeMs, {
      refresh: (refreshToken, asked) => identity.refresh(refreshToken, asked),
      now,
      isLive: (candidate) => sessions.get(candidate.id) === candidate,
      end: (candidate) => sessions.remove(candidate.id),
    });
    if (got.outcome === 'ended') throw notSignedIn(got.reason);
    if (got.outcome === 'not_granted') throw notAllowed(got.reason);
    return got.accessToken;
  }

  // An agent the session may run. An unknown id is 400; an agent whose scope was not granted is 403.
  function configuredAgent(id: string): AgentConfig {
    const agent = config.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
      throw unknownAgent(id);
    }
    return agent;
  }

  function runnableAgent(session: Session, id: string): AgentConfig {
    const agent = configuredAgent(id);
    requireGranted(session, agent.scope);
    return agent;
  }

  function mayRunAnAgent(session: Session): boolean {
    return config.agents.some((agent) => session.granted.has(agent.scope));
  }

  // An inquiry as the store holds it, with every run of it. Undefined is answered as an unknown inquiry.
  function storedInquiry(inquiryId: string): StoredInquiry {
    return found(store.getInquiry(inquiryId, null));
  }

  // An inquiry as the desk's /api inquiry routes give it: what the lab explorer entered or ran is not part of the
  // desk, so an inquiry it entered is answered as an unknown one and the runs it started are left out.
  function deskInquiry(inquiryId: string): StoredInquiry {
    return found(store.getInquiry(inquiryId, DESK_LEAVES_OUT));
  }

  function found(inquiry: StoredInquiry | undefined): StoredInquiry {
    if (inquiry === undefined) {
      throw inquiryNotFound();
    }
    return inquiry;
  }

  // The inbox is the desk's: an inquiry is read by a session that may run an agent or read cases. To any other
  // session it is answered as an unknown one, before the store is read.
  function readableInquiry(session: Session, inquiryId: string): StoredInquiry {
    if (!mayRunAnAgent(session) && !session.granted.has(CASES_READ)) {
      throw inquiryNotFound();
    }
    return deskInquiry(inquiryId);
  }

  // The message text, as POST /api/inquiries takes it.
  function messageText(body: unknown): string {
    return boundedString(body, 'text', MAX_TEXT_LENGTH);
  }

  function may(session: Session): SessionMay {
    return {
      agents: config.agents.filter((agent) => session.granted.has(agent.scope)).map((agent) => agent.id),
      read_cases: session.granted.has(CASES_READ),
      decide_cases: session.granted.has(CASES_REVIEW),
      read_traces: session.granted.has(TRACES_READ),
    };
  }

  // The token a machine client sends to an agent: got for that agent's scope alone, with at least the wait for that
  // agent left. Anything else is a reason the run fails with, and nothing is sent.
  async function machineAccess(client: MachineClient, agent: AgentConfig): Promise<Access> {
    const got = await machineToken(client, agent.scope);
    if (got.outcome === 'failed') {
      return { outcome: 'failed', reason: `The client ${client} could not get a token for ${agent.scope}: ${got.reason}` };
    }
    if (got.expiresAt - now().getTime() < agentWaitMs(agent)) {
      return {
        outcome: 'failed',
        reason: `The token the client ${client} got for ${agent.scope} lives less than the ${agent.wait_seconds} seconds the client waits for this agent, so it was not sent.`,
      };
    }
    return { outcome: 'call', agent, token: got.token };
  }

  // Runs in the background after the 202 has been sent: gets the token, if it is not already got, and calls the
  // agent. A run always ends: anything that throws fails it with a reason, and the cause is logged. Returns how the run
  // ended, for its root span: the agent's answer's outcome, or failed.
  async function settleRun(runId: string, request: InvocationRequest, access: () => Promise<Access>): Promise<Extract<Outcome, 'completed' | 'stopped' | 'failed'>> {
    try {
      const target = await access();
      if (target.outcome === 'failed') {
        store.failRun(runId, target.reason);
        return 'failed';
      }
      const result = await invokeAgent(telemetry, runId, target.agent.url, request, agentWaitMs(target.agent), target.token);
      if (result.outcome === 'ok') {
        store.completeRun(runId, result.response);
        return result.response.outcome;
      }
      store.failRun(runId, result.reason);
      return 'failed';
    } catch (error) {
      console.error(`Run ${runId} failed in the client:`, error);
      try {
        store.failRun(runId, 'The client failed while making this run. The cause is in its log.');
      } catch (recording) {
        console.error(`Could not record the failure of run ${runId}:`, recording);
      }
      return 'failed';
    }
  }

  function recordRun(runId: string, inquiryId: string, agentId: string, startedBy: Actor): TracedRun {
    const run = store.startRun(runId, inquiryId, agentId, startedBy);
    if (run === undefined) {
      throw inquiryNotFound();
    }
    return run;
  }

  // Records a run of the stored message by the agent `agentId` and sends it, with the id and receipt time the message
  // was given when it was received, to the agent `access` gives, carrying its token: one already got for a signed-in
  // user, or one a machine client gets once the run is recorded. Resolves once the run is recorded; the call goes on.
  //
  // The run is the root span of a new trace, desk.run, ended when the run is settled; the write that records it is its
  // child desk.run.accepted, exported while the call goes on; the call is agent.invoke (agents.ts). If telemetry refuses
  // the run's attributes before anything is recorded, the run is made without its two spans and the refusal is logged:
  // telemetry does not change what is answered or stored.
  function startRun(inquiry: StoredInquiry, agentId: string, startedBy: Actor, access: () => Promise<Access>): Promise<TracedRun> {
    const runId = newId();
    const request: InvocationRequest = {
      message: { id: inquiry.id, received_at: inquiry.received_at, sender: inquiry.sender, text: inquiry.text },
    };
    const ids: SpanAttributes = { 'lab.run.id': runId, 'lab.inquiry.id': inquiry.id, 'gen_ai.agent.id': agentId };
    return new Promise((accepted, refused) => {
      let recorded = false;
      telemetry
        .span(RUN_SPAN, { kind: 'internal', parent: null, attributes: ids }, async (root) => {
          const run = await telemetry.span(ACCEPTED_SPAN, { kind: 'internal', attributes: ids }, () => recordRun(runId, inquiry.id, agentId, startedBy));
          recorded = true;
          accepted(run);
          root.set({ 'lab.outcome': await settleRun(run.id, request, access) });
        })
        .catch((error: unknown) => {
          if (recorded) {
            console.error(`telemetry: the root span of run ${runId} could not be completed:`, error);
            return;
          }
          if (!(error instanceof AttributeRefused)) {
            refused(error);
            return;
          }
          console.error(`telemetry: run ${runId} is recorded without its spans: ${error.message}`);
          try {
            accepted(recordRun(runId, inquiry.id, agentId, startedBy));
            void settleRun(runId, request, access);
          } catch (recording) {
            refused(recording);
          }
        });
    });
  }

  // A token already got for a signed-in user, for that agent, as startRun takes it.
  function got(agent: AgentConfig, token: string): () => Promise<Access> {
    return () => Promise.resolve({ outcome: 'call', agent, token });
  }


  // What the status, agent, sample and trace routes give, called by both /api and /lab/api.
  function agentList(agents: AgentConfig[]): AgentList {
    return { agents: agents.map((agent) => ({ id: agent.id, name: agent.name, description: agent.description })) };
  }

  function sampleList(): SampleList {
    return { samples: [...SAMPLES] };
  }

  function traceOf(runId: string): TraceResponse {
    const trace = store.getTrace(runId);
    if (trace === undefined) {
      throw new ApiFailure(404, 'unknown_run', 'There is no run with that id.');
    }
    return { trace };
  }

  async function status(): Promise<SystemStatus> {
    const checkedAt = now().toISOString();
    const caseSystem = ping(`${config.caseReviewUrl}/ping`, PING_TIMEOUT_MS).then((result) =>
      pieceFrom('case-system', 'Case system', "Holds adverse event cases and records reviewers' decisions.", result),
    );
    const agents = config.agents.map((agent) =>
      pingAgent(agent.url, PING_TIMEOUT_MS).then((result) => pieceFrom(agent.id, agent.name, agent.description, result)),
    );
    const identityPiece = identity
      .check(PING_TIMEOUT_MS)
      .then((result) =>
        pieceFrom('identity', 'Identity provider', 'Signs desk staff in and issues the tokens sent to agents and the case system.', result),
      );
    const checkedByHealth = HEALTH_PIECES.map(({ id, name, role, check }): Promise<PieceStatus> => {
      const url = config.healthUrls?.[id];
      if (url === undefined) {
        return Promise.resolve({ id, name, role, state: 'not_configured', detail: `${HEALTH_SETTINGS[id]} is not set.` });
      }
      return check(url, PING_TIMEOUT_MS).then((result) => pieceFrom(id, name, role, result));
    });
    const [pinged, identityState, healthStates] = await Promise.all([
      Promise.all([caseSystem, ...agents]),
      identityPiece,
      Promise.all(checkedByHealth),
    ]);
    const noAgent = config.agents.length === 0 ? [NO_AGENT] : [];
    return { checked_at: checkedAt, pieces: [...pinged, ...noAgent, identityState, ...healthStates] };
  }

  // Every API route is given the signed-in user's session.
  type Handler = (request: IncomingMessage, response: ServerResponse, url: URL, session: Session) => Promise<void>;
  type Route = Partial<Record<'GET' | 'POST', Handler>>;

  function sessionView(session: Session): SessionView {
    const { name, username, roles } = session.user;
    return { user: { name, username, roles: [...roles] }, may: may(session) };
  }

  const routes = {
    session: {
      GET: async (_request, response, _url, session) => {
        sendJson(response, 200, sessionView(session));
      },
    },
    status: {
      GET: async (_request, response) => {
        sendJson(response, 200, await status());
      },
    },
    agents: {
      GET: async (_request, response, _url, session) => {
        sendJson(response, 200, agentList(config.agents.filter((agent) => session.granted.has(agent.scope))));
      },
    },
    samples: {
      GET: async (_request, response) => {
        sendJson(response, 200, sampleList());
      },
    },
    inquiries: {
      // Every inquiry, to a session that may run an agent; to any other, none.
      GET: async (_request, response, _url, session) => {
        const payload: InquiryList = mayRunAnAgent(session) ? store.listInquiries(DESK_LEAVES_OUT) : { inquiries: [], truncated: false };
        sendJson(response, 200, payload);
      },
      POST: async (request, response, _url, session) => {
        const body = await readJson(request);
        const sender = requiredString(body, 'sender');
        const text = messageText(body);
        const agent = runnableAgent(session, requiredString(body, 'agent_id'));
        const token = await accessToken(session, agent.scope, agentWaitMs(agent));
        const id = newId();
        store.createInquiry({ id, receivedAt: now().toISOString(), sender, text, enteredBy: actorOf(session) });
        await startRun(storedInquiry(id), agent.id, actorOf(session), got(agent, token));
        const payload: InquiryResponse = { inquiry: inquiryView(deskInquiry(id)) };
        sendJson(response, 202, payload);
      },
    },
  } satisfies Record<string, Route>;

  function inquiryRoute(inquiryId: string): Route {
    return {
      GET: async (_request, response, _url, session) => {
        const payload: InquiryResponse = { inquiry: inquiryView(readableInquiry(session, inquiryId)) };
        sendJson(response, 200, payload);
      },
    };
  }

  // On any inquiry, by a session that may run the agent named. Whether the session may run it is decided first,
  // so a session that may not is answered the same for an inquiry that exists and one that does not.
  function runsRoute(inquiryId: string): Route {
    return {
      POST: async (request, response, _url, session) => {
        const body = await readJson(request);
        const agent = runnableAgent(session, requiredString(body, 'agent_id'));
        const inquiry = deskInquiry(inquiryId);
        const token = await accessToken(session, agent.scope, agentWaitMs(agent));
        const payload: RunResponse = { run: withoutSteps(await startRun(inquiry, agent.id, actorOf(session), got(agent, token))) };
        sendJson(response, 202, payload);
      },
    };
  }

  const casesRoute: Route = {
    GET: async (_request, response, url, session) => {
      requireGranted(session, CASES_READ);
      const token = await accessToken(session, CASES_READ, CASE_TOKEN_MIN_LIFE_MS);
      sendForwarded(response, await listCases(config.caseReviewUrl, url.searchParams.get('status'), token));
    },
  };

  function caseRoute(caseId: string): Route {
    return {
      GET: async (_request, response, _url, session) => {
        requireGranted(session, CASES_READ);
        const token = await accessToken(session, CASES_READ, CASE_TOKEN_MIN_LIFE_MS);
        sendForwarded(response, await getCase(config.caseReviewUrl, caseId, token));
      },
    };
  }

  // The trace routes: every person's runs, and one run with its steps and the message it was made of. A
  // session not granted traces:read is answered 403 before the store is read.
  const tracesRoute: Route = {
    GET: async (_request, response, _url, session) => {
      requireGranted(session, TRACES_READ);
      const payload: TraceList = store.listTraces();
      sendJson(response, 200, payload);
    },
  };

  function traceRoute(runId: string): Route {
    return {
      GET: async (_request, response, _url, session) => {
        requireGranted(session, TRACES_READ);
        sendJson(response, 200, traceOf(runId));
      },
    };
  }

  // The reviewer is whoever is signed in, never a name the browser sends: the case system takes it from
  // the access token. A session not granted cases:review is stopped here, and behind this by the case
  // system.
  function reviewRoute(caseId: string): Route {
    return {
      POST: async (request, response, _url, session) => {
        requireGranted(session, CASES_REVIEW);
        const body = await readJson(request);
        if (field(body, 'reviewer') !== undefined) {
          throw badRequest('"reviewer" is set by the server to whoever is signed in. Do not send it.');
        }
        const decision = field(body, 'decision');
        const note = field(body, 'note');
        const review: Record<string, unknown> = note === undefined ? { decision } : { decision, note };
        const token = await accessToken(session, CASES_REVIEW, CASE_TOKEN_MIN_LIFE_MS);
        sendForwarded(response, await postReview(config.caseReviewUrl, caseId, review, token));
      },
    };
  }

  function apiRoute(pathname: string): Route | undefined {
    switch (pathname) {
      case '/api/session':
        return routes.session;
      case '/api/status':
        return routes.status;
      case '/api/agents':
        return routes.agents;
      case '/api/samples':
        return routes.samples;
      case '/api/inquiries':
        return routes.inquiries;
      case '/api/cases':
        return casesRoute;
      case '/api/traces':
        return tracesRoute;
    }
    const inquiry = /^\/api\/inquiries\/([^/]+)(\/runs)?$/.exec(pathname);
    const inquiryId = inquiry?.[1] === undefined ? undefined : segment(inquiry[1]);
    if (inquiry !== null && inquiryId !== undefined) {
      return inquiry[2] === undefined ? inquiryRoute(inquiryId) : runsRoute(inquiryId);
    }
    const found = /^\/api\/cases\/([^/]+)(\/review)?$/.exec(pathname);
    const caseId = found?.[1] === undefined ? undefined : segment(found[1]);
    if (found !== null && caseId !== undefined) {
      return found[2] === undefined ? caseRoute(caseId) : reviewRoute(caseId);
    }
    const trace = /^\/api\/traces\/([^/]+)$/.exec(pathname);
    const runId = trace?.[1] === undefined ? undefined : segment(trace[1]);
    if (runId !== undefined) {
      return traceRoute(runId);
    }
    return undefined;
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = sessionOf(request);
    if (session === undefined) {
      sendError(response, 401, 'not_signed_in', 'Nobody is signed in. Sign in to use the desk.');
      return;
    }
    const route = apiRoute(url.pathname);
    if (route === undefined) {
      sendError(response, 404, 'not_found', `There is no API route ${url.pathname}.`);
      return;
    }
    const handler = request.method === 'GET' ? route.GET : request.method === 'POST' ? route.POST : undefined;
    if (handler === undefined) {
      const allowed = Object.keys(route).join(', ');
      response.setHeader('allow', allowed);
      sendError(response, 405, 'method_not_allowed', `${url.pathname} accepts ${allowed}.`);
      return;
    }
    await handler(request, response, url, session);
  }

  // --- The lab explorer -------------------------------------------------------------------------------

  // The explorer's routes read no cookie. They give what the /api routes of the same names give, with no session and
  // no permission: every agent, every inquiry and every person's runs with their steps; and what the label index
  // holds, and the evaluation runs on disk. Two routes take POST: POST /lab/api/runs runs a message through any agent, and POST
  // /lab/api/knowledge/search runs a label search, each as the client lab-explorer.
  type Handled = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  type LabRoute = Partial<Record<'GET' | 'POST', Handled>>;

  // A stored inquiry sent again unchanged (inquiry_id), or a new one (sender and text), entered by the lab explorer.
  function labInquiry(body: unknown): StoredInquiry {
    const again = field(body, 'inquiry_id') !== undefined;
    const fresh = field(body, 'sender') !== undefined || field(body, 'text') !== undefined;
    if (again && fresh) {
      throw badRequest('Send "inquiry_id" to run an inquiry again, or "sender" and "text" for a new one, not both.');
    }
    if (again) {
      return storedInquiry(requiredString(body, 'inquiry_id'));
    }
    const sender = requiredString(body, 'sender');
    const text = messageText(body);
    const id = newId();
    store.createInquiry({ id, receivedAt: now().toISOString(), sender, text, enteredBy: MACHINE_ACTORS['lab-explorer'] });
    return storedInquiry(id);
  }

  const labRuns: LabRoute = {
    GET: async (_request, response) => {
      const payload: TraceList = store.listTraces();
      sendJson(response, 200, payload);
    },
    POST: async (request, response) => {
      const body = await readJson(request);
      const agent = configuredAgent(requiredString(body, 'agent_id'));
      const inquiry = labInquiry(body);
      const run = await startRun(inquiry, agent.id, MACHINE_ACTORS['lab-explorer'], () => machineAccess('lab-explorer', agent));
      const payload: LabRunResponse = { inquiry_id: inquiry.id, run_id: run.id };
      sendJson(response, 202, payload);
    },
  };

  function notConfigured(setting: string, what: string): ApiFailure {
    return new ApiFailure(503, 'not_configured', `${setting} is not set, so ${what}.`);
  }

  // What the label index holds, from the search engine. A failure of the engine is 502 with its reason.
  const labKnowledge: LabRoute = {
    GET: async (_request, response) => {
      if (knowledge.engine === null) throw notConfigured('SEARCH_URL', 'the label index cannot be read');
      const read = await readLabelIndex(knowledge.engine);
      if (!read.ok) {
        sendError(response, 502, read.code, read.detail);
        return;
      }
      const payload: KnowledgeResponse = { checked_at: now().toISOString(), index: read.index };
      sendJson(response, 200, payload);
    },
  };

  // A label search, as the client lab-explorer with a token for labels:search alone. A token that cannot be got is 502
  // and nothing is sent; so is any failure of the retrieval service (knowledge.ts). Nothing is retried.
  const labKnowledgeSearch: LabRoute = {
    POST: async (request, response) => {
      const body = await readJson(request);
      const medicine = boundedString(body, 'medicine', MAX_MEDICINE_LENGTH);
      const question = boundedString(body, 'question', MAX_QUESTION_LENGTH);
      if (knowledge.retrieval === null) throw notConfigured('RETRIEVAL_URL', 'no label search can be made');
      const got = await machineToken('lab-explorer', LABELS_SCOPE);
      if (got.outcome === 'failed') {
        const failed: KnowledgeSearchResponse = {
          outcome: 'failed',
          calls: [],
          error: 'token_failed',
          detail: `The client lab-explorer could not get a token for ${LABELS_SCOPE}: ${got.reason}`,
        };
        sendJson(response, 502, failed);
        return;
      }
      const result = await labelSearch(knowledge.retrieval, got.token, medicine, question, now);
      sendJson(response, result.status, result.body);
    },
  };

  // The evaluation runs on disk, read-only. A run is named by an id found on disk; any other is 404.
  const labEvaluation: LabRoute = {
    GET: async (_request, response) => {
      const payload: EvaluationList = runList(await findRuns(config.evaluationDataDir));
      sendJson(response, 200, payload);
    },
  };

  function labEvaluationRun(runId: string): LabRoute {
    return {
      GET: async (_request, response) => {
        const run = (await findRuns(config.evaluationDataDir)).runs.find((candidate) => candidate.id === runId);
        if (run === undefined) throw new ApiFailure(404, 'unknown_evaluation_run', 'There is no evaluation run with that id in the data folder.');
        const payload: EvaluationRunResponse = runFigures(run);
        sendJson(response, 200, payload);
      },
    };
  }

  // The spans the trace store holds for a run (evidence.ts). An unknown run is 404 before the store is asked; a store
  // that does not answer, or answers in another form, is 502 with a reason that holds no address.
  function labRunSpans(runId: string): LabRoute {
    return {
      GET: async (_request, response) => {
        if (store.getRun(runId) === undefined) {
          throw new ApiFailure(404, 'unknown_run', 'There is no run with that id.');
        }
        if (traceStore === null) {
          const payload: RunSpansResponse = { evidence: 'not_configured', spans: [] };
          sendJson(response, 200, payload);
          return;
        }
        const read = await readRunSpans(traceStore, runId);
        if (!read.ok) {
          sendError(response, 502, read.code, read.detail);
          return;
        }
        sendJson(response, 200, read.answer);
      },
    };
  }

  function labRoute(pathname: string): LabRoute | undefined {
    switch (pathname) {
      case '/lab/api/status':
        return { GET: async (_request, response) => sendJson(response, 200, await status()) };
      case '/lab/api/agents':
        return { GET: async (_request, response) => sendJson(response, 200, agentList(config.agents)) };
      case '/lab/api/samples':
        return { GET: async (_request, response) => sendJson(response, 200, sampleList()) };
      case '/lab/api/runs':
        return labRuns;
      case '/lab/api/knowledge':
        return labKnowledge;
      case '/lab/api/knowledge/search':
        return labKnowledgeSearch;
      case '/lab/api/evaluation':
        return labEvaluation;
    }
    const evaluationRun = /^\/lab\/api\/evaluation\/([^/]+)$/.exec(pathname);
    const evaluationId = evaluationRun?.[1] === undefined ? undefined : segment(evaluationRun[1]);
    if (evaluationId !== undefined) {
      return labEvaluationRun(evaluationId);
    }
    const spans = /^\/lab\/api\/runs\/([^/]+)\/spans$/.exec(pathname);
    const spansOf = spans?.[1] === undefined ? undefined : segment(spans[1]);
    if (spansOf !== undefined) {
      return labRunSpans(spansOf);
    }
    const run = /^\/lab\/api\/runs\/([^/]+)$/.exec(pathname);
    const runId = run?.[1] === undefined ? undefined : segment(run[1]);
    if (runId !== undefined) {
      return { GET: async (_request, response) => sendJson(response, 200, traceOf(runId)) };
    }
    const inquiry = /^\/lab\/api\/inquiries\/([^/]+)$/.exec(pathname);
    const inquiryId = inquiry?.[1] === undefined ? undefined : segment(inquiry[1]);
    if (inquiryId !== undefined) {
      return {
        GET: async (_request, response) => {
          const payload: LabInquiryResponse = { inquiry: storedInquiry(inquiryId) };
          sendJson(response, 200, payload);
        },
      };
    }
    return undefined;
  }

  async function handleLab(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const route = labRoute(url.pathname);
    if (route === undefined) {
      sendError(response, 404, 'not_found', `There is no lab API route ${url.pathname}.`);
      return;
    }
    const handler = request.method === 'GET' ? route.GET : request.method === 'POST' ? route.POST : undefined;
    if (handler === undefined) {
      const allowed = Object.keys(route).join(', ');
      response.setHeader('allow', allowed);
      sendError(response, 405, 'method_not_allowed', `${url.pathname} accepts ${allowed}.`);
      return;
    }
    await handler(request, response);
  }

  // --- The contact form -------------------------------------------------------------------------------

  // A clinician writes in, with nobody signed in. The message is stored, entered by the contact form, with a run of
  // the orchestrator recorded, and the sender is answered 202 with when it was received and nothing else. The run
  // gets its token as the client contact-form after the answer; one that cannot be got, or no orchestrator
  // configured, fails the run with the reason, where the desk sees it.
  async function contactMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const name = boundedString(body, 'name', MAX_CONTACT_FIELD_LENGTH);
    const role = boundedString(body, 'role', MAX_CONTACT_FIELD_LENGTH);
    const contact = boundedString(body, 'contact', MAX_CONTACT_FIELD_LENGTH);
    const text = messageText(body);
    const actor = MACHINE_ACTORS['contact-form'];
    const id = newId();
    const receivedAt = now().toISOString();
    store.createInquiry({ id, receivedAt, sender: `${name}, ${role}, ${contact}`, text, enteredBy: actor });
    const orchestrator = config.agents.find((agent) => agent.id === ORCHESTRATOR_ID);
    const noOrchestrator = `No agent with the id "${ORCHESTRATOR_ID}" is configured, so the message was handed to none.`;
    await startRun(storedInquiry(id), ORCHESTRATOR_ID, actor, () =>
      orchestrator === undefined ? Promise.resolve({ outcome: 'failed', reason: noOrchestrator }) : machineAccess('contact-form', orchestrator),
    );
    const payload: ContactMessageResponse = { received_at: receivedAt };
    sendJson(response, 202, payload);
  }

  async function handleContact(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname !== '/contact/api/messages') {
      sendError(response, 404, 'not_found', `There is no contact API route ${url.pathname}.`);
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendError(response, 405, 'method_not_allowed', `${url.pathname} accepts POST.`);
      return;
    }
    await contactMessage(request, response);
  }

  // --- Signing in and out ---------------------------------------------------------------------------

  function sendUnreachablePage(response: ServerResponse, error: IdentityUnreachable): void {
    sendPage(
      response,
      502,
      error.issuerMismatch ? 'The identity provider is not the one expected' : 'The identity provider cannot be reached',
      `identity_unreachable: ${error.message}`,
      false,
    );
  }

  async function login(response: ServerResponse): Promise<void> {
    const { pending, binding } = sessions.beginSignIn();
    let target: string;
    try {
      target = await identity.authorizationUrl(pending, signInScopes);
    } catch (error) {
      // A provider that cannot be reached leaves no sign-in waiting.
      sessions.dropPending(pending.state);
      if (error instanceof IdentityUnreachable) {
        sendUnreachablePage(response, error);
        return;
      }
      throw error;
    }
    response.writeHead(302, { location: target, 'set-cookie': signInCookie(binding), 'cache-control': 'no-store' });
    response.end();
  }

  // The sign-in cookie is cleared whatever the answer. A callback without it, or with another sign-in's,
  // gets the same answer as an unknown state: only the browser that started a sign-in can complete it.
  async function callback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.setHeader('set-cookie', CLEARED_SIGN_IN_COOKIE);
    const state = url.searchParams.get('state');
    const pending = state === null ? undefined : sessions.takePending(state, cookieValue(request, SIGN_IN_COOKIE));
    const providerError = url.searchParams.get('error');
    if (providerError !== null) {
      sendPage(response, 400, 'Sign-in did not complete', `The identity provider answered with the error ${providerError}.`, true);
      return;
    }
    if (pending === undefined) {
      sendPage(response, 400, 'This sign-in is not valid', 'The sign-in was not valid or has expired.', true);
      return;
    }
    let signedIn: Awaited<ReturnType<IdentityProvider['completeSignIn']>>;
    try {
      signedIn = await identity.completeSignIn(url.searchParams, pending);
    } catch (error) {
      if (error instanceof IdentityUnreachable) {
        sendUnreachablePage(response, error);
        return;
      }
      if (error instanceof SignInRefused) {
        sendPage(response, 502, 'Sign-in could not be completed', error.message, true);
        return;
      }
      throw error;
    }
    const session = sessions.create(signedIn);
    response.writeHead(302, {
      location: '/',
      'set-cookie': [sessionCookie(session.id), CLEARED_SIGN_IN_COOKIE],
      'cache-control': 'no-store',
    });
    response.end();
  }

  async function logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = sessionOf(request);
    if (session === undefined) {
      sendError(response, 401, 'not_signed_in', 'Nobody is signed in.');
      return;
    }
    sessions.remove(session.id);
    response.setHeader('set-cookie', CLEARED_COOKIE);
    // The refresh token is revoked at the provider, so it cannot be used again. If that fails the local
    // session is still gone; the failure is logged and the browser is still sent to sign out there.
    if (session.refreshToken !== null) {
      const revoked = await identity.revoke(session.refreshToken);
      if (revoked.outcome === 'failed') {
        console.error(`Sign-out: revoking the refresh token at the identity provider failed: ${revoked.reason}`);
      }
    }
    let signOutUrl: string;
    try {
      signOutUrl = await identity.signOutUrl();
    } catch (error) {
      if (error instanceof IdentityUnreachable) {
        sendError(response, 502, 'identity_unreachable', error.message);
        return;
      }
      throw error;
    }
    const payload: SignOutResponse = { sign_out_url: signOutUrl };
    sendJson(response, 200, payload);
  }

  async function handleAuth(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? '';
    if (url.pathname === '/auth/login' && method === 'GET') return login(response);
    if (url.pathname === '/auth/callback' && method === 'GET') return callback(request, response, url);
    if (url.pathname === '/auth/logout' && method === 'POST') return logout(request, response);
    sendText(response, 404, 'Not found.');
  }

  const webRoot = resolve(config.webRoot);

  async function isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  // Where under the web root a URL path points.
  // A path that resolves outside the root names nothing, and does not fall back to the app.
  function fileFor(pathname: string): { inside: true; path: string } | { inside: false } {
    const decoded = segment(pathname);
    if (decoded === undefined || decoded.includes('\0')) {
      return { inside: false };
    }
    const path = resolve(webRoot, `.${decoded}`);
    if (path !== webRoot && !path.startsWith(webRoot + sep)) {
      return { inside: false };
    }
    return { inside: true, path };
  }

  async function sendFile(response: ServerResponse, path: string, headOnly: boolean, cacheControl: string | undefined): Promise<void> {
    const content = await readFile(path);
    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(content.length),
    };
    if (cacheControl !== undefined) {
      headers['cache-control'] = cacheControl;
    }
    response.writeHead(200, headers);
    response.end(headOnly ? undefined : content);
  }

  async function handleWeb(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendText(response, 405, 'Method not allowed.');
      return;
    }
    const headOnly = request.method === 'HEAD';
    const target = fileFor(url.pathname);
    if (!target.inside) {
      sendText(response, 404, 'Not found.');
      return;
    }
    const index = resolve(webRoot, 'index.html');
    if (target.path !== index && (await isFile(target.path))) {
      const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : undefined;
      await sendFile(response, target.path, headOnly, cache);
      return;
    }
    // The app does its own routing, so any other path is the app's page.
    if (!(await isFile(index))) {
      sendText(response, 503, 'The web app has not been built.');
      return;
    }
    await sendFile(response, index, headOnly, 'no-cache');
  }

  return createServer(
    listener(async (request, response) => {
      // URL parsing collapses literal ".." segments but leaves encoded ones; fileFor decodes the path
      // and checks the result against the web root, so neither form can leave it.
      const url = new URL(request.url ?? '/', 'http://client');
      // A POST sent by a page on another site, which the browser would send with the session cookie.
      const origin = request.headers.origin;
      if (request.method === 'POST' && origin !== undefined && origin !== config.appOrigin) {
        sendError(response, 403, 'cross_site_request', 'This request came from another site and was refused.');
        return;
      }
      if (url.pathname === '/ping') {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET');
          sendError(response, 405, 'method_not_allowed', '/ping accepts GET.');
          return;
        }
        sendJson(response, 200, { status: 'Healthy' });
        return;
      }
      if (url.pathname.startsWith('/auth/')) {
        await handleAuth(request, response, url);
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if (url.pathname === '/lab/api' || url.pathname.startsWith('/lab/api/')) {
        await handleLab(request, response, url);
        return;
      }
      if (url.pathname === '/contact/api' || url.pathname.startsWith('/contact/api/')) {
        await handleContact(request, response, url);
        return;
      }
      await handleWeb(request, response, url);
    }),
  );
}
