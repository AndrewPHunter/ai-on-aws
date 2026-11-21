// Gate for the identity provider (platform/identity/README.md).
//
// Answers one question: does a running `identity` service issue the tokens the lab relies on?
//   1. Its realm's discovery document answers from inside the stack's network, names the browser-facing
//      issuer, and points at a token endpoint and key set that answer from inside the network.
//   2. Each realm user can sign in through the real Authorization Code flow with PKCE (S256): the sign-in
//      page is requested, its form is posted with a cookie jar, the redirect to the callback is read but not
//      followed, and the code is exchanged with the client secret and the code verifier.
//   3. Each access token is a JWS signed with RS256 by a key at jwks_uri, and carries the claims in the
//      README's claims table. Each ID token is signed the same way, names the issuer and the client, and
//      carries the user's roles.
//   4. The token endpoint refuses the password grant.
//
// The gate stands in for the browser while running inside the network. The browser reaches the provider at
// the issuer's origin (http://localhost:8090), which inside a container is the container itself, so every
// front-channel URL the provider hands out on that origin is sent to IDENTITY_URL instead, with its path and
// query kept (toTransport below). Back-channel URLs from discovery are used as given.
//
// Usage: node gate.ts <config.json>
//   Environment: IDENTITY_URL (where the gate reaches the provider), IDENTITY_DESK_CLIENT_SECRET, and the
//   password variable each user in the config names.
// Exit codes: 0 = every statement holds, 1 = a statement does not hold, 2 = the gate itself could not run.
// The JSON report goes to stdout; progress goes to stderr. Neither carries a password, secret, code or token.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import { checkClaims, checkIdTokenRoles } from '../src/claims.ts'
import { signInFormAction } from '../src/login-form.ts'
import { codeChallengeS256, codeVerifier } from '../src/pkce.ts'

// ---------- configuration ----------

type UserConfig = { username: string; passwordVariable: string; isReviewer: boolean }

type GateConfig = {
  issuer: string
  clientId: string
  redirectUri: string
  audiences: string[]
  reviewerRole: string
  lifetimeSeconds: number
  requestTimeoutMs: number
  users: UserConfig[]
}

class UsageError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new UsageError(`missing required environment variable ${name}`)
  return value
}

function field<T>(raw: Record<string, unknown>, name: string, check: (value: unknown) => value is T, kind: string): T {
  const value = raw[name]
  if (!check(value)) throw new UsageError(`config: ${name} must be ${kind}`)
  return value
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== ''
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const isRecords = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null)

function loadConfig(path: string): GateConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return {
    issuer: field(raw, 'issuer', isString, 'a string'),
    clientId: field(raw, 'clientId', isString, 'a string'),
    redirectUri: field(raw, 'redirectUri', isString, 'a string'),
    audiences: field(raw, 'audiences', isStrings, 'a list of strings'),
    reviewerRole: field(raw, 'reviewerRole', isString, 'a string'),
    lifetimeSeconds: field(raw, 'lifetimeSeconds', isNumber, 'a number'),
    requestTimeoutMs: field(raw, 'requestTimeoutMs', isNumber, 'a number'),
    users: field(raw, 'users', isRecords, 'a list of objects').map((user) => ({
      username: field(user, 'username', isString, 'a string'),
      passwordVariable: field(user, 'passwordVariable', isString, 'a string'),
      isReviewer: field(user, 'isReviewer', isBoolean, 'true or false'),
    })),
  }
}

// ---------- statements ----------

/** A statement of the contract that does not hold. The gate stops at the first one. */
class StatementFailed extends Error {
  readonly statement: string
  constructor(statement: string, detail: string) {
    super(`${statement}: ${detail}`)
    this.statement = statement
  }
}

function must(condition: boolean, statement: string, detail: string): asserts condition {
  if (!condition) throw new StatementFailed(statement, detail)
}

const held: string[] = []
function holds(statement: string): void {
  held.push(statement)
  process.stderr.write(`gate: holds: ${statement}\n`)
}

// ---------- HTTP ----------

/** Sends a front-channel URL on the browser's origin to the origin the gate reaches the provider at. */
function toTransport(url: string, browserOrigin: string, transportOrigin: string): string {
  const parsed = new URL(url)
  if (parsed.origin !== browserOrigin && parsed.origin !== transportOrigin) {
    throw new StatementFailed('front-channel URL on the browser origin', `${parsed.origin} is neither ${browserOrigin} nor ${transportOrigin}`)
  }
  return `${transportOrigin}${parsed.pathname}${parsed.search}`
}

/** Holds cookies by name. Keycloak's sign-in cookies are all on the realm's path, so path and domain are not tracked. */
class CookieJar {
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

type Http = { timeoutMs: number }

async function request(http: Http, url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(http.timeoutMs), ...init })
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('response is not a JSON object')
  return value as Record<string, unknown>
}

// ---------- the checks ----------

type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

async function discover(http: Http, transport: string, config: GateConfig): Promise<Discovery> {
  const realmPath = new URL(config.issuer).pathname
  const url = `${transport}${realmPath}/.well-known/openid-configuration`
  const statement = `discovery document at ${url} answers 200`
  let response: Response
  try {
    response = await request(http, url)
  } catch (error) {
    throw new StatementFailed(statement, `request failed: ${(error as Error).message}`)
  }
  must(response.status === 200, statement, `status ${response.status}`)
  const body = await json(response)
  holds(statement)

  const text = (name: keyof Discovery): string => {
    const value = body[name]
    must(typeof value === 'string' && value !== '', `discovery names ${name}`, `got ${JSON.stringify(value)}`)
    return value
  }
  const discovery: Discovery = {
    issuer: text('issuer'),
    authorization_endpoint: text('authorization_endpoint'),
    token_endpoint: text('token_endpoint'),
    jwks_uri: text('jwks_uri'),
  }
  must(discovery.issuer === config.issuer, 'discovery issuer', `expected ${config.issuer}, got ${discovery.issuer}`)
  holds(`discovery issuer is ${config.issuer}`)

  const jwksStatement = `jwks_uri ${discovery.jwks_uri} answers 200 with keys`
  let jwks: Response
  try {
    jwks = await request(http, discovery.jwks_uri)
  } catch (error) {
    throw new StatementFailed(jwksStatement, `request failed: ${(error as Error).message}`)
  }
  must(jwks.status === 200, jwksStatement, `status ${jwks.status}`)
  const keys = (await json(jwks)).keys
  must(Array.isArray(keys) && keys.length > 0, jwksStatement, 'no keys')
  holds(jwksStatement)
  return discovery
}

type Secrets = { clientSecret: string; passwords: Map<string, string> }

/** The Authorization Code flow with PKCE, as a browser and the desk's server would run it. Returns the access and ID tokens. */
async function signIn(http: Http, transport: string, config: GateConfig, discovery: Discovery, user: UserConfig, secrets: Secrets): Promise<{ accessToken: string; idToken: string }> {
  const who = user.username
  const browserOrigin = new URL(config.issuer).origin
  const jar = new CookieJar()
  const verifier = codeVerifier(randomBytes(32))
  const state = randomBytes(16).toString('base64url')

  const authorize = new URL(toTransport(discovery.authorization_endpoint, browserOrigin, transport))
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid',
    state,
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: 'S256',
  }).toString()
  const page = await request(http, authorize.toString())
  jar.take(page)
  const pageStatement = `${who}: the authorization endpoint answers with the sign-in page`
  must(page.status === 200, pageStatement, `status ${page.status}`)
  let action: string
  try {
    action = signInFormAction(await page.text())
  } catch (error) {
    throw new StatementFailed(pageStatement, (error as Error).message)
  }
  holds(pageStatement)

  const password = secrets.passwords.get(who)
  if (password === undefined) throw new UsageError(`no password for ${who}`)
  const posted = await request(http, toTransport(action, browserOrigin, transport), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ username: who, password, credentialId: '' }).toString(),
  })
  await posted.arrayBuffer()
  const postStatement = `${who}: the sign-in form redirects to ${config.redirectUri} with a code and the state`
  must(posted.status === 302 || posted.status === 303, postStatement, `status ${posted.status} (a sign-in page shown again means the password or the account is wrong)`)
  const location = posted.headers.get('location') ?? ''
  const callback = new URL(location, action)
  must(`${callback.origin}${callback.pathname}` === config.redirectUri, postStatement, `redirected to ${callback.origin}${callback.pathname}`)
  const code = callback.searchParams.get('code')
  must(code !== null && code !== '', postStatement, `no code; error ${JSON.stringify(callback.searchParams.get('error'))}`)
  must(callback.searchParams.get('state') === state, postStatement, 'state does not match')
  holds(postStatement)

  const exchange = await request(http, discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
      client_id: config.clientId,
      client_secret: secrets.clientSecret,
    }).toString(),
  })
  const exchangeStatement = `${who}: the token endpoint exchanges the code for an access token`
  const tokens = await json(exchange)
  must(exchange.status === 200, exchangeStatement, `status ${exchange.status}, error ${JSON.stringify(tokens.error)}`)
  const accessToken = tokens.access_token
  must(typeof accessToken === 'string' && accessToken !== '', exchangeStatement, 'no access_token in the response')
  const idToken = tokens.id_token
  must(typeof idToken === 'string' && idToken !== '', exchangeStatement, 'no id_token in the response')
  holds(exchangeStatement)
  return { accessToken, idToken }
}

/** The ID token's signature, issuer and audience, then the roles the desk's server reads from it. Returns its roles claim. */
async function checkIdToken(idToken: string, keys: ReturnType<typeof createRemoteJWKSet>, config: GateConfig, user: UserConfig): Promise<unknown> {
  const who = user.username
  const signed = `${who}: the ID token is a JWS signed with RS256 by a key at jwks_uri, for issuer ${config.issuer} and audience ${config.clientId}`
  let claims: Record<string, unknown>
  try {
    const { payload } = await jwtVerify(idToken, keys, { algorithms: ['RS256'], issuer: config.issuer, audience: config.clientId })
    claims = { ...payload }
  } catch (error) {
    throw new StatementFailed(signed, (error as Error).message)
  }
  holds(signed)
  const first = checkIdTokenRoles(claims, { reviewerRole: config.reviewerRole, isReviewer: user.isReviewer })[0]
  if (first !== undefined) throw new StatementFailed(`${who}: ${first.statement}`, first.detail)
  holds(`${who}: the ID token carries roles, with ${config.reviewerRole} ${user.isReviewer ? 'present' : 'absent'}`)
  return claims.roles
}

async function verifyToken(token: string, keys: ReturnType<typeof createRemoteJWKSet>, who: string): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown> }> {
  const statement = `${who}: the access token is a JWS signed with RS256 by a key at jwks_uri`
  let header: Record<string, unknown>
  try {
    header = { ...decodeProtectedHeader(token) }
  } catch (error) {
    throw new StatementFailed(statement, `not a JWS: ${(error as Error).message}`)
  }
  must(header.alg === 'RS256', statement, `alg is ${JSON.stringify(header.alg)}`)
  try {
    const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'] })
    holds(statement)
    return { header: { alg: header.alg, kid: header.kid, typ: header.typ }, claims: { ...payload } }
  } catch (error) {
    throw new StatementFailed(statement, (error as Error).message)
  }
}

async function passwordGrantRefused(http: Http, config: GateConfig, discovery: Discovery, user: UserConfig, secrets: Secrets): Promise<{ status: number; error: unknown }> {
  const statement = 'the token endpoint refuses the password grant'
  const response = await request(http, discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username: user.username,
      password: secrets.passwords.get(user.username) ?? '',
      scope: 'openid',
      client_id: config.clientId,
      client_secret: secrets.clientSecret,
    }).toString(),
  })
  const body = await json(response)
  must(response.status >= 400 && response.status < 500 && body.access_token === undefined, statement, `status ${response.status}`)
  holds(statement)
  return { status: response.status, error: body.error }
}

// ---------- main ----------

type Report = {
  passed: boolean
  failed: string | null
  transport: string
  discovery: Discovery | null
  users: { username: string; header: Record<string, unknown>; claims: Record<string, unknown>; idTokenRoles: unknown }[]
  passwordGrant: { status: number; error: unknown } | null
  held: string[]
}

async function main(): Promise<number> {
  const configPath = process.argv[2]
  if (configPath === undefined) throw new UsageError('usage: node gate.ts <config.json>')
  const config = loadConfig(configPath)
  const transport = new URL(requiredEnv('IDENTITY_URL')).origin
  const secrets: Secrets = {
    clientSecret: requiredEnv('IDENTITY_DESK_CLIENT_SECRET'),
    passwords: new Map(config.users.map((user) => [user.username, requiredEnv(user.passwordVariable)])),
  }
  const http: Http = { timeoutMs: config.requestTimeoutMs }
  const report: Report = { passed: false, failed: null, transport, discovery: null, users: [], passwordGrant: null, held }

  try {
    const discovery = await discover(http, transport, config)
    report.discovery = discovery
    const keys = createRemoteJWKSet(new URL(discovery.jwks_uri))

    for (const user of config.users) {
      const { accessToken, idToken } = await signIn(http, transport, config, discovery, user, secrets)
      const { header, claims } = await verifyToken(accessToken, keys, user.username)
      const entry: Report['users'][number] = { username: user.username, header, claims, idTokenRoles: null }
      report.users.push(entry)
      const violations = checkClaims(claims, {
        issuer: config.issuer,
        audiences: config.audiences,
        clientId: config.clientId,
        reviewerRole: config.reviewerRole,
        isReviewer: user.isReviewer,
        lifetimeSeconds: config.lifetimeSeconds,
      })
      const first = violations[0]
      if (first !== undefined) throw new StatementFailed(`${user.username}: claim ${first.statement}`, first.detail)
      holds(`${user.username}: every claim in the claims table holds`)
      entry.idTokenRoles = await checkIdToken(idToken, keys, config, user)
    }

    const firstUser = config.users[0]
    if (firstUser === undefined) throw new UsageError('config: users is empty')
    report.passwordGrant = await passwordGrantRefused(http, config, discovery, firstUser, secrets)
    report.passed = true
  } catch (error) {
    if (!(error instanceof StatementFailed)) throw error
    report.failed = error.message
    process.stderr.write(`gate: does not hold: ${error.message}\n`)
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.passed ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`gate: could not run: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  },
)
