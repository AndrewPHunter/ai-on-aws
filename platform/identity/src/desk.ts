// The requests a person makes through the web client (the desk), standing in for their browser: signing in
// through the client and the provider's own sign-in page, sending an inquiry and sending it again, waiting for
// a run to end, reading the case list and one case, reading the trace list and one run's trace, and signing out. Used by gate/stack-gate.ts and by the
// attack runner in evaluation/, so that both act as a person in the same way.
//
// Each function makes its requests against the addresses it is given and returns what was answered. Nothing
// here judges an answer, reports, logs or reads the environment: a person's username and password are
// arguments, and whether an answer meets a statement is the caller's to decide. No request is retried.
//
// The caller runs inside the stack's network, so the addresses the browser would use (in the client's
// redirects and the provider's form) are sent to the services' own addresses instead, with the same path and
// query (toTransport).

import type { NewInquiryRequest } from '../../../client/shared/api.ts'
import { signInFormAction } from './login-form.ts'
import { CookieJar, openSignInPage, postSignInForm, request, type Http } from './provider.ts'

/** Where the client and the provider are: on the caller's network, and as the browser addresses them. */
export type DeskAddresses = {
  client: string
  identity: string
  browserClient: string
  browserIdentity: string
}

/** A URL on one of the browser's addresses, sent to the matching service's own address instead. */
export function toTransport(addresses: DeskAddresses, url: string): string {
  if (url.startsWith(addresses.browserIdentity)) return addresses.identity + url.slice(addresses.browserIdentity.length)
  if (url.startsWith(addresses.browserClient)) return addresses.client + url.slice(addresses.browserClient.length)
  return url
}

/** The client's cookies, one per name, with the attributes each was last set with. */
export class Jar {
  private readonly values = new Map<string, string>()
  readonly attributes = new Map<string, string>()

  /** Takes the Set-Cookie lines of an answer. */
  take(setCookies: readonly string[]): void {
    for (const line of setCookies) {
      const [pair = '', ...rest] = line.split(';')
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      this.attributes.set(name, rest.map((part) => part.trim()).sort().join('; '))
      if (value === '' || /max-age=0\b/i.test(line)) this.values.delete(name)
      else this.values.set(name, value)
    }
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  /** The Cookie header for every cookie held, or for the one named `only`. */
  header(only?: string): string {
    return [...this.values]
      .filter(([name]) => only === undefined || name === only)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }
}

/**
 * An answer from the client: its status, its body as text, and the body parsed as JSON. `body` is {} when the
 * text is not JSON or not an object, so a reader of a field gets undefined rather than an error.
 */
export type Reply = { status: number; body: Record<string, unknown>; text: string }

async function replyOf(response: Response): Promise<Reply> {
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null) body = value as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: response.status, body, text }
}

/** A GET as the person; an empty session sends no Cookie header. */
function getAs(http: Http, addresses: DeskAddresses, session: string, path: string): Promise<Reply> {
  return request(http, `${addresses.client}${path}`, session === '' ? {} : { headers: { cookie: session } }).then(replyOf)
}

/** A POST from the client's own page, as the signed-in person. */
function postAs(http: Http, addresses: DeskAddresses, session: string, path: string, body: unknown): Promise<Reply> {
  return request(http, `${addresses.client}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session, origin: addresses.browserClient },
    body: JSON.stringify(body),
  }).then(replyOf)
}

// ---------- signing in, step by step ----------

/** What the client's /auth/login answered, and the cookies it set (the sign-in cookie among them). */
export type LoginStarted = { status: number; location: string | null; cookies: Jar }

/** GET /auth/login on the client. The redirect is read, not followed. */
export async function openLogin(http: Http, addresses: DeskAddresses): Promise<LoginStarted> {
  const login = await request(http, `${addresses.client}/auth/login`)
  const cookies = new Jar()
  cookies.take(login.headers.getSetCookie())
  await login.arrayBuffer()
  return { status: login.status, location: login.headers.get('location'), cookies }
}

/**
 * What the provider did with the password: `shown` false when its page held no sign-in form (with why), or the
 * answer to the posted form, whose redirect is read, not followed.
 */
export type ProviderSignIn = { shown: false; detail: string } | { shown: true; status: number; location: string | null }

/** Opens the provider's sign-in page at `authorizeUrl` (as the client redirected to it) and posts the username and password. */
export async function signInAtProvider(http: Http, addresses: DeskAddresses, authorizeUrl: string, username: string, password: string): Promise<ProviderSignIn> {
  const jar = new CookieJar()
  const page = await openSignInPage(http, toTransport(addresses, authorizeUrl), jar)
  let action: string
  try {
    action = signInFormAction(page.html)
  } catch (error) {
    return { shown: false, detail: (error as Error).message }
  }
  const submitted = await postSignInForm(http, toTransport(addresses, action), jar, username, password)
  return { shown: true, status: submitted.status, location: submitted.location }
}

/** What the client's callback answered: its status, its redirect and the Set-Cookie lines. */
export type CallbackAnswer = { status: number; location: string | null; setCookies: string[] }

/** GET the callback the provider redirected to, with `cookie` (the sign-in cookie) or with none. */
export async function openCallback(http: Http, addresses: DeskAddresses, callback: string, cookie = ''): Promise<CallbackAnswer> {
  const answer = await request(http, toTransport(addresses, callback), cookie === '' ? {} : { headers: { cookie } })
  await answer.arrayBuffer()
  return { status: answer.status, location: answer.headers.get('location'), setCookies: answer.headers.getSetCookie() }
}

/** A session (the Cookie header to send as the person), or why the sign-in did not complete. */
export type SignIn = { ok: true; session: string } | { ok: false; why: string }

/**
 * The whole sign-in in one call, for a program that only wants a session: /auth/login, the provider's page and
 * the password, and the callback with the sign-in cookie. Why it did not complete names the step and the status
 * only, never a URL, which would carry the code or state. Used by the attack runner in evaluation/; the stack
 * gate makes statements between the steps, so it calls them one by one.
 */
export async function signIn(http: Http, addresses: DeskAddresses, username: string, password: string): Promise<SignIn> {
  const login = await openLogin(http, addresses)
  const target = login.location ?? ''
  if (login.status !== 302 || !target.startsWith(`${addresses.browserIdentity}/`)) {
    return { ok: false, why: `the client's /auth/login answered status ${login.status} without a redirect to the provider` }
  }
  const provider = await signInAtProvider(http, addresses, target, username, password)
  if (!provider.shown) return { ok: false, why: provider.detail }
  const callback = provider.location ?? ''
  if (provider.status !== 302 || !callback.startsWith(`${addresses.browserClient}/auth/callback?`)) {
    return { ok: false, why: `the provider answered the password with status ${provider.status}, not a redirect to the client's callback` }
  }
  const completed = await openCallback(http, addresses, callback, login.cookies.header('desk_signin'))
  login.cookies.take(completed.setCookies)
  if (completed.status !== 302 || !login.cookies.has('desk_session')) {
    return { ok: false, why: `the client's callback answered status ${completed.status} without a session cookie` }
  }
  return { ok: true, session: login.cookies.header('desk_session') }
}

/** POST /auth/logout as the person. */
export function signOut(http: Http, addresses: DeskAddresses, session: string): Promise<Reply> {
  return postAs(http, addresses, session, '/auth/logout', {})
}

// ---------- inquiries and their runs ----------

// A run as a caller reads it from the client's answer, which is not validated here: every field may be missing.
// The client's own shapes are Run and InvocationResponse in client/shared/api.ts. A run read back on the
// inquiry routes has no steps; the same run in a trace has the agent's whole response, and there a delegation
// step carries the sub-agent's whole response.
export type ResponseView = {
  outcome?: string
  stop_reason?: string | null
  case_actions?: { kind?: string; case_id?: string }[]
  steps?: StepView[]
}
export type StepView = {
  kind?: string
  tool?: string
  is_error?: boolean
  id?: string
  to_agent?: string
  failure?: string | null
  response?: ResponseView | null
}
export type RunView = {
  id?: string
  state?: string
  started_by?: { name?: string } | null
  error?: string | null
  response?: ResponseView | null
}

/** POST /api/inquiries: a new message, and one run of it by `agent_id`. */
export function sendInquiry(http: Http, addresses: DeskAddresses, session: string, inquiry: NewInquiryRequest): Promise<Reply> {
  return postAs(http, addresses, session, '/api/inquiries', inquiry)
}

/** POST /api/inquiries/<id>/runs: the same message, unchanged, to an agent again. */
export function sendAgain(http: Http, addresses: DeskAddresses, session: string, inquiryId: string, agentId: string): Promise<Reply> {
  return postAs(http, addresses, session, `/api/inquiries/${encodeURIComponent(inquiryId)}/runs`, { agent_id: agentId })
}

/** GET /api/inquiries/<id>: the inquiry with its runs. */
export function readInquiry(http: Http, addresses: DeskAddresses, session: string, inquiryId: string): Promise<Reply> {
  return getAs(http, addresses, session, `/api/inquiries/${encodeURIComponent(inquiryId)}`)
}

/**
 * The inquiry's first run once it is no longer running, or, when `waitMs` ran out first, the run as it was last
 * read (still running, or none yet), so the caller can say how far it got.
 */
export type Waited = { ended: true; run: RunView } | { ended: false; lastRead: RunView | undefined }

/** Reads the inquiry every half second until its first run has ended or `waitMs` has passed. */
export async function waitForRun(http: Http, addresses: DeskAddresses, session: string, inquiryId: string, waitMs: number): Promise<Waited> {
  let run: RunView | undefined
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const read = (await readInquiry(http, addresses, session, inquiryId)).body.inquiry as { runs?: RunView[] } | undefined
    run = read?.runs?.[0]
    if (run !== undefined && run.state !== 'running') return { ended: true, run }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { ended: false, lastRead: run }
}

// ---------- cases ----------

/** GET /api/cases. */
export function readCaseList(http: Http, addresses: DeskAddresses, session: string): Promise<Reply> {
  return getAs(http, addresses, session, '/api/cases')
}

/** GET /api/cases/<id>. */
export function readCase(http: Http, addresses: DeskAddresses, session: string, caseId: string): Promise<Reply> {
  return getAs(http, addresses, session, `/api/cases/${encodeURIComponent(caseId)}`)
}

// ---------- traces ----------

/** GET /api/traces: every person's runs, newest first, to a session granted traces:read. */
export function readTraceList(http: Http, addresses: DeskAddresses, session: string): Promise<Reply> {
  return getAs(http, addresses, session, '/api/traces')
}

/** GET /api/traces/<run id>: the run's inquiry, and the run with the agent's whole response, steps included. */
export function readTrace(http: Http, addresses: DeskAddresses, session: string, runId: string): Promise<Reply> {
  return getAs(http, addresses, session, `/api/traces/${encodeURIComponent(runId)}`)
}
