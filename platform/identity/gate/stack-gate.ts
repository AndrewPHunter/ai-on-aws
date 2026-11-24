// Gate for the whole stack (platform/identity/README.md, "The stack gate").
//
// Answers one question: on a running stack, do the realm, the agents, the tool servers and the client agree?
// No test runs one piece against another, so a mismatch between two of them is caught here or nowhere. It runs
// on the stack's network and is the browser, a stranger and a token holder at once. In order:
//   1. knocks on each of the four agents, both case-system servers and the retrieval service without a token;
//   2. signs each of the four people in through the client and Keycloak's own sign-in page, and checks the
//      cookies, the refused callbacks, what /api/session says each may do, whether it says they may read traces,
//      and a cross-site POST;
//   3. asks the client, as each person, for something they may not do (403 not_allowed) and for something they may;
//   4. sends an inquiry to each intake agent as dana.desk and a question to the label expert as morgan.medinfo,
//      and follows each run to its end: the run read back by its person holds no steps, and its trace, read as
//      avery.auditor, gives the steps; through the agent's exchange to its tool server, and, where the run
//      reached it, to the audit entry of the case it opened or the retrieval service's answer; then sends
//      dana.desk's inquiry holding both a report and a label question to the orchestrator, and follows that run,
//      from its trace, through its delegations to the intake agent on Strands and the label expert, and on to
//      their tool servers;
//   5. asks the client for traces: both trace routes are 403 to dana.desk, morgan.medinfo and riley.reviewer;
//      to avery.auditor the list holds the runs made in step 4 and a run's trace holds steps;
//   6. asks the client, as morgan.medinfo and riley.reviewer, for the inquiry dana.desk entered, and to start a run
//      of the label expert on it: both read it, morgan.medinfo's run is accepted, riley.reviewer's refused;
//   7. gets tokens of its own from the provider, as the identity gate does (../src/provider.ts), and presents
//      each to a service, which must accept it or refuse it for the stated reason;
//   8. signs each person out.
//
// It changes the stack it is run against: it enters four inquiries, all from the sender "Dr Gate,
// gate@example.org", and up to three cases may be opened from them: one by each intake agent from its inquiry,
// and one by the intake agent on Strands from the orchestrator's (each an adverse event about the invented
// medicine "examplamab"). It also starts a run of the label expert, which writes nothing, on the first of those
// inquiries, as morgan.medinfo, and does not wait for it. Run it on a stack whose data may hold them.
//
// A run may end at the model on a stack with no model server, or the model may open no case. The statements
// that need what such a run did not reach are then neither held nor failed: they go in the report's
// not_checked list, each with the reason, and standard error says so too.
//
// Like gate.ts, it stands in for the browser from inside the network, so URLs on the browser's addresses
// (http://localhost:3000 for the client, http://localhost:8090 for the provider) are sent to the services'
// names instead, with the same path and query. The requests it makes as a signed-in person through the client
// are in ../src/desk.ts; the statements about their answers are made here.
//
// Usage: node stack-gate.ts   (the four people's passwords and the client secrets read in main must be set)
// Every statement is checked even after one fails. Exit codes: 0 every statement holds, 1 one does not,
// 2 the gate could not run. The JSON report goes to standard output, progress to standard error. Neither
// carries a password, code, secret or token.

import { randomBytes, randomUUID } from 'node:crypto';

import type { CaseRecord } from '../../../shared/case-contract.ts';
import {
  openCallback,
  openLogin,
  readCase,
  readCaseList,
  readInquiry,
  readTrace,
  readTraceList,
  sendAgain,
  sendInquiry,
  signInAtProvider,
  signOut as signOutOfClient,
  toTransport,
  waitForRun,
  type DeskAddresses,
  type Jar,
  type Reply,
  type ResponseView,
  type RunView,
  type StepView,
} from '../src/desk.ts';
import { checkSignInPage, checkSignInRedirect, checkTokenAnswer, type Body } from '../src/judge.ts';
import { codeChallengeS256, codeVerifier } from '../src/pkce.ts';
import {
  authorizationUrl,
  clientCredentials,
  CookieJar,
  exchange,
  exchangeCode,
  openSignInPage,
  postSignInForm,
  refresh,
  type Answer,
  type Http,
} from '../src/provider.ts';

const CLIENT = 'http://client:3000';
const IDENTITY = 'http://identity:8080';
const TOKEN_ENDPOINT = { token_endpoint: `${IDENTITY}/realms/lab/protocol/openid-connect/token` };
const INTAKE_AGENTS = ['intake-handwritten', 'intake-strands'] as const;
const EXPERT = 'expert';
const ORCHESTRATOR = 'orchestrator';
// The intake agent the orchestrator screens every message with.
const SCREENER = 'intake-strands';
const AGENTS = [...INTAKE_AGENTS, EXPERT, ORCHESTRATOR] as const;
const agentUrl = (agent: string): string => `http://${agent}:8080`;
const CASE_MCP = 'http://case-system:8000';
const CASE_REVIEW = 'http://case-system:8001';
const KNOWLEDGE = 'http://knowledge:8000';
const BROWSER_APP = 'http://localhost:3000';
const BROWSER_IDENTITY = 'http://localhost:8090';
const END_SESSION = `${BROWSER_IDENTITY}/realms/lab/protocol/openid-connect/logout`;
const AUTHORIZE = `${BROWSER_IDENTITY}/realms/lab/protocol/openid-connect/auth`;
const DESK = { clientId: 'desk', redirectUri: `${BROWSER_APP}/auth/callback` };
const ADDRESSES: DeskAddresses = { client: CLIENT, identity: IDENTITY, browserClient: BROWSER_APP, browserIdentity: BROWSER_IDENTITY };
const DESK_SCOPES = 'openid agents:intake agents:expert agents:orchestrator cases:read cases:review';
const NO_SUCH_CASE = 'AE-999999';
const HTTP: Http = { timeoutMs: 20_000 };
const RUN_WAIT_MS = 90_000;
// The client waits up to 295 s for the orchestrator, so the gate waits a little longer for its run.
const ORCHESTRATOR_RUN_WAIT_MS = 300_000;
// The reasons an agent gives for a run that stopped at a token: its tool server refused the token or could not
// check it, the tool server could not be reached, or the exchange for the tool server's token failed. A run that
// stopped for one of these did not show its token was accepted where it was sent. These must match the agents'
// own sentences: agents/src/tools/mcp-answers.ts (serviceSentences, for "case system" and "retrieval service"),
// matched exactly, and agents/src/tools/tool-token.ts (toolToken), whose reason for a failed exchange starts with
// a fixed sentence and goes on with the provider's words, matched by its start.
const TOKEN_STOP_REASONS = [
  "The case system refused the agent's token.",
  "The case system could not check the agent's token.",
  'The case system could not be reached.',
  "The retrieval service refused the agent's token.",
  "The retrieval service could not check the agent's token.",
  'The retrieval service could not be reached.',
];
const EXCHANGE_FAILED_PREFIXES = ['The agent could not get a token for the case system: ', 'The agent could not get a token for the retrieval service: '];
const stoppedAtToken = (reason: string | null): boolean =>
  reason !== null && (TOKEN_STOP_REASONS.includes(reason) || EXCHANGE_FAILED_PREFIXES.some((prefix) => reason.startsWith(prefix)));
// How the orchestrator's delegation failure starts when its exchange for a sub-agent's token failed: the fixed
// start of toolToken's reason in agents/src/tools/tool-token.ts, followed there by the sub-agent's name, which
// is matched by this start only.
const DELEGATION_EXCHANGE_FAILED_PREFIX = 'The agent could not get a token for ';
const exchangeFailed = (failure: string | null | undefined): boolean => typeof failure === 'string' && failure.startsWith(DELEGATION_EXCHANGE_FAILED_PREFIX);
// What a JWT looks like: a base64url header that starts {"
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\./;

class UsageError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new UsageError(`missing required environment variable ${name}`);
  return value;
}

// ---------- the report ----------

const held: string[] = [];
const failed: string[] = [];
const notChecked: string[] = [];

function statement(ok: boolean, what: string, detail = ''): boolean {
  if (ok) {
    held.push(what);
    process.stderr.write(`stack-gate: holds: ${what}\n`);
  } else {
    const line = detail === '' ? what : `${what}: ${detail}`;
    failed.push(line);
    process.stderr.write(`stack-gate: does not hold: ${line}\n`);
  }
  return ok;
}

/** A statement that cannot be made on this stack, and why. Neither held nor failed. */
function notCheckable(what: string, why: string): void {
  const line = `${what}: ${why}`;
  notChecked.push(line);
  process.stderr.write(`stack-gate: not checked: ${line}\n`);
}

// ---------- HTTP ----------

function get(url: string, cookie = '', headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    redirect: 'manual',
    headers: cookie === '' ? headers : { ...headers, cookie },
    signal: AbortSignal.timeout(HTTP.timeoutMs),
  });
}

function post(url: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: 'POST', redirect: 'manual', headers, body, signal: AbortSignal.timeout(HTTP.timeoutMs) });
}

/** A POST to the client from its own page, as the signed-in person, for a request ../src/desk.ts does not make. */
function postAs(session: string, path: string, body: unknown): Promise<Response> {
  return post(`${CLIENT}${path}`, JSON.stringify(body), { 'content-type': 'application/json', cookie: session, origin: BROWSER_APP });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const MCP_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

/** An MCP request to `base`/mcp, with a bearer token or none. */
function mcpRequest(base: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return post(`${base}/mcp`, MCP_LIST, headers);
}

const MESSAGE = JSON.stringify({ message: { id: 'stack-gate-1', received_at: '2026-01-01T00:00:00.000Z', sender: 'gate@example.org', text: 'hello' } });
// JSON outside the contract: an agent that accepts the token answers it 400 and runs nothing
// (docs/architecture/agent-runtime.md, "Where the two servers differ").
const OUTSIDE_CONTRACT = JSON.stringify({ nonsense: true });

// ---------- the people ----------

type May = { agents: string[]; read_cases: boolean; decide_cases: boolean; read_traces: boolean };
type Person = { username: string; name: string; password: string; may: May };

/** The client sessions of the people who signed in, by username. */
type Sessions = Map<string, string>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/** The person's session, or a failed statement saying why `what` was not checked. */
function sessionFor(sessions: Sessions, who: string, what: string): string | undefined {
  const session = sessions.get(who);
  if (session === undefined) statement(false, what, `${who} did not sign in, so this was not checked`);
  return session;
}

// /auth/login, Keycloak's page, the password, and back to the callback, which is returned unrequested.
async function startSignIn(person: Person, record: boolean): Promise<{ app: Jar; callback: string } | undefined> {
  const who = person.username;
  const login = await openLogin(HTTP, ADDRESSES);
  const app = login.cookies;
  const target = login.location ?? '';
  if (record) {
    const query = target.startsWith(AUTHORIZE) ? new URL(target).searchParams : new URLSearchParams();
    statement(
      login.status === 302 &&
        target.startsWith(AUTHORIZE) &&
        query.get('response_type') === 'code' &&
        query.get('client_id') === DESK.clientId &&
        query.get('redirect_uri') === DESK.redirectUri &&
        (query.get('scope') ?? '').split(' ').includes('openid') &&
        (query.get('state') ?? '') !== '' &&
        (query.get('nonce') ?? '') !== '' &&
        (query.get('code_challenge') ?? '') !== '' &&
        query.get('code_challenge_method') === 'S256',
      `${who}: /auth/login redirects to the provider with the code flow, the client, the redirect URI, openid, a state, a nonce and an S256 challenge`,
      `status ${login.status}`,
    );
    statement(
      app.has('desk_signin') && app.attributes.get('desk_signin') === 'HttpOnly; Max-Age=600; Path=/auth; SameSite=Lax',
      `${who}: /auth/login sets the sign-in cookie HttpOnly, SameSite=Lax, Path=/auth, Max-Age=600`,
      app.attributes.get('desk_signin') ?? 'not set',
    );
  }
  if (!target.startsWith(AUTHORIZE)) return undefined;
  const submitted = await signInAtProvider(HTTP, ADDRESSES, target, who, person.password);
  if (!submitted.shown) {
    statement(false, `${who}: Keycloak shows its sign-in page`, submitted.detail);
    return undefined;
  }
  const callback = submitted.location ?? '';
  const accepted = submitted.status === 302 && callback.startsWith(`${DESK.redirectUri}?`);
  if (record) {
    statement(accepted, `${who}: Keycloak's own page accepts the password and redirects to the callback`, `status ${submitted.status}`);
  }
  return accepted ? { app, callback } : undefined;
}

const describeMay = (may: May): string =>
  `run ${may.agents.length === 0 ? 'no agent' : may.agents.join(' and ')}, ${may.read_cases ? 'may' : 'may not'} read cases and ${may.decide_cases ? 'may' : 'may not'} decide them`;

/** Signs the person in through the client and states what the sign-in and the session promise. Returns the session cookie. */
async function signInStatements(person: Person): Promise<string | undefined> {
  const who = person.username;
  const started = await startSignIn(person, true);
  if (started === undefined) {
    statement(false, `${who}: signed in`, 'the sign-in did not reach the callback; the statements that need this session were not checked');
    return undefined;
  }
  const { app, callback } = started;
  const signInCookie = app.header('desk_signin');
  const completed = await openCallback(HTTP, ADDRESSES, callback, signInCookie);
  app.take(completed.setCookies);
  statement(
    completed.status === 302 &&
      completed.location === '/' &&
      app.has('desk_session') &&
      app.attributes.get('desk_session') === 'HttpOnly; Path=/; SameSite=Lax' &&
      !app.has('desk_signin'),
    `${who}: the callback creates a session, sets the session cookie HttpOnly, SameSite=Lax, Path=/, and clears the sign-in cookie`,
    `status ${completed.status}, session cookie ${app.attributes.get('desk_session') ?? 'not set'}, sign-in cookie ${app.has('desk_signin') ? 'still set' : 'cleared'}`,
  );
  const session = app.header('desk_session');

  const replay = await openCallback(HTTP, ADDRESSES, callback, signInCookie);
  statement(replay.status === 400, `${who}: the same callback used again is 400`, `status ${replay.status}`);

  const fresh = await startSignIn(person, false);
  if (fresh === undefined) {
    statement(false, `${who}: a callback without the sign-in cookie is 400 and sets no session`, 'a second sign-in did not reach the callback');
  } else {
    const bare = await openCallback(HTTP, ADDRESSES, fresh.callback);
    const setsSession = bare.setCookies.some((line) => line.startsWith('desk_session=') && !/max-age=0\b/i.test(line));
    statement(bare.status === 400 && !setsSession, `${who}: a callback without the sign-in cookie is 400 and sets no session`, `status ${bare.status}`);
  }

  const view = await get(`${CLIENT}/api/session`, session);
  const viewText = await view.text();
  let viewed: { user?: { username?: unknown; name?: unknown }; may?: { agents?: unknown; read_cases?: unknown; decide_cases?: unknown; read_traces?: unknown } } = {};
  try {
    viewed = JSON.parse(viewText) as typeof viewed;
  } catch {
    viewed = {};
  }
  const agents = viewed.may?.agents;
  statement(
    view.status === 200 &&
      viewed.user?.username === who &&
      viewed.user.name === person.name &&
      Array.isArray(agents) &&
      agents.every((agent) => typeof agent === 'string') &&
      sameSet(agents as string[], person.may.agents) &&
      viewed.may?.read_cases === person.may.read_cases &&
      viewed.may.decide_cases === person.may.decide_cases,
    `${who}: /api/session names ${person.name} and says they may ${describeMay(person.may)}`,
    `status ${view.status}, ${JSON.stringify({ username: viewed.user?.username, name: viewed.user?.name, may: viewed.may ?? null })}`,
  );
  statement(
    view.status === 200 && viewed.may?.read_traces === person.may.read_traces,
    `${who}: /api/session says they ${person.may.read_traces ? 'may' : 'may not'} read traces`,
    `status ${view.status}, read_traces ${JSON.stringify(viewed.may?.read_traces ?? null)}`,
  );
  // The list's shape is AgentList in client/shared/api.ts: { agents: [{ id, name, description }] }.
  const listed = await jsonOf(await get(`${CLIENT}/api/agents`, session));
  const ids = Array.isArray(listed.agents) ? (listed.agents as { id?: unknown }[]).map((agent) => agent.id) : null;
  statement(
    ids !== null && ids.every((id) => typeof id === 'string') && sameSet(ids as string[], person.may.agents),
    `${who}: /api/agents lists exactly the agents /api/session says they may run (${person.may.agents.length === 0 ? 'none' : person.may.agents.join(' and ')})`,
    `listed ${JSON.stringify(ids)}`,
  );
  statement(!JWT_PATTERN.test(viewText), `${who}: /api/session carries no token`);

  const status = await jsonOf(await get(`${CLIENT}/api/status`, session));
  const pieces = Array.isArray(status.pieces) ? (status.pieces as Record<string, unknown>[]) : [];
  const identity = pieces.find((piece) => piece.id === 'identity');
  statement(identity?.state === 'up', `${who}: /api/status lists the identity provider as up`, JSON.stringify(identity ?? null));

  // Sent to an agent the person may run, where there is one, so that only the origin can be why it is refused.
  const foreign = await post(`${CLIENT}/api/inquiries`, JSON.stringify({ sender: 'x', text: 'x', agent_id: person.may.agents[0] ?? INTAKE_AGENTS[0] }), {
    'content-type': 'application/json',
    cookie: session,
    origin: 'http://elsewhere.example.org',
  });
  const foreignBody = await jsonOf(foreign);
  statement(
    foreign.status === 403 && foreignBody.error === 'cross_site_request',
    `${who}: a POST from another origin is 403 cross_site_request`,
    `status ${foreign.status}, ${String(foreignBody.error)}`,
  );
  return session;
}

async function signOutStatements(person: Person, sessions: Sessions): Promise<void> {
  const who = person.username;
  const what = `${who}: sign-out answers with the provider's end-session address, carrying no token`;
  const session = sessionFor(sessions, who, what);
  if (session === undefined) return;
  const out = await signOutOfClient(HTTP, ADDRESSES, session);
  const outText = out.text;
  let signOut: URL | undefined;
  try {
    const parsed = JSON.parse(outText) as { sign_out_url?: string };
    signOut = parsed.sign_out_url === undefined ? undefined : new URL(parsed.sign_out_url);
  } catch {
    signOut = undefined;
  }
  statement(
    out.status === 200 &&
      signOut !== undefined &&
      `${signOut.origin}${signOut.pathname}` === END_SESSION &&
      !signOut.searchParams.has('id_token_hint') &&
      !JWT_PATTERN.test(outText),
    what,
    `status ${out.status}, parameters ${signOut === undefined ? 'none' : [...signOut.searchParams.keys()].join(',')}`,
  );
  const after = await get(`${CLIENT}/api/session`, session);
  await after.arrayBuffer();
  statement(after.status === 401, `${who}: after sign-out the same cookie is 401`, `status ${after.status}`);
}

// ---------- what each person may and may not do, through the client ----------

async function refusedStatement(
  sessions: Sessions,
  who: string,
  what: string,
  send: (session: string) => Promise<Pick<Reply, 'status' | 'body'>>,
): Promise<void> {
  const full = `${who}: ${what} is 403 not_allowed`;
  const session = sessionFor(sessions, who, full);
  if (session === undefined) return;
  const answer = await send(session);
  const body = answer.body;
  statement(answer.status === 403 && body.error === 'not_allowed', full, `status ${answer.status}, ${String(body.error)}`);
}

async function permissionStatements(sessions: Sessions): Promise<void> {
  const inquiry = (agent: string) => (session: string) =>
    sendInquiry(HTTP, ADDRESSES, session, { sender: 'Dr Gate, gate@example.org', text: 'What is the usual starting dose?', agent_id: agent });
  const caseList = (session: string) => readCaseList(HTTP, ADDRESSES, session);
  const decide = async (session: string) => {
    const answer = await postAs(session, `/api/cases/${NO_SUCH_CASE}/review`, { decision: 'approve' });
    return { status: answer.status, body: await jsonOf(answer) };
  };

  await refusedStatement(sessions, 'dana.desk', `sending an inquiry to ${EXPERT}`, inquiry(EXPERT));
  await refusedStatement(sessions, 'dana.desk', 'reading the case list', caseList);
  await refusedStatement(sessions, 'riley.reviewer', `sending an inquiry to ${INTAKE_AGENTS[0]}`, inquiry(INTAKE_AGENTS[0]));
  await refusedStatement(sessions, 'riley.reviewer', `sending an inquiry to ${ORCHESTRATOR}`, inquiry(ORCHESTRATOR));
  await refusedStatement(sessions, 'avery.auditor', 'deciding a case', decide);
  await refusedStatement(sessions, 'morgan.medinfo', 'reading the case list', caseList);

  for (const who of ['riley.reviewer', 'avery.auditor']) {
    const what = `${who}: reading the case list is 200`;
    const session = sessionFor(sessions, who, what);
    if (session === undefined) continue;
    const answer = await caseList(session);
    statement(answer.status === 200, what, `status ${answer.status}`);
  }

  const what = `riley.reviewer: deciding a case that does not exist gets the case system's own answer, 404 case_not_found, so the token and its scope were accepted there`;
  const session = sessionFor(sessions, 'riley.reviewer', what);
  if (session !== undefined) {
    const answer = await decide(session);
    const body = answer.body;
    statement(answer.status === 404 && body.error === 'case_not_found', what, `status ${answer.status}, ${String(body.error)}`);
  }
}

// ---------- runs, to the end ----------

// What the runs are sent. All invented: no real medicine, patient or label. Each intake report carries the four
// things a case needs (a patient, the reporter with a contact, which is the sender, the suspect drug and the
// event), with a different patient per agent so the two are not taken for one case. The expert's question names
// the medicine, so the expert looks for its label.
const SENDER = 'Dr Gate, gate@example.org';
const INTAKE_REPORTS: Record<(typeof INTAKE_AGENTS)[number], string> = {
  'intake-handwritten':
    'I am reporting an adverse event. My patient, J.K., a 54-year-old man, started examplamab 10 mg once daily and ' +
    'developed a widespread itchy rash a week later. I can be reached at gate@example.org.',
  'intake-strands':
    'I am reporting an adverse event. My patient, M.R., a 67-year-old woman, started examplamab 20 mg once daily and ' +
    'had severe dizziness with a fall three days later. I can be reached at gate@example.org.',
};
const EXPERT_QUESTION = 'What does the examplamab label say about the usual starting dose for adults?';
// Both halves in one message, for the orchestrator: a report with the four things a case needs, about a third
// patient, and a label question about the same medicine that holds no number at all.
const ORCHESTRATOR_INQUIRY =
  'I am reporting an adverse event and have a question. My patient, S.T., a 38-year-old woman, started examplamab ' +
  '10 mg once daily and developed swelling of the lips and tongue two days later. I can be reached at gate@example.org. ' +
  'Separately, what does the examplamab label say about the usual starting dose for adults?';
// The retrieval service's tools. A tool step of one of these that is not an error is recorded only after the
// service answered the call with a result of the expected shape (agents/src/expert/strands.ts, recordCall); a
// call the agent refused or could not make is always recorded as an error.
const RETRIEVAL_TOOLS = ['find_labels', 'search_label'];

// A run as the gate reads it is RunView in ../src/desk.ts. Read back by the person who started it, it has no
// steps; its trace, read as avery.auditor, has the agent's whole response, where a delegation step carries the
// sub-agent's whole response.
/** A run's trace as avery.auditor read it: the agent's response from it, or why it could not be read. */
type Traced = { ok: true; response: ResponseView | null | undefined } | { ok: false; why: string };
/** An inquiry the gate sent, its run as the person read it back, and that run's trace (undefined when no run was read back). */
type Sent = { inquiryId: string; run: RunView | undefined; trace: Traced | undefined };

/** Reads the run's trace as avery.auditor. */
async function traceOf(sessions: Sessions, run: RunView): Promise<Traced> {
  const session = sessions.get('avery.auditor');
  if (session === undefined) return { ok: false, why: "avery.auditor did not sign in, so the run's trace was not read" };
  if (run.id === undefined) return { ok: false, why: 'the run was read back without an id, so its trace was not read' };
  const answer = await readTrace(HTTP, ADDRESSES, session, run.id);
  const trace = answer.body.trace as { run?: RunView } | undefined;
  if (answer.status !== 200 || trace?.run?.id !== run.id) {
    return { ok: false, why: `avery.auditor's read of the run's trace answered status ${answer.status}${answer.status === 200 ? ' without a trace of that run' : ''}` };
  }
  return { ok: true, response: trace.run.response };
}

/** The response in the run's trace, when it was read. */
const tracedResponse = (sent: Sent | undefined): ResponseView | null | undefined => (sent?.trace?.ok === true ? sent.trace.response : undefined);
/** Why the run's trace could not be read, when a run was read back and its trace was not. */
const traceUnread = (sent: Sent | undefined): string | undefined => (sent?.trace?.ok === false ? sent.trace.why : undefined);

/**
 * Sends an inquiry as the person, states that it was accepted and records who entered it, waits up to `waitMs`
 * for its run to end, states that the run the person reads back holds no steps, and reads the run's trace as
 * avery.auditor. Undefined when the inquiry was not accepted.
 */
async function sendAndWait(sessions: Sessions, person: Person, session: string, agent: string, text: string, waitMs: number): Promise<Sent | undefined> {
  const who = person.username;
  const sent = await sendInquiry(HTTP, ADDRESSES, session, { sender: SENDER, text, agent_id: agent });
  const created = sent.body.inquiry as { id?: string; entered_by?: { name?: string } | null } | undefined;
  statement(
    sent.status === 202 && created?.entered_by?.name === person.name,
    `${who}, ${agent}: an inquiry is accepted and records who entered it`,
    `status ${sent.status}, entered_by ${JSON.stringify(created?.entered_by ?? null)}`,
  );
  if (created?.id === undefined) return undefined;
  // When the wait ran out, the run as last read, so the statements can say how far it got.
  const waited = await waitForRun(HTTP, ADDRESSES, session, created.id, waitMs);
  const run = waited.ended ? waited.run : waited.lastRead;
  const noSteps = `${who}, ${agent}: the run ${who} reads back holds no steps`;
  const response: unknown = run?.response;
  if (typeof response === 'object' && response !== null) statement(!('steps' in response), noSteps);
  else notCheckable(noSteps, `the run read back has no response; ${howItEnded(run)}`);
  return { inquiryId: created.id, run, trace: run === undefined ? undefined : await traceOf(sessions, run) };
}

/** Sends an inquiry as the person and waits for its run to end. States that it was accepted and how the run ended. */
async function runStatements(sessions: Sessions, person: Person, session: string, agent: string, text: string): Promise<Sent | undefined> {
  const who = person.username;
  const sent = await sendAndWait(sessions, person, session, agent, text, RUN_WAIT_MS);
  const what = `${who}, ${agent}: the run ends with the agent's answer inside the contract, records who started it, and did not stop at a token, its tool server or its exchange`;
  if (sent === undefined) {
    statement(false, what, 'the inquiry was not accepted, so no run was started');
    return undefined;
  }
  const run = sent.run;
  const stop = run?.response?.stop_reason ?? null;
  statement(
    run?.state === 'completed' && run.started_by?.name === person.name && !stoppedAtToken(stop),
    what,
    JSON.stringify({ state: run?.state, outcome: run?.response?.outcome, stop_reason: stop, started_by: run?.started_by ?? null }),
  );
  return sent;
}

/** Why a run gives nothing further to check: how it ended. */
const howItEnded = (run: RunView | undefined): string =>
  run?.state !== 'completed' ? `the run did not complete (state ${String(run?.state)})` : `the run ended ${String(run.response?.outcome)} with stop reason ${JSON.stringify(run.response?.stop_reason ?? null)}`;

/**
 * If an intake response holds an opened case, riley reads it through the client and the audit entry for its
 * creation names `actor`. Otherwise `what` is not checked, for the reason `whyNone`.
 */
async function caseAuditStatement(sessions: Sessions, what: string, actor: string, response: ResponseView | null | undefined, whyNone: string): Promise<void> {
  const opened = response?.case_actions?.find((action) => action.kind === 'case_opened');
  if (opened?.case_id === undefined) {
    notCheckable(what, whyNone);
    return;
  }
  const session = sessionFor(sessions, 'riley.reviewer', what);
  if (session === undefined) return;
  const answer = await readCase(HTTP, ADDRESSES, session, opened.case_id);
  const record = answer.body as Partial<CaseRecord>;
  const created = Array.isArray(record.audit) ? record.audit.find((entry) => entry.action === 'case_created') : undefined;
  statement(answer.status === 200 && created?.actor === actor, what, `status ${answer.status}, actor ${JSON.stringify(created?.actor ?? null)}`);
}

/** The intake run's case audit statement for an intake agent's own run. */
function intakeCaseAudit(sessions: Sessions, agent: string, sent: Sent | undefined): Promise<void> {
  const what = `${agent}: the case its run opened, read by riley.reviewer through the client, has a case_created audit entry whose actor is ${agent}`;
  return caseAuditStatement(sessions, what, agent, sent?.run?.response, sent === undefined ? 'no run was started' : `the run opened no case; ${howItEnded(sent.run)}`);
}

/**
 * Whether an expert response has a step that exists only after the retrieval service accepted its token and
 * answered: a retrieval step, or a find_labels or search_label step that is not an error, an empty find included.
 */
const answeredByRetrieval = (response: ResponseView | null | undefined): boolean =>
  response?.steps?.some((step) => step.kind === 'retrieval' || (step.kind === 'tool' && RETRIEVAL_TOOLS.includes(step.tool ?? '') && step.is_error === false)) === true;

/** If the expert's run has a step the retrieval service answered, in its trace, the service accepted the expert's token. */
function retrievalStatement(sent: Sent | undefined): void {
  const what = `${EXPERT}: the retrieval service accepted the token the expert sent it (the run has a step the service answered)`;
  const unread = traceUnread(sent);
  if (unread !== undefined) {
    statement(false, what, unread);
    return;
  }
  if (answeredByRetrieval(tracedResponse(sent))) {
    statement(true, what);
    return;
  }
  notCheckable(what, sent === undefined ? 'no run was started' : `the run has no step the retrieval service answered; ${howItEnded(sent.run)}`);
}

// ---------- one run through the orchestrator ----------

const delegationsOf = (response: ResponseView | null | undefined): StepView[] => (response?.steps ?? []).filter((step) => step.kind === 'delegation');

/** Why a delegated response gives nothing further to check: how it ended. */
const howDelegationEnded = (step: StepView): string =>
  step.response === null || step.response === undefined
    ? `it has no response (failure ${JSON.stringify(step.failure ?? null)})`
    : `it ended ${String(step.response.outcome)} with stop reason ${JSON.stringify(step.response.stop_reason ?? null)}`;

/**
 * dana.desk sends one message holding a report and a label question to the orchestrator, and the run is followed,
 * in its trace, through its delegations: screening by the intake agent on Strands, always, and the label expert
 * for each question the model put, each with the sub-agent's whole response. Returns what was sent.
 */
async function orchestratorStatements(sessions: Sessions, person: Person): Promise<Sent | undefined> {
  const who = person.username;
  const prefix = `${who}, ${ORCHESTRATOR}`;
  const session = sessionFor(sessions, who, `${prefix}: an inquiry holding a report and a label question is accepted and its run followed`);
  const sent = session === undefined ? undefined : await sendAndWait(sessions, person, session, ORCHESTRATOR, ORCHESTRATOR_INQUIRY, ORCHESTRATOR_RUN_WAIT_MS);
  const noRun = session === undefined ? `${who} did not sign in, so no run was started` : 'the inquiry was not accepted, so no run was started';
  const run = sent?.run;
  // How the run ended is read from the run as the person read it back; its steps from its trace.
  const response = run?.response;
  const unread = traceUnread(sent);
  const delegations = delegationsOf(tracedResponse(sent));
  const screening = delegations.find((step) => step.id === 'screening' && step.to_agent === SCREENER);
  const screened = screening?.response ?? null;

  const ended = `${prefix}: the run ends inside the contract with outcome completed or stopped, records who started it, and holds a delegation step to ${SCREENER} that has a response`;
  if (sent === undefined) {
    statement(false, ended, noRun);
  } else {
    statement(
      run?.state === 'completed' &&
        (response?.outcome === 'completed' || response?.outcome === 'stopped') &&
        run.started_by?.name === person.name &&
        screened !== null,
      ended,
      JSON.stringify({
        state: run?.state,
        error: run?.error ?? null,
        outcome: response?.outcome,
        stop_reason: response?.stop_reason ?? null,
        started_by: run?.started_by ?? null,
        screening:
          unread !== undefined ? unread : screening === undefined ? 'no screening step' : { failure: screening.failure ?? null, response: screened === null ? null : 'present' },
      }),
    );
  }

  const notAtToken = `${prefix}: screening did not stop at a token: the delegated ${SCREENER} response's stop reason is none of the gate's token stop reasons, and the delegation has no exchange failure`;
  if (sent === undefined) {
    statement(false, notAtToken, noRun);
  } else if (unread !== undefined) {
    statement(false, notAtToken, unread);
  } else if (screening === undefined) {
    statement(false, notAtToken, `the run has no screening step; ${howItEnded(run)}`);
  } else {
    statement(
      screened !== null && !stoppedAtToken(screened.stop_reason ?? null) && !exchangeFailed(screening.failure),
      notAtToken,
      howDelegationEnded(screening),
    );
  }

  const screenedCase = `${ORCHESTRATOR}: the case the delegated ${SCREENER} run opened, read by riley.reviewer through the client, has a case_created audit entry whose actor is ${SCREENER}`;
  if (unread !== undefined) {
    statement(false, screenedCase, unread);
  } else {
    await caseAuditStatement(
      sessions,
      screenedCase,
      SCREENER,
      screened,
      sent === undefined
        ? noRun
        : screening === undefined
          ? `the run has no screening step; ${howItEnded(run)}`
          : `the delegated ${SCREENER} run opened no case; ${howDelegationEnded(screening)}`,
    );
  }

  // Every label-question delegation is judged: none may have stopped at a token or failed its exchange, and at
  // least one must have a response.
  const asked = delegations.filter((step) => step.to_agent === EXPERT);
  const answeredWhat = `${prefix}: the run holds a delegation step to ${EXPERT} with a response, and no delegation to ${EXPERT} stopped at a token or failed its exchange`;
  if (unread !== undefined) {
    statement(false, answeredWhat, unread);
  } else if (asked.length === 0) {
    notCheckable(answeredWhat, sent === undefined ? noRun : `the run put no label question to ${EXPERT}; ${howItEnded(run)}`);
  } else {
    statement(
      asked.some((step) => step.response !== null && step.response !== undefined) &&
        asked.every((step) => !exchangeFailed(step.failure) && !stoppedAtToken(step.response?.stop_reason ?? null)),
      answeredWhat,
      asked.map((step) => `${String(step.id)}: ${howDelegationEnded(step)}`).join('; '),
    );
  }

  const retrievedWhat = `${ORCHESTRATOR}: the retrieval service accepted the token the expert sent it for the orchestrator's question (a delegated ${EXPERT} response has a step the service answered)`;
  const expertResponses = asked.filter((step) => step.response !== null && step.response !== undefined);
  if (unread !== undefined) {
    statement(false, retrievedWhat, unread);
  } else if (expertResponses.some((step) => answeredByRetrieval(step.response))) {
    statement(true, retrievedWhat);
  } else if (expertResponses.length === 0) {
    notCheckable(retrievedWhat, sent === undefined ? noRun : `the run has no delegated ${EXPERT} response; ${howItEnded(run)}`);
  } else {
    notCheckable(
      retrievedWhat,
      `no delegated ${EXPERT} response has a step the retrieval service answered; ${expertResponses.map((step) => `${String(step.id)}: ${howDelegationEnded(step)}`).join('; ')}`,
    );
  }
  return sent;
}

// ---------- who may read traces ----------

/** A run the gate made, and who made it. */
type Made = { person: Person; sent: Sent };

/**
 * Both trace routes are refused to everyone but avery.auditor; to avery.auditor the list holds every run the gate
 * made, and a run's trace holds the agent's steps.
 */
async function traceStatements(sessions: Sessions, made: readonly Made[]): Promise<void> {
  const runIds = made.flatMap(({ sent }) => (sent.run?.id === undefined ? [] : [sent.run.id]));
  // A run the gate made, so that the refusal is of a real run's trace; an id no run has when the gate made none.
  const someRun = runIds[0] ?? randomUUID();
  for (const who of ['dana.desk', 'morgan.medinfo', 'riley.reviewer']) {
    const what = `${who}: both trace routes, the list and a run's trace, are 403`;
    const session = sessionFor(sessions, who, what);
    if (session === undefined) continue;
    const list = await readTraceList(HTTP, ADDRESSES, session);
    const one = await readTrace(HTTP, ADDRESSES, session, someRun);
    statement(
      list.status === 403 && one.status === 403,
      what,
      `list status ${list.status}, trace status ${one.status}${runIds.length === 0 ? ', for an id no run has, since the gate made no run' : ''}`,
    );
  }

  const listed = 'avery.auditor: the trace list is 200 and holds every run this gate made as dana.desk and morgan.medinfo';
  const session = sessionFor(sessions, 'avery.auditor', listed);
  if (session !== undefined) {
    if (runIds.length === 0) {
      notCheckable(listed, 'the gate made no run that was read back with an id');
    } else {
      const list = await readTraceList(HTTP, ADDRESSES, session);
      const traces = Array.isArray(list.body.traces) ? (list.body.traces as { run_id?: unknown }[]) : [];
      const missing = runIds.filter((id) => !traces.some((trace) => trace.run_id === id)).length;
      statement(
        list.status === 200 && missing === 0,
        listed,
        `status ${list.status}, ${missing} of ${runIds.length} run(s) not listed, truncated ${JSON.stringify(list.body.truncated ?? null)}`,
      );
    }
  }

  // The trace read as avery.auditor when the run ended, of the first run read back with a response.
  const withSteps = "avery.auditor: a run's trace is 200 and holds the agent's steps";
  const answered = made.find(({ sent }) => sent.run?.response !== null && sent.run?.response !== undefined);
  if (answered === undefined) {
    notCheckable(withSteps, 'no run the gate made was read back with a response');
  } else {
    const trace = answered.sent.trace;
    const steps = trace?.ok === true ? trace.response?.steps : undefined;
    statement(
      Array.isArray(steps) && steps.length > 0,
      withSteps,
      trace?.ok === false ? trace.why : `the trace of ${answered.person.username}'s run holds ${Array.isArray(steps) ? steps.length : 'no'} steps`,
    );
  }
}

// ---------- who may read an inquiry and start a run on it ----------

/**
 * An inquiry and its runs are read by any session that may run an agent or read cases, and a run is started on any
 * inquiry by a session that may run that agent. morgan.medinfo (who may run agents) and riley.reviewer (who may read
 * cases) each read the inquiry dana.desk entered; morgan.medinfo starts a run of the label expert on it, and
 * riley.reviewer, who may run no agent, is refused as for any call it may not make. The label expert writes nothing,
 * so the run started opens no case; the gate does not wait for it.
 */
async function ownershipStatements(sessions: Sessions, inquiryId: string | undefined): Promise<void> {
  const noInquiry = "dana.desk's inquiry was not accepted, so there was none to ask for";
  // The inquiry carries its runs, so reading it covers them.
  for (const who of ['morgan.medinfo', 'riley.reviewer']) {
    const what = `${who}: reading the inquiry dana.desk entered is 200 and gives that inquiry`;
    if (inquiryId === undefined) {
      statement(false, what, noInquiry);
      continue;
    }
    const session = sessionFor(sessions, who, what);
    if (session === undefined) continue;
    const read = await readInquiry(HTTP, ADDRESSES, session, inquiryId);
    const inquiry = read.body.inquiry as { id?: unknown } | undefined;
    statement(read.status === 200 && inquiry?.id === inquiryId, what, `status ${read.status}, ${inquiry?.id === inquiryId ? 'that inquiry' : 'not that inquiry'}`);
  }

  const started = `morgan.medinfo: starting a run of ${EXPERT} on the inquiry dana.desk entered is 202`;
  if (inquiryId === undefined) {
    statement(false, started, noInquiry);
  } else {
    const session = sessionFor(sessions, 'morgan.medinfo', started);
    if (session !== undefined) {
      const answer = await sendAgain(HTTP, ADDRESSES, session, inquiryId, EXPERT);
      statement(answer.status === 202, started, `status ${answer.status}, ${String(answer.body.error ?? '')}`);
    }
  }

  const refused = `starting a run of ${EXPERT} on the inquiry dana.desk entered`;
  if (inquiryId === undefined) {
    statement(false, `riley.reviewer: ${refused} is 403 not_allowed`, noInquiry);
  } else {
    await refusedStatement(sessions, 'riley.reviewer', refused, (session) => sendAgain(HTTP, ADDRESSES, session, inquiryId, EXPERT));
  }
}

// ---------- tokens presented straight to the services ----------

/** A token the gate got for itself, or why it could not. */
type Grant = { ok: true; token: string } | { ok: false; detail: string };

/** The access token in a token endpoint's answer, judged by ../src/judge.ts. The detail names the status and error only. */
function grantOf(answer: Answer, fields: readonly string[] = ['access_token']): Grant {
  const first = checkTokenAnswer(answer.status, answer.body, fields)[0];
  if (first !== undefined) return { ok: false, detail: `${first.statement}: ${first.detail}` };
  return { ok: true, token: String(answer.body.access_token) };
}

/** A request to the token endpoint. One that cannot be made, or whose answer is not JSON, is a grant not given. */
async function grantFrom(what: string, ask: () => Promise<Answer>, fields?: readonly string[]): Promise<Grant & { body?: Body }> {
  try {
    const answer = await ask();
    const grant = grantOf(answer, fields);
    return grant.ok ? { ...grant, body: answer.body } : { ok: false, detail: `${what}: ${grant.detail}` };
  } catch (error) {
    return { ok: false, detail: `${what}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type Secrets = { deskSecret: string; intakeHandwritten: string; expert: string; orchestrator: string; evaluation: string; knowledgeGate: string };

/** The person signs in through the desk client directly (Authorization Code with PKCE), and the refresh token is kept. */
async function directSignIn(person: Person, secrets: Secrets): Promise<Grant & { refreshToken?: string }> {
  const who = person.username;
  try {
    const jar = new CookieJar();
    const verifier = codeVerifier(randomBytes(32));
    const state = randomBytes(16).toString('base64url');
    const page = await openSignInPage(HTTP, toTransport(ADDRESSES, authorizationUrl(AUTHORIZE, DESK, DESK_SCOPES, state, codeChallengeS256(verifier))), jar);
    const shown = checkSignInPage(page.status, page.html);
    if (shown.action === null) return { ok: false, detail: `${who}'s sign-in page: ${shown.violations.map((v) => `${v.statement}: ${v.detail}`).join('; ')}` };
    const posted = await postSignInForm(HTTP, toTransport(ADDRESSES, shown.action), jar, who, person.password);
    const redirect = checkSignInRedirect(posted, shown.action, DESK.redirectUri, state);
    if (redirect.code === null) return { ok: false, detail: `${who}'s sign-in: ${redirect.violations.map((v) => `${v.statement}: ${v.detail}`).join('; ')}` };
    const code = redirect.code;
    const grant = await grantFrom(`${who}'s code exchange`, () => exchangeCode(HTTP, TOKEN_ENDPOINT, DESK, secrets, code, verifier), ['access_token', 'refresh_token']);
    if (!grant.ok) return grant;
    return { ...grant, refreshToken: String(grant.body?.refresh_token) };
  } catch (error) {
    return { ok: false, detail: `${who}'s sign-in: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The person's token refreshed for one scope. */
async function personToken(person: Person, secrets: Secrets, scope: string): Promise<Grant> {
  const signedIn = await directSignIn(person, secrets);
  if (!signedIn.ok || signedIn.refreshToken === undefined) return signedIn.ok ? { ok: false, detail: 'no refresh token' } : signedIn;
  const refreshToken = signedIn.refreshToken;
  return grantFrom(`${person.username}'s refresh for ${scope}`, () => refresh(HTTP, DESK, TOKEN_ENDPOINT, secrets, refreshToken, `openid ${scope}`));
}

/** What a service answered a token with: the fields a refusal carries (shared/access-token.ts, refusalAnswer). Never the body. */
type Presented = { status: number; error: unknown; reason: unknown; wwwAuthenticate: string | null };

type Expected = { kind: 'ok' } | { kind: 'admitted' } | { kind: 'outside_contract' } | { kind: 'refused'; reason: string; scope?: string };

/**
 * Whether a service's answer to a presented token is the one expected. ok: 200. admitted: neither 401 nor 403,
 * so the token was accepted at the door, whatever the request then got. outside_contract: 400, an agent's answer
 * to a body outside the contract once the token was accepted, with nothing run. refused: the answer refusalAnswer gives
 * for the reason, 403 with the scope named for insufficient_scope and 401 otherwise. Returns the departures.
 */
function judgePresented(answer: Presented, expected: Expected): string[] {
  if (expected.kind === 'ok') return answer.status === 200 ? [] : ['answered 200'];
  if (expected.kind === 'admitted') return answer.status !== 401 && answer.status !== 403 ? [] : ['answered neither 401 nor 403'];
  if (expected.kind === 'outside_contract') return answer.status === 400 ? [] : ['answered 400'];
  const scoped = expected.reason === 'insufficient_scope';
  const departures: string[] = [];
  if (answer.status !== (scoped ? 403 : 401)) departures.push(`answered ${scoped ? 403 : 401}`);
  if (answer.error !== (scoped ? 'forbidden' : 'unauthorized')) departures.push(`error is ${scoped ? 'forbidden' : 'unauthorized'}`);
  if (answer.reason !== expected.reason) departures.push(`reason is ${expected.reason}`);
  const header = scoped ? `Bearer error="insufficient_scope", scope="${expected.scope ?? ''}"` : 'Bearer error="invalid_token"';
  if (answer.wwwAuthenticate !== header) departures.push(`WWW-Authenticate is ${header}`);
  return departures;
}

const describeExpected = (expected: Expected): string =>
  expected.kind === 'ok'
    ? '200'
    : expected.kind === 'admitted'
      ? 'neither 401 nor 403'
      : expected.kind === 'outside_contract'
        ? '400 to a body outside the contract: the token was accepted and nothing was run'
        : `${expected.reason === 'insufficient_scope' ? 403 : 401} with reason ${expected.reason}${expected.scope === undefined ? '' : `, naming ${expected.scope}`}`;

async function presentedStatement(grant: Grant, token: string, service: string, send: (token: string) => Promise<Response>, expected: Expected): Promise<void> {
  const what = `${token}, presented to ${service}, is ${describeExpected(expected)}`;
  if (!grant.ok) {
    statement(false, what, `the gate could not get the token: ${grant.detail}`);
    return;
  }
  const response = await send(grant.token);
  const body = await jsonOf(response);
  const answer: Presented = { status: response.status, error: body.error, reason: body.reason, wwwAuthenticate: response.headers.get('www-authenticate') };
  const departures = judgePresented(answer, expected);
  statement(
    departures.length === 0,
    what,
    `${departures.join(', ')}; got status ${answer.status}, reason ${String(answer.reason)}, WWW-Authenticate ${JSON.stringify(answer.wwwAuthenticate)}`,
  );
}

async function tokenStatements(people: Map<string, Person>, secrets: Secrets): Promise<void> {
  const person = (username: string): Person => {
    const found = people.get(username);
    if (found === undefined) throw new UsageError(`no person ${username}`);
    return found;
  };
  const reviewServer = "the case system's review server";
  const agentsServer = "the case system's agents' server";
  const listCases = (token: string) => get(`${CASE_REVIEW}/cases`, '', { authorization: `Bearer ${token}` });

  const riley = await personToken(person('riley.reviewer'), secrets, 'cases:read');
  await presentedStatement(riley, "riley.reviewer's token for cases:read", `${reviewServer}, GET /cases`, listCases, { kind: 'ok' });
  await presentedStatement(riley, "riley.reviewer's token for cases:read", `${agentsServer}, /mcp`, (token) => mcpRequest(CASE_MCP, token), { kind: 'refused', reason: 'wrong_client' });

  const avery = await personToken(person('avery.auditor'), secrets, 'cases:read');
  await presentedStatement(
    avery,
    "avery.auditor's token for cases:read",
    `${reviewServer}, POST /cases/${NO_SUCH_CASE}/review`,
    (token) => post(`${CASE_REVIEW}/cases/${NO_SUCH_CASE}/review`, JSON.stringify({ decision: 'approve' }), { 'content-type': 'application/json', authorization: `Bearer ${token}` }),
    { kind: 'refused', reason: 'insufficient_scope', scope: 'cases:review' },
  );

  const dana = await personToken(person('dana.desk'), secrets, 'agents:intake');
  const danaName = "dana.desk's token for agents:intake";
  await presentedStatement(
    dana,
    danaName,
    `the label expert, POST /invocations`,
    (token) => post(`${agentUrl(EXPERT)}/invocations`, MESSAGE, { 'content-type': 'application/json', authorization: `Bearer ${token}` }),
    { kind: 'refused', reason: 'wrong_audience' },
  );
  await presentedStatement(dana, danaName, `${agentsServer}, /mcp`, (token) => mcpRequest(CASE_MCP, token), { kind: 'refused', reason: 'wrong_audience' });

  const exchanged: Grant = dana.ok
    ? await grantFrom('intake-handwritten exchanging it for case-system', () =>
        exchange(HTTP, TOKEN_ENDPOINT, 'intake-handwritten', secrets.intakeHandwritten, dana.token, 'case-system', ['cases:write']),
      )
    : { ok: false, detail: `no token to exchange: ${dana.detail}` };
  const exchangedName = `${danaName}, exchanged as intake-handwritten for case-system`;
  await presentedStatement(exchanged, exchangedName, `${reviewServer}, GET /cases`, listCases, { kind: 'refused', reason: 'wrong_client' });
  await presentedStatement(exchanged, exchangedName, `${agentsServer}, /mcp`, (token) => mcpRequest(CASE_MCP, token), { kind: 'admitted' });

  const knowledgeGate = await grantFrom('knowledge-gate by client credentials', () => clientCredentials(HTTP, TOKEN_ENDPOINT, 'knowledge-gate', secrets.knowledgeGate, 'labels:search'));
  await presentedStatement(knowledgeGate, "knowledge-gate's token for labels:search", 'the retrieval service, /mcp', (token) => mcpRequest(KNOWLEDGE, token), { kind: 'admitted' });

  const evaluation = await grantFrom('evaluation by client credentials', () => clientCredentials(HTTP, TOKEN_ENDPOINT, 'evaluation', secrets.evaluation, 'agents:expert'));
  await presentedStatement(evaluation, "evaluation's token for agents:expert", 'the retrieval service, /mcp', (token) => mcpRequest(KNOWLEDGE, token), { kind: 'refused', reason: 'wrong_audience' });

  const expert: Grant = evaluation.ok
    ? await grantFrom('expert exchanging it for knowledge', () => exchange(HTTP, TOKEN_ENDPOINT, EXPERT, secrets.expert, evaluation.token, 'knowledge', ['labels:search']))
    : { ok: false, detail: `no token to exchange: ${evaluation.detail}` };
  await presentedStatement(expert, "evaluation's token, exchanged as expert for knowledge", 'the retrieval service, /mcp', (token) => mcpRequest(KNOWLEDGE, token), { kind: 'admitted' });

  // The orchestrator's path: only a token it exchanged for a sub-agent is accepted there.
  const invoke = (agent: string, body: string) => (token: string) =>
    post(`${agentUrl(agent)}/invocations`, body, { 'content-type': 'application/json', authorization: `Bearer ${token}` });
  const wrongAudience: Expected = { kind: 'refused', reason: 'wrong_audience' };
  const danaOrchestrator = await personToken(person('dana.desk'), secrets, 'agents:orchestrator');
  const danaOrchestratorName = "dana.desk's token for agents:orchestrator";
  await presentedStatement(danaOrchestrator, danaOrchestratorName, `${SCREENER}, POST /invocations`, invoke(SCREENER, MESSAGE), wrongAudience);
  await presentedStatement(danaOrchestrator, danaOrchestratorName, `${EXPERT}, POST /invocations`, invoke(EXPERT, MESSAGE), wrongAudience);

  const forScreener: Grant = danaOrchestrator.ok
    ? await grantFrom(`${ORCHESTRATOR} exchanging it for ${SCREENER}`, () =>
        exchange(HTTP, TOKEN_ENDPOINT, ORCHESTRATOR, secrets.orchestrator, danaOrchestrator.token, SCREENER, ['agents:intake']),
      )
    : { ok: false, detail: `no token to exchange: ${danaOrchestrator.detail}` };
  await presentedStatement(
    forScreener,
    `${danaOrchestratorName}, exchanged as ${ORCHESTRATOR} for ${SCREENER} with agents:intake`,
    `${SCREENER}, POST /invocations`,
    invoke(SCREENER, OUTSIDE_CONTRACT),
    { kind: 'outside_contract' },
  );

  const forExpert: Grant = danaOrchestrator.ok
    ? await grantFrom(`${ORCHESTRATOR} exchanging it for ${EXPERT}`, () =>
        exchange(HTTP, TOKEN_ENDPOINT, ORCHESTRATOR, secrets.orchestrator, danaOrchestrator.token, EXPERT, ['agents:expert:delegated']),
      )
    : { ok: false, detail: `no token to exchange: ${danaOrchestrator.detail}` };
  const forExpertName = `${danaOrchestratorName}, exchanged as ${ORCHESTRATOR} for ${EXPERT} with agents:expert:delegated`;
  await presentedStatement(forExpert, forExpertName, `${EXPERT}, POST /invocations`, invoke(EXPERT, OUTSIDE_CONTRACT), { kind: 'outside_contract' });
  await presentedStatement(forExpert, forExpertName, `${SCREENER}, POST /invocations`, invoke(SCREENER, MESSAGE), wrongAudience);

  await presentedStatement(dana, danaName, `${ORCHESTRATOR}, POST /invocations`, invoke(ORCHESTRATOR, MESSAGE), wrongAudience);
}

// ---------- doors, with no token ----------

async function doorStatements(): Promise<void> {
  const closed = await get(`${CLIENT}/api/inquiries`);
  await closed.arrayBuffer();
  statement(closed.status === 401, 'without a session, /api/inquiries is 401', `status ${closed.status}`);
  const ping = await get(`${CLIENT}/ping`);
  await ping.arrayBuffer();
  statement(ping.status === 200, 'without a session, the client /ping is 200', `status ${ping.status}`);

  for (const agent of AGENTS) {
    const base = agentUrl(agent);
    const none = await post(`${base}/invocations`, MESSAGE, { 'content-type': 'application/json' });
    const noneBody = await jsonOf(none);
    statement(
      none.status === 401 && none.headers.get('www-authenticate') === 'Bearer error="invalid_token"' && noneBody.reason === 'missing',
      `${agent}: no token is 401 with reason missing`,
      `status ${none.status}, reason ${String(noneBody.reason)}`,
    );
    const junk = await post(`${base}/invocations`, MESSAGE, { 'content-type': 'application/json', authorization: 'Bearer not.a.jwt' });
    const junkBody = await jsonOf(junk);
    statement(junk.status === 401 && junkBody.reason === 'malformed', `${agent}: a token that is not a JWT is 401 with reason malformed`, `status ${junk.status}`);
    const outside = await post(`${base}/invocations`, '{"nonsense": ', { 'content-type': 'application/json' });
    await outside.arrayBuffer();
    statement(outside.status === 401, `${agent}: no token and a body outside the contract is 401, not 400`, `status ${outside.status}`);
    const agentPing = await get(`${base}/ping`);
    await agentPing.arrayBuffer();
    statement(agentPing.status === 200, `${agent}: /ping is 200 with no token`, `status ${agentPing.status}`);
  }

  const mcp = await mcpRequest(CASE_MCP);
  await mcp.arrayBuffer();
  statement(mcp.status === 401, "the case system's MCP endpoint is 401 with no token", `status ${mcp.status}`);
  const cases = await get(`${CASE_REVIEW}/cases`);
  await cases.arrayBuffer();
  statement(cases.status === 401, "the case system's review server is 401 with no token", `status ${cases.status}`);
  for (const base of [CASE_MCP, CASE_REVIEW]) {
    const casePing = await get(`${base}/ping`);
    await casePing.arrayBuffer();
    statement(casePing.status === 200, `the case system's ${base === CASE_MCP ? 'MCP' : 'review'} server /ping is 200 with no token`, `status ${casePing.status}`);
  }

  const retrieval = await mcpRequest(KNOWLEDGE);
  await retrieval.arrayBuffer();
  statement(retrieval.status === 401, "the retrieval service's MCP endpoint is 401 with no token", `status ${retrieval.status}`);
  const retrievalPing = await get(`${KNOWLEDGE}/ping`);
  await retrievalPing.arrayBuffer();
  statement(retrievalPing.status === 200, 'the retrieval service /ping is 200 with no token', `status ${retrievalPing.status}`);
}

// ---------- main ----------

async function main(): Promise<number> {
  const people: Person[] = [
    {
      username: 'dana.desk',
      name: 'Dana Desk',
      password: requiredEnv('IDENTITY_DANA_PASSWORD'),
      may: { agents: [...INTAKE_AGENTS, ORCHESTRATOR], read_cases: false, decide_cases: false, read_traces: false },
    },
    {
      username: 'morgan.medinfo',
      name: 'Morgan Medinfo',
      password: requiredEnv('IDENTITY_MORGAN_PASSWORD'),
      may: { agents: [...INTAKE_AGENTS, EXPERT, ORCHESTRATOR], read_cases: false, decide_cases: false, read_traces: false },
    },
    {
      username: 'riley.reviewer',
      name: 'Riley Reviewer',
      password: requiredEnv('IDENTITY_RILEY_PASSWORD'),
      may: { agents: [], read_cases: true, decide_cases: true, read_traces: false },
    },
    {
      username: 'avery.auditor',
      name: 'Avery Auditor',
      password: requiredEnv('IDENTITY_AVERY_PASSWORD'),
      may: { agents: [], read_cases: true, decide_cases: false, read_traces: true },
    },
  ];
  const secrets: Secrets = {
    deskSecret: requiredEnv('IDENTITY_DESK_CLIENT_SECRET'),
    intakeHandwritten: requiredEnv('IDENTITY_INTAKE_HANDWRITTEN_CLIENT_SECRET'),
    expert: requiredEnv('IDENTITY_EXPERT_CLIENT_SECRET'),
    orchestrator: requiredEnv('IDENTITY_ORCHESTRATOR_CLIENT_SECRET'),
    evaluation: requiredEnv('IDENTITY_EVALUATION_CLIENT_SECRET'),
    knowledgeGate: requiredEnv('IDENTITY_KNOWLEDGE_GATE_CLIENT_SECRET'),
  };
  const byName = new Map(people.map((person) => [person.username, person]));
  const named = (username: string): Person => {
    const found = byName.get(username);
    if (found === undefined) throw new UsageError(`no person ${username}`);
    return found;
  };

  await doorStatements();

  const sessions: Sessions = new Map();
  for (const person of people) {
    const session = await signInStatements(person);
    if (session !== undefined) sessions.set(person.username, session);
  }

  await permissionStatements(sessions);

  let danaInquiry: string | undefined;
  const made: Made[] = [];
  for (const agent of INTAKE_AGENTS) {
    const what = `dana.desk, ${agent}: an inquiry is accepted and the run ends inside the contract`;
    const session = sessionFor(sessions, 'dana.desk', what);
    const sent = session === undefined ? undefined : await runStatements(sessions, named('dana.desk'), session, agent, INTAKE_REPORTS[agent]);
    danaInquiry ??= sent?.inquiryId;
    if (sent !== undefined) made.push({ person: named('dana.desk'), sent });
    await intakeCaseAudit(sessions, agent, sent);
  }
  {
    const what = `morgan.medinfo, ${EXPERT}: a question is accepted and the run ends inside the contract`;
    const session = sessionFor(sessions, 'morgan.medinfo', what);
    const sent = session === undefined ? undefined : await runStatements(sessions, named('morgan.medinfo'), session, EXPERT, EXPERT_QUESTION);
    if (sent !== undefined) made.push({ person: named('morgan.medinfo'), sent });
    retrievalStatement(sent);
  }
  const orchestrated = await orchestratorStatements(sessions, named('dana.desk'));
  if (orchestrated !== undefined) made.push({ person: named('dana.desk'), sent: orchestrated });

  await traceStatements(sessions, made);

  await ownershipStatements(sessions, danaInquiry);

  // Got just before they are presented, so that the runs above do not use up their lifetime.
  await tokenStatements(byName, secrets);

  for (const person of people) {
    await signOutStatements(person, sessions);
  }

  if (notChecked.length > 0) {
    process.stderr.write(`stack-gate: ${notChecked.length} statement(s) could not be checked on this stack; see not_checked in the report\n`);
  }
  process.stdout.write(`${JSON.stringify({ passed: failed.length === 0, failed, not_checked: notChecked, held }, null, 2)}\n`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  // The exit code is set and the process left to end by itself, so the whole report reaches a pipe:
  // process.exit would cut a report longer than the pipe's buffer.
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`stack-gate: could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
