// The requests both gates make to the identity provider (gate/gate.ts and gate/stack-gate.ts): the steps of a
// sign-in through the desk client, standing in for a browser and the desk's server, and the token endpoint's
// grants (refresh, token exchange, client credentials). Each function makes its request and returns what was
// answered; whether an answer meets a statement is decided by ../src/judge.ts, and what a failure means is the
// calling gate's to say. Nothing here reports, and no answer is retried.

import type { Body, Discovery } from './judge.ts'

export type Http = { timeoutMs: number }

export async function request(http: Http, url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(http.timeoutMs), ...init })
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('response is not a JSON object')
  return value as Record<string, unknown>
}

export type Answer = { status: number; body: Body }

type TokenEndpoint = Pick<Discovery, 'token_endpoint'>

/** A form posted to the token endpoint, and its answer. */
export async function tokenRequest(http: Http, discovery: TokenEndpoint, form: Record<string, string>): Promise<Answer> {
  const response = await request(http, discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  return { status: response.status, body: await json(response) }
}

/** Holds cookies by name. Keycloak's sign-in cookies are all on the realm's path, so path and domain are not tracked. */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  take(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0] ?? ''
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (value === '' || /;\s*max-age=0\b/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

// ---------- a sign-in through the desk client ----------

/** The desk client as a sign-in names it. */
type Desk = { clientId: string; redirectUri: string }

/** The authorization request for the Authorization Code flow with an S256 challenge, at `endpoint` (an address the caller can reach). */
export function authorizationUrl(endpoint: string, desk: Desk, scope: string, state: string, codeChallenge: string): string {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: desk.clientId,
    redirect_uri: desk.redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

/** Requests the sign-in page, keeping its cookies in `jar`. */
export async function openSignInPage(http: Http, url: string, jar: CookieJar): Promise<{ status: number; html: string }> {
  const page = await request(http, url)
  jar.take(page)
  return { status: page.status, html: await page.text() }
}

/** Posts the sign-in form at `action` (an address the caller can reach) with the cookies in `jar`. The redirect is read, not followed. */
export async function postSignInForm(http: Http, action: string, jar: CookieJar, username: string, password: string): Promise<{ status: number; location: string | null }> {
  const posted = await request(http, action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: '' }).toString(),
  })
  await posted.arrayBuffer()
  return { status: posted.status, location: posted.headers.get('location') }
}

/** Exchanges the code from the redirect, with the desk client's secret and the code verifier. */
export function exchangeCode(http: Http, discovery: TokenEndpoint, desk: Desk, secrets: { deskSecret: string }, code: string, verifier: string): Promise<Answer> {
  return tokenRequest(http, discovery, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: desk.redirectUri,
    code_verifier: verifier,
    client_id: desk.clientId,
    client_secret: secrets.deskSecret,
  })
}

// ---------- refreshes, exchanges and client credentials ----------

/** A refresh by the desk client, the one client that holds a refresh token. */
export function refresh(http: Http, desk: { clientId: string }, discovery: TokenEndpoint, secrets: { deskSecret: string }, refreshToken: string, scope: string): Promise<Answer> {
  return tokenRequest(http, discovery, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope,
    client_id: desk.clientId,
    client_secret: secrets.deskSecret,
  })
}

/** RFC 8693, as the agents send it. A client with no secret (`secret` undefined) sends none. */
export function exchange(http: Http, discovery: TokenEndpoint, clientId: string, secret: string | undefined, subjectToken: string, audience: string, scopes: readonly string[]): Promise<Answer> {
  return tokenRequest(http, discovery, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience,
    scope: scopes.join(' '),
    client_id: clientId,
    ...(secret === undefined ? {} : { client_secret: secret }),
  })
}

export function clientCredentials(http: Http, discovery: TokenEndpoint, clientId: string, secret: string | undefined, scope: string | undefined): Promise<Answer> {
  return tokenRequest(http, discovery, {
    grant_type: 'client_credentials',
    client_id: clientId,
    ...(secret === undefined ? {} : { client_secret: secret }),
    ...(scope === undefined ? {} : { scope }),
  })
}
