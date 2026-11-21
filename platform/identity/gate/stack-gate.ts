// Gate for the whole stack (platform/identity/README.md, "The stack gate").
//
// Answers one question: does a running stack hold every promise sign-in makes, end to end? It runs on
// the stack's network and is the browser and a stranger at once:
//   - signs both realm users in through the client and Keycloak's own sign-in page;
//   - checks the cookies, the session, refused callbacks, a cross-site POST, and sign-out;
//   - knocks on each agent and on both case-system servers without a token;
//   - sends an inquiry to each agent as each user, and waits for the run to end inside the agent contract
//     (it does not depend on a model server: a run may end at the model);
//   - asks the client to review a case that does not exist, as a non-reviewer and as a reviewer.
//
// Like gate.ts, it stands in for the browser from inside the network, so URLs on the browser's addresses
// (http://localhost:3000 for the client, http://localhost:8090 for the provider) are sent to the services'
// names instead, with the same path and query.
//
// Usage: node stack-gate.ts   (IDENTITY_RILEY_PASSWORD and IDENTITY_DANA_PASSWORD must be set)
// Every statement is checked even after one fails. Exit codes: 0 every statement holds, 1 one does not,
// 2 the gate could not run. The JSON report goes to standard output, progress to standard error. Neither
// carries a password, code or token.

import { signInFormAction } from '../src/login-form.ts';

const CLIENT = 'http://client:3000';
const IDENTITY = 'http://identity:8080';
const AGENTS = ['intake-handwritten', 'intake-strands'] as const;
const CASE_MCP = 'http://case-system:8000';
const CASE_REVIEW = 'http://case-system:8001';
const BROWSER_APP = 'http://localhost:3000';
const BROWSER_IDENTITY = 'http://localhost:8090';
const END_SESSION = `${BROWSER_IDENTITY}/realms/lab/protocol/openid-connect/logout`;
const AUTHORIZE = `${BROWSER_IDENTITY}/realms/lab/protocol/openid-connect/auth`;
const TIMEOUT_MS = 20_000;
const RUN_WAIT_MS = 90_000;
// A run that stopped at the case system did not show the token was accepted there.
const CASE_SYSTEM_REASONS = [
  "The case system refused the caller's token.",
  "The case system could not check the caller's token.",
  'The case system could not be reached.',
];
// What a JWT looks like: a base64url header that starts {"
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\./;

class UsageError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new UsageError(`missing required environment variable ${name}`);
  return value;
}

const held: string[] = [];
const failed: string[] = [];

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

function toTransport(url: string): string {
  if (url.startsWith(BROWSER_IDENTITY)) return IDENTITY + url.slice(BROWSER_IDENTITY.length);
  if (url.startsWith(BROWSER_APP)) return CLIENT + url.slice(BROWSER_APP.length);
  return url;
}

function get(url: string, cookie = '', headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    redirect: 'manual',
    headers: cookie === '' ? headers : { ...headers, cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function post(url: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: 'POST', redirect: 'manual', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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

type User = { username: string; name: string; password: string; reviewer: boolean };

// /auth/login, Keycloak's page, the password, and back to the callback, which is returned unrequested.
async function startSignIn(user: User, record: boolean): Promise<{ app: Jar; callback: string } | undefined> {
  const who = user.username;
  const app = new Jar();
  const provider = new Jar();
  const login = await get(`${CLIENT}/auth/login`);
  app.take(login);
  const target = login.headers.get('location') ?? '';
  if (record) {
    const query = target.startsWith(AUTHORIZE) ? new URL(target).searchParams : new URLSearchParams();
    statement(
      login.status === 302 &&
        target.startsWith(AUTHORIZE) &&
        query.get('response_type') === 'code' &&
        query.get('client_id') === 'desk' &&
        query.get('redirect_uri') === `${BROWSER_APP}/auth/callback` &&
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
  const page = await get(toTransport(target));
  provider.take(page);
  const html = await page.text();
  let action: string;
  try {
    action = signInFormAction(html);
  } catch (error) {
    statement(false, `${who}: Keycloak shows its sign-in page`, (error as Error).message);
    return undefined;
  }
  const submitted = await post(toTransport(action), new URLSearchParams({ username: who, password: user.password, credentialId: '' }).toString(), {
    'content-type': 'application/x-www-form-urlencoded',
    cookie: provider.header(),
  });
  await submitted.arrayBuffer();
  const callback = submitted.headers.get('location') ?? '';
  const accepted = submitted.status === 302 && callback.startsWith(`${BROWSER_APP}/auth/callback?`);
  if (record) {
    statement(accepted, `${who}: Keycloak's own page accepts the password and redirects to the callback`, `status ${submitted.status}`);
  }
  return accepted ? { app, callback } : undefined;
}

async function userStatements(user: User): Promise<void> {
  const who = user.username;
  const started = await startSignIn(user, true);
  if (started === undefined) {
    statement(false, `${who}: signed in`, 'the sign-in did not reach the callback; the remaining statements for this user were not checked');
    return;
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

  const fresh = await startSignIn(user, false);
  if (fresh === undefined) {
    statement(false, `${who}: a callback without the sign-in cookie is 400`, 'a second sign-in did not reach the callback');
  } else {
    const bare = await get(toTransport(fresh.callback));
    await bare.arrayBuffer();
    const setsSession = bare.headers.getSetCookie().some((line) => line.startsWith('desk_session=') && !/max-age=0\b/i.test(line));
    statement(bare.status === 400 && !setsSession, `${who}: a callback without the sign-in cookie is 400 and sets no session`, `status ${bare.status}`);
  }

  const view = await get(`${CLIENT}/api/session`, session);
  const viewText = await view.text();
  let viewed: { user?: { username?: string; name?: string; is_reviewer?: boolean } } = {};
  try {
    viewed = JSON.parse(viewText) as typeof viewed;
  } catch {
    viewed = {};
  }
  statement(
    view.status === 200 && viewed.user?.username === who && viewed.user.is_reviewer === user.reviewer,
    `${who}: /api/session names the user, with is_reviewer ${String(user.reviewer)}`,
    `status ${view.status}, ${JSON.stringify({ username: viewed.user?.username, is_reviewer: viewed.user?.is_reviewer })}`,
  );
  statement(!JWT_PATTERN.test(viewText), `${who}: /api/session carries no token`);

  const status = await jsonOf(await get(`${CLIENT}/api/status`, session));
  const pieces = Array.isArray(status.pieces) ? (status.pieces as Record<string, unknown>[]) : [];
  const identity = pieces.find((piece) => piece.id === 'identity');
  statement(identity?.state === 'up', `${who}: /api/status lists the identity provider as up`, JSON.stringify(identity ?? null));

  const foreign = await post(`${CLIENT}/api/inquiries`, JSON.stringify({ sender: 'x', text: 'x', agent_id: AGENTS[0] }), {
    'content-type': 'application/json',
    cookie: session,
    origin: 'http://elsewhere.example.org',
  });
  await foreign.arrayBuffer();
  statement(foreign.status === 403, `${who}: a POST from another origin is 403`, `status ${foreign.status}`);

  for (const agent of AGENTS) {
    await inquiryStatements(user, session, agent);
  }

  const review = await post(`${CLIENT}/api/cases/AE-999999/review`, JSON.stringify({ decision: 'approve' }), {
    'content-type': 'application/json',
    cookie: session,
    origin: BROWSER_APP,
  });
  const reviewed = await jsonOf(review);
  if (user.reviewer) {
    statement(
      review.status === 404 && reviewed.error === 'case_not_found',
      `${who}: a review of a case that does not exist is 404 case_not_found`,
      `status ${review.status}, ${String(reviewed.error)}`,
    );
  } else {
    statement(
      review.status === 403 && reviewed.error === 'not_a_reviewer',
      `${who}: a review of a case that does not exist is 403 not_a_reviewer`,
      `status ${review.status}, ${String(reviewed.error)}`,
    );
  }

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
    `${who}: sign-out answers with the provider's end-session address, carrying no token`,
    `status ${out.status}, parameters ${signOut === undefined ? 'none' : [...signOut.searchParams.keys()].join(',')}`,
  );
  const after = await get(`${CLIENT}/api/session`, session);
  await after.arrayBuffer();
  statement(after.status === 401, `${who}: after sign-out the same cookie is 401`, `status ${after.status}`);
}

type RunView = {
  state?: string;
  started_by?: { name?: string } | null;
  response?: { outcome?: string; stop_reason?: string | null } | null;
};

async function inquiryStatements(user: User, session: string, agent: string): Promise<void> {
  const who = user.username;
  const sent = await post(
    `${CLIENT}/api/inquiries`,
    JSON.stringify({ sender: 'Dr Gate, gate@example.org', text: 'What is the usual starting dose?', agent_id: agent }),
    { 'content-type': 'application/json', cookie: session, origin: BROWSER_APP },
  );
  const created = (await jsonOf(sent)).inquiry as { id?: string; entered_by?: { name?: string } | null } | undefined;
  statement(
    sent.status === 202 && created?.entered_by?.name === user.name,
    `${who}, ${agent}: an inquiry is accepted and records who entered it`,
    `status ${sent.status}, entered_by ${JSON.stringify(created?.entered_by ?? null)}`,
  );
  if (created?.id === undefined) return;
  let run: RunView | undefined;
  const deadline = Date.now() + RUN_WAIT_MS;
  while (Date.now() < deadline) {
    const read = (await jsonOf(await get(`${CLIENT}/api/inquiries/${encodeURIComponent(created.id)}`, session))).inquiry as
      | { runs?: RunView[] }
      | undefined;
    run = read?.runs?.[0];
    if (run !== undefined && run.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const stop = run?.response?.stop_reason ?? null;
  statement(
    run?.state === 'completed' && run.started_by?.name === user.name && !CASE_SYSTEM_REASONS.includes(stop ?? ''),
    `${who}, ${agent}: the run ends with the agent's answer inside the contract, past the case system, and records who started it`,
    JSON.stringify({ state: run?.state, outcome: run?.response?.outcome, stop_reason: stop, started_by: run?.started_by ?? null }),
  );
}

async function doorStatements(): Promise<void> {
  const closed = await get(`${CLIENT}/api/inquiries`);
  await closed.arrayBuffer();
  statement(closed.status === 401, 'without a session, /api/inquiries is 401', `status ${closed.status}`);
  const ping = await get(`${CLIENT}/ping`);
  await ping.arrayBuffer();
  statement(ping.status === 200, 'without a session, the client /ping is 200', `status ${ping.status}`);

  const message = JSON.stringify({ message: { id: 'stack-gate-1', received_at: '2026-01-01T00:00:00.000Z', sender: 'gate@example.org', text: 'hello' } });
  for (const agent of AGENTS) {
    const base = `http://${agent}:8080`;
    const none = await post(`${base}/invocations`, message, { 'content-type': 'application/json' });
    const noneBody = await jsonOf(none);
    statement(
      none.status === 401 && none.headers.get('www-authenticate') === 'Bearer error="invalid_token"' && noneBody.reason === 'missing',
      `${agent}: no token is 401 with reason missing`,
      `status ${none.status}, reason ${String(noneBody.reason)}`,
    );
    const junk = await post(`${base}/invocations`, message, { 'content-type': 'application/json', authorization: 'Bearer not.a.jwt' });
    const junkBody = await jsonOf(junk);
    statement(junk.status === 401 && junkBody.reason === 'malformed', `${agent}: a token that is not a JWT is 401 with reason malformed`, `status ${junk.status}`);
    const outside = await post(`${base}/invocations`, '{"nonsense": ', { 'content-type': 'application/json' });
    await outside.arrayBuffer();
    statement(outside.status === 401, `${agent}: no token and a body outside the contract is 401, not 400`, `status ${outside.status}`);
    const agentPing = await get(`${base}/ping`);
    await agentPing.arrayBuffer();
    statement(agentPing.status === 200, `${agent}: /ping is 200 with no token`, `status ${agentPing.status}`);
  }

  const mcp = await post(`${CASE_MCP}/mcp`, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });
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
}

async function main(): Promise<number> {
  const users: User[] = [
    { username: 'riley.reviewer', name: 'Riley Reviewer', password: requiredEnv('IDENTITY_RILEY_PASSWORD'), reviewer: true },
    { username: 'dana.desk', name: 'Dana Desk', password: requiredEnv('IDENTITY_DANA_PASSWORD'), reviewer: false },
  ];
  await doorStatements();
  for (const user of users) {
    await userStatements(user);
  }
  process.stdout.write(`${JSON.stringify({ passed: failed.length === 0, failed, held }, null, 2)}\n`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`stack-gate: could not run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
