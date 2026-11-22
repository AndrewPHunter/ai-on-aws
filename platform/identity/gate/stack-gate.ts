// Gate for the whole stack (platform/identity/README.md, "The stack gate").
//
// Answers one question: on a running stack, do the realm, the agents, the tool servers and the client agree?
// No test runs one piece against another, so a mismatch between two of them is caught here or nowhere. It runs
// on the stack's network and is the browser, a stranger and a token holder at once. In order:
//   1. knocks on each agent, both case-system servers and the retrieval service without a token;
//   2. signs each of the four people in through the client and Keycloak's own sign-in page, and checks the
//      cookies, the refused callbacks, what /api/session says each may do, and a cross-site POST;
//   3. asks the client, as each person, for something they may not do (403 not_allowed) and for something they may;
//   4. sends an inquiry to each intake agent as dana.desk and a question to the label expert as morgan.medinfo,
//      and follows each run to its end: through the agent's exchange to its tool server, and, where the run
//      reached it, to the audit entry of the case it opened or the retrieval service's answer;
//   5. asks the client, as morgan.medinfo, for the inquiry dana.desk entered;
//   6. gets tokens of its own from the provider, as the identity gate does (../src/provider.ts), and presents
//      each to a service, which must accept it or refuse it for the stated reason;
//   7. signs each person out.
//
// A run may end at the model on a stack with no model server, or the model may open no case. The statements
// that need what such a run did not reach are then neither held nor failed: they go in the report's
// not_checked list, each with the reason, and standard error says so too.
//
// Like gate.ts, it stands in for the browser from inside the network, so URLs on the browser's addresses
// (http://localhost:3000 for the client, http://localhost:8090 for the provider) are sent to the services'
// names instead, with the same path and query.
//
// Usage: node stack-gate.ts   (the four people's passwords and the client secrets read in main must be set)
// Every statement is checked even after one fails. Exit codes: 0 every statement holds, 1 one does not,
// 2 the gate could not run. The JSON report goes to standard output, progress to standard error. Neither
// carries a password, code, secret or token.

import { randomBytes, randomUUID } from 'node:crypto';

import type { CaseRecord } from '../../../shared/case-contract.ts';
import { checkSignInPage, checkSignInRedirect, checkTokenAnswer, type Body } from '../src/judge.ts';
import { signInFormAction } from '../src/login-form.ts';
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
const AGENTS = [...INTAKE_AGENTS, EXPERT] as const;
const agentUrl = (agent: string): string => `http://${agent}:8080`;
const CASE_MCP = 'http://case-system:8000';
const CASE_REVIEW = 'http://case-system:8001';
const KNOWLEDGE = 'http://knowledge:8000';
const BROWSER_APP = 'http://localhost:3000';
const BROWSER_IDENTITY = 'http://localhost:8090';
const END_SESSION = `${BROWSER_IDENTITY}/realms/lab/protocol/openid-connect/logout`;
const AUTHORIZE = `${BROWSER_IDENTITY}/realms/lab/protocol/openid-connect/auth`;
const DESK = { clientId: 'desk', redirectUri: `${BROWSER_APP}/auth/callback` };
const DESK_SCOPES = 'openid agents:intake agents:expert cases:read cases:review';
const NO_SUCH_CASE = 'AE-999999';
const HTTP: Http = { timeoutMs: 20_000 };
const RUN_WAIT_MS = 90_000;
// The reasons an agent gives for a run that stopped at a token: its tool server refused the token or could not
// check it, the tool server could not be reached, or the exchange for the tool server's token failed. A run that
// stopped for one of these did not show its token was accepted where it was sent. This list must match the
// agents' own sentences: agents/src/tools/mcp-answers.ts (serviceSentences, for "case system" and "retrieval
// service") and the agents' sentences for a refused or failed exchange.
const TOKEN_STOP_REASONS = [
  "The case system refused the caller's token.",
  "The case system could not check the caller's token.",
  'The case system could not be reached.',
  "The retrieval service refused the caller's token.",
  "The retrieval service could not check the caller's token.",
  'The retrieval service could not be reached.',
];
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

function toTransport(url: string): string {
  if (url.startsWith(BROWSER_IDENTITY)) return IDENTITY + url.slice(BROWSER_IDENTITY.length);
  if (url.startsWith(BROWSER_APP)) return CLIENT + url.slice(BROWSER_APP.length);
  return url;
}

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

/** A POST to the client from its own page, as the signed-in person. */
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

// One cookie per name, with the attributes it was last set with.
class Jar {
  private readonly values = new Map<string, string>();
  readonly attributes = new Map<string, string>();

  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...rest] = line.split(';');
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      this.attributes.set(name, rest.map((part) => part.trim()).sort().join('; '));
      if (value === '' || /max-age=0\b/i.test(line)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  header(only?: string): string {
    return [...this.values]
      .filter(([name]) => only === undefined || name === only)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

// ---------- the people ----------

type May = { agents: string[]; read_cases: boolean; decide_cases: boolean };
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
  const app = new Jar();
  const login = await get(`${CLIENT}/auth/login`);
  app.take(login);
  const target = login.headers.get('location') ?? '';
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
  const provider = new CookieJar();
  const page = await openSignInPage(HTTP, toTransport(target), provider);
  let action: string;
  try {
    action = signInFormAction(page.html);
  } catch (error) {
    statement(false, `${who}: Keycloak shows its sign-in page`, (error as Error).message);
    return undefined;
  }
  const submitted = await postSignInForm(HTTP, toTransport(action), provider, who, person.password);
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
  const completed = await get(toTransport(callback), signInCookie);
  app.take(completed);
  statement(
    completed.status === 302 &&
      completed.headers.get('location') === '/' &&
      app.has('desk_session') &&
      app.attributes.get('desk_session') === 'HttpOnly; Path=/; SameSite=Lax' &&
      !app.has('desk_signin'),
    `${who}: the callback creates a session, sets the session cookie HttpOnly, SameSite=Lax, Path=/, and clears the sign-in cookie`,
    `status ${completed.status}, session cookie ${app.attributes.get('desk_session') ?? 'not set'}, sign-in cookie ${app.has('desk_signin') ? 'still set' : 'cleared'}`,
  );
  const session = app.header('desk_session');

  const replay = await get(toTransport(callback), signInCookie);
  await replay.arrayBuffer();
  statement(replay.status === 400, `${who}: the same callback used again is 400`, `status ${replay.status}`);

  const fresh = await startSignIn(person, false);
  if (fresh === undefined) {
    statement(false, `${who}: a callback without the sign-in cookie is 400 and sets no session`, 'a second sign-in did not reach the callback');
  } else {
    const bare = await get(toTransport(fresh.callback));
    await bare.arrayBuffer();
    const setsSession = bare.headers.getSetCookie().some((line) => line.startsWith('desk_session=') && !/max-age=0\b/i.test(line));
    statement(bare.status === 400 && !setsSession, `${who}: a callback without the sign-in cookie is 400 and sets no session`, `status ${bare.status}`);
  }

  const view = await get(`${CLIENT}/api/session`, session);
  const viewText = await view.text();
  let viewed: { user?: { username?: unknown; name?: unknown }; may?: { agents?: unknown; read_cases?: unknown; decide_cases?: unknown } } = {};
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
  const out = await post(`${CLIENT}/auth/logout`, '{}', { 'content-type': 'application/json', cookie: session, origin: BROWSER_APP });
  const outText = await out.text();
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

async function refusedStatement(sessions: Sessions, who: string, what: string, send: (session: string) => Promise<Response>): Promise<void> {
  const full = `${who}: ${what} is 403 not_allowed`;
  const session = sessionFor(sessions, who, full);
  if (session === undefined) return;
  const answer = await send(session);
  const body = await jsonOf(answer);
  statement(answer.status === 403 && body.error === 'not_allowed', full, `status ${answer.status}, ${String(body.error)}`);
}

async function permissionStatements(sessions: Sessions): Promise<void> {
  const inquiry = (agent: string) => (session: string) =>
    postAs(session, '/api/inquiries', { sender: 'Dr Gate, gate@example.org', text: 'What is the usual starting dose?', agent_id: agent });
  const caseList = (session: string) => get(`${CLIENT}/api/cases`, session);
  const decide = (session: string) => postAs(session, `/api/cases/${NO_SUCH_CASE}/review`, { decision: 'approve' });

  await refusedStatement(sessions, 'dana.desk', `sending an inquiry to ${EXPERT}`, inquiry(EXPERT));
  await refusedStatement(sessions, 'dana.desk', 'reading the case list', caseList);
  await refusedStatement(sessions, 'riley.reviewer', `sending an inquiry to ${INTAKE_AGENTS[0]}`, inquiry(INTAKE_AGENTS[0]));
  await refusedStatement(sessions, 'avery.auditor', 'deciding a case', decide);
  await refusedStatement(sessions, 'morgan.medinfo', 'reading the case list', caseList);

  for (const who of ['riley.reviewer', 'avery.auditor']) {
    const what = `${who}: reading the case list is 200`;
    const session = sessionFor(sessions, who, what);
    if (session === undefined) continue;
    const answer = await caseList(session);
    await answer.arrayBuffer();
    statement(answer.status === 200, what, `status ${answer.status}`);
  }

  const what = `riley.reviewer: deciding a case that does not exist gets the case system's own answer, 404 case_not_found, so the token and its scope were accepted there`;
  const session = sessionFor(sessions, 'riley.reviewer', what);
  if (session !== undefined) {
    const answer = await decide(session);
    const body = await jsonOf(answer);
    statement(answer.status === 404 && body.error === 'case_not_found', what, `status ${answer.status}, ${String(body.error)}`);
  }
}

// ---------- runs, to the end ----------

type RunView = {
  state?: string;
  started_by?: { name?: string } | null;
  response?: {
    outcome?: string;
    stop_reason?: string | null;
    case_actions?: { kind?: string; case_id?: string }[];
    steps?: { kind?: string }[];
  } | null;
};

type Sent = { inquiryId: string; run: RunView | undefined };

/** Sends an inquiry as the person and waits for its run to end. States that it was accepted and how the run ended. */
async function runStatements(person: Person, session: string, agent: string, text: string): Promise<Sent | undefined> {
  const who = person.username;
  const sent = await postAs(session, '/api/inquiries', { sender: 'Dr Gate, gate@example.org', text, agent_id: agent });
  const created = (await jsonOf(sent)).inquiry as { id?: string; entered_by?: { name?: string } | null } | undefined;
  statement(
    sent.status === 202 && created?.entered_by?.name === person.name,
    `${who}, ${agent}: an inquiry is accepted and records who entered it`,
    `status ${sent.status}, entered_by ${JSON.stringify(created?.entered_by ?? null)}`,
  );
  const what = `${who}, ${agent}: the run ends with the agent's answer inside the contract, records who started it, and did not stop at a token, its tool server or its exchange`;
  if (created?.id === undefined) {
    statement(false, what, 'the inquiry was not accepted, so no run was started');
    return undefined;
  }
  let run: RunView | undefined;
  const deadline = Date.now() + RUN_WAIT_MS;
  while (Date.now() < deadline) {
    const read = (await jsonOf(await get(`${CLIENT}/api/inquiries/${encodeURIComponent(created.id)}`, session))).inquiry as { runs?: RunView[] } | undefined;
    run = read?.runs?.[0];
    if (run !== undefined && run.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const stop = run?.response?.stop_reason ?? null;
  statement(
    run?.state === 'completed' && run.started_by?.name === person.name && !TOKEN_STOP_REASONS.includes(stop ?? ''),
    what,
    JSON.stringify({ state: run?.state, outcome: run?.response?.outcome, stop_reason: stop, started_by: run?.started_by ?? null }),
  );
  return { inquiryId: created.id, run };
}

/** Why a run gives nothing further to check: how it ended. */
const howItEnded = (run: RunView | undefined): string =>
  run?.state !== 'completed' ? `the run did not complete (state ${String(run?.state)})` : `the run ended ${String(run.response?.outcome)} with stop reason ${JSON.stringify(run.response?.stop_reason ?? null)}`;

/** If the intake run opened a case, riley reads it through the client and the audit entry for its creation names the agent. */
async function caseAuditStatement(sessions: Sessions, agent: string, sent: Sent | undefined): Promise<void> {
  const what = `${agent}: the case its run opened, read by riley.reviewer through the client, has a case_created audit entry whose actor is ${agent}`;
  const opened = sent?.run?.response?.case_actions?.find((action) => action.kind === 'case_opened');
  if (opened?.case_id === undefined) {
    notCheckable(what, sent === undefined ? 'no run was started' : `the run opened no case; ${howItEnded(sent.run)}`);
    return;
  }
  const session = sessionFor(sessions, 'riley.reviewer', what);
  if (session === undefined) return;
  const answer = await get(`${CLIENT}/api/cases/${encodeURIComponent(opened.case_id)}`, session);
  const record = (await jsonOf(answer)) as Partial<CaseRecord>;
  const created = Array.isArray(record.audit) ? record.audit.find((entry) => entry.action === 'case_created') : undefined;
  statement(answer.status === 200 && created?.actor === agent, what, `status ${answer.status}, actor ${JSON.stringify(created?.actor ?? null)}`);
}

/** If the expert's run made a retrieval step, the retrieval service answered it, so it accepted the expert's token. */
function retrievalStatement(sent: Sent | undefined): void {
  const what = `${EXPERT}: the retrieval service accepted the token the expert sent it (the run has a retrieval step the service answered)`;
  if (sent?.run?.response?.steps?.some((step) => step.kind === 'retrieval') === true) {
    statement(true, what);
    return;
  }
  notCheckable(what, sent === undefined ? 'no run was started' : `the run made no retrieval step; ${howItEnded(sent.run)}`);
}

// ---------- an inquiry belongs to who entered it ----------

/** The answer's status and body, with `id` in the body replaced, so two answers about different ids compare. */
async function answerAbout(response: Response, id: string): Promise<{ status: number; body: string }> {
  return { status: response.status, body: (await response.text()).split(id).join('<id>') };
}

async function ownershipStatements(sessions: Sessions, inquiryId: string | undefined): Promise<void> {
  const unknown = randomUUID();
  const asks: [string, (session: string, id: string) => Promise<Response>][] = [
    ['the inquiry', (session, id) => get(`${CLIENT}/api/inquiries/${encodeURIComponent(id)}`, session)],
    ['its runs', (session, id) => get(`${CLIENT}/api/inquiries/${encodeURIComponent(id)}/runs`, session)],
    // An agent morgan may run, so that a refusal can only be about whose inquiry it is.
    ['to start a run on it', (session, id) => postAs(session, `/api/inquiries/${encodeURIComponent(id)}/runs`, { agent_id: INTAKE_AGENTS[0] })],
  ];
  for (const [asked, send] of asks) {
    const what = `morgan.medinfo: asking for ${asked} of the inquiry dana.desk entered gets the same status and body (the id aside) as for an inquiry id that does not exist`;
    if (inquiryId === undefined) {
      statement(false, what, "dana.desk's inquiry was not accepted, so there was none to ask for");
      continue;
    }
    const session = sessionFor(sessions, 'morgan.medinfo', what);
    if (session === undefined) continue;
    const theirs = await answerAbout(await send(session, inquiryId), inquiryId);
    const none = await answerAbout(await send(session, unknown), unknown);
    statement(
      theirs.status === none.status && theirs.body === none.body,
      what,
      `status ${theirs.status} against ${none.status}, bodies ${theirs.body === none.body ? 'the same' : 'differ'}`,
    );
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

type Secrets = { deskSecret: string; intakeHandwritten: string; expert: string; evaluation: string; knowledgeGate: string };

/** The person signs in through the desk client directly (Authorization Code with PKCE), and the refresh token is kept. */
async function directSignIn(person: Person, secrets: Secrets): Promise<Grant & { refreshToken?: string }> {
  const who = person.username;
  try {
    const jar = new CookieJar();
    const verifier = codeVerifier(randomBytes(32));
    const state = randomBytes(16).toString('base64url');
    const page = await openSignInPage(HTTP, toTransport(authorizationUrl(AUTHORIZE, DESK, DESK_SCOPES, state, codeChallengeS256(verifier))), jar);
    const shown = checkSignInPage(page.status, page.html);
    if (shown.action === null) return { ok: false, detail: `${who}'s sign-in page: ${shown.violations.map((v) => `${v.statement}: ${v.detail}`).join('; ')}` };
    const posted = await postSignInForm(HTTP, toTransport(shown.action), jar, who, person.password);
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

type Expected = { kind: 'ok' } | { kind: 'admitted' } | { kind: 'refused'; reason: string; scope?: string };

/**
 * Whether a service's answer to a presented token is the one expected. ok: 200. admitted: neither 401 nor 403,
 * so the token was accepted at the door, whatever the request then got. refused: the answer refusalAnswer gives
 * for the reason, 403 with the scope named for insufficient_scope and 401 otherwise. Returns the departures.
 */
function judgePresented(answer: Presented, expected: Expected): string[] {
  if (expected.kind === 'ok') return answer.status === 200 ? [] : ['answered 200'];
  if (expected.kind === 'admitted') return answer.status !== 401 && answer.status !== 403 ? [] : ['answered neither 401 nor 403'];
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
        exchange(HTTP, TOKEN_ENDPOINT, 'intake-handwritten', secrets.intakeHandwritten, dana.token, 'case-system', ['cases:write', 'cases:lookup']),
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
      may: { agents: [...INTAKE_AGENTS], read_cases: false, decide_cases: false },
    },
    {
      username: 'morgan.medinfo',
      name: 'Morgan Medinfo',
      password: requiredEnv('IDENTITY_MORGAN_PASSWORD'),
      may: { agents: [...INTAKE_AGENTS, EXPERT], read_cases: false, decide_cases: false },
    },
    { username: 'riley.reviewer', name: 'Riley Reviewer', password: requiredEnv('IDENTITY_RILEY_PASSWORD'), may: { agents: [], read_cases: true, decide_cases: true } },
    { username: 'avery.auditor', name: 'Avery Auditor', password: requiredEnv('IDENTITY_AVERY_PASSWORD'), may: { agents: [], read_cases: true, decide_cases: false } },
  ];
  const secrets: Secrets = {
    deskSecret: requiredEnv('IDENTITY_DESK_CLIENT_SECRET'),
    intakeHandwritten: requiredEnv('IDENTITY_INTAKE_HANDWRITTEN_CLIENT_SECRET'),
    expert: requiredEnv('IDENTITY_EXPERT_CLIENT_SECRET'),
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
  for (const agent of INTAKE_AGENTS) {
    const what = `dana.desk, ${agent}: an inquiry is accepted and the run ends inside the contract`;
    const session = sessionFor(sessions, 'dana.desk', what);
    const sent = session === undefined ? undefined : await runStatements(named('dana.desk'), session, agent, 'What is the usual starting dose?');
    danaInquiry ??= sent?.inquiryId;
    await caseAuditStatement(sessions, agent, sent);
  }
  {
    const what = `morgan.medinfo, ${EXPERT}: a question is accepted and the run ends inside the contract`;
    const session = sessionFor(sessions, 'morgan.medinfo', what);
    const sent = session === undefined ? undefined : await runStatements(named('morgan.medinfo'), session, EXPERT, 'What does the label say about the usual starting dose?');
    retrievalStatement(sent);
  }

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
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`stack-gate: could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
