// Gate for the identity provider (platform/identity/README.md).
//
// Answers one question: does a running `identity` service, started from realm/lab-realm.json, decide who gets
// which token the way the lab relies on? The statements, in the order they are checked (Gn is the
// statement's name in this file and in the gate's output):
//   G14  The realm's discovery document answers from inside the stack's network, names the browser-facing
//        issuer, and points at a key set that answers with keys.
//   G1   Each person signs in through the real Authorization Code flow with PKCE (S256), asking for openid and
//        every scope the desk client may ask for: the sign-in page is requested, its form is posted with a
//        cookie jar, the redirect to the callback is read but not followed, and the code is exchanged with the
//        client secret and the code verifier. The token is granted exactly the scopes the person's role grants.
//   G2   That access token is a JWS signed with RS256 by a key at jwks_uri, and carries the issuer, exactly the
//        granted scopes' audiences, client_id desk, the fixed sub, preferred_username, name, roles holding the
//        person's one staff role and no other lab role, no realm_access or resource_access, and the realm's
//        lifetime (G14). The ID token is signed the same way, names the issuer and the client, and carries the
//        same roles.
//   G3   A refresh with scope=openid <one granted scope> gives a token for that scope's audiences alone.
//   G4   The refresh token that refresh returned still reaches the whole grant, and another granted scope.
//   G5   A refresh for a scope the role does not grant is answered 200 with the scope and its audiences absent.
//   G11, G12  Each machine obtains a token by client credentials for its scope, with its fixed sub, its name and
//        its one role; each is refused the scopes its client may not ask for: a tool server's, and the one only
//        the orchestrator may ask for.
//   G7, G8, G11  Each agent exchanges the token it is called with for a token for the one service it calls, holding
//        every scope it asked for and no other custom scope.
//   G15  The orchestrator exchanges each caller's token for it for a token for each sub-agent it calls, with
//        that sub-agent's scope and no other custom scope: one audience, the orchestrator as client, the person, the
//        same expiry.
//   G16  Each sub-agent exchanges the orchestrator's token for it for a token for its own tool server, as it does
//        a token it is called with directly: the second exchange of the chain.
//   G9   An agent (the orchestrator among them) is refused a person's token it is not an audience of.
//   G13, G14  The token endpoint refuses the password grant for desk and client credentials for desk and the two
//        audience-only clients; the authorization endpoint refuses a request with no PKCE challenge, with the
//        plain method, and for the implicit flow (response_type=token).
// Last, the answers the throwaway Keycloak runs did not observe on this path, so that a wrong expectation there
// leaves every statement above checked:
//   G10  The desk client, both audience-only clients and both machines cannot exchange a token.
//   G9   An agent is refused a scope its client may not ask for: the other kind of agent's scopes, a scope of its
//        own tool server that its client may not ask for (an intake agent asking for cases:lookup), a scope only
//        the orchestrator may ask for, and, for the orchestrator, a tool server's scope and the label expert's
//        scope for a direct caller.
//   G6   The desk client asking for a scope it may not ask for (a tool server's, or one only the orchestrator may
//        ask for) is refused invalid_scope, at a refresh and at the authorization endpoint.
//
// Whether a token or an answer meets a statement is decided by the pure functions of ../src/judge.ts; this file
// fetches, verifies signatures (jose) and reports. The requests themselves, and the cookie jar, are in
// ../src/provider.ts, which the stack gate shares; what stays here of transport is the rewrite of front-channel
// URLs (toTransport) and the order of the requests. The gate stops at the first statement that does not hold.
//
// The gate stands in for the browser while running inside the network. The browser reaches the provider at
// the issuer's origin (http://localhost:8090), which inside a container is the container itself, so every
// front-channel URL the provider hands out on that origin is sent to IDENTITY_URL instead, with its path and
// query kept (toTransport below). Back-channel URLs from discovery are used as given.
//
// Usage: node gate.ts <config.json>
//   Environment: IDENTITY_URL (where the gate reaches the provider), and the password or secret variable each
//   user, agent and machine in the config names, and the desk client's (clientSecretVariable).
// Exit codes: 0 = every statement holds, 1 = a statement does not hold, 2 = the gate itself could not run.
// The JSON report goes to stdout; progress goes to stderr. Neither carries a password, secret, code or token:
// a token appears only as its verified header and decoded claims.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import {
  checkAuthorizationRefused,
  checkDiscovery,
  checkErrorAnswer,
  checkExchangedToken,
  checkGrantedScopes,
  checkIdTokenRoles,
  checkKeySet,
  checkMachineToken,
  checkNarrowedToken,
  checkPersonToken,
  checkRefused,
  checkSignInPage,
  checkSignInRedirect,
  checkTokenAnswer,
  checkUngrantedScope,
  errorOf,
  type Body,
  type Claims,
  type Discovery,
  type Violation,
} from '../src/judge.ts'
import { codeChallengeS256, codeVerifier } from '../src/pkce.ts'
import {
  authorizationUrl,
  clientCredentials,
  CookieJar,
  exchange,
  exchangeCode,
  json,
  openSignInPage,
  postSignInForm,
  refresh,
  request,
  tokenRequest,
  type Answer,
  type Http,
} from '../src/provider.ts'

// ---------- configuration ----------

type UserConfig = { username: string; passwordVariable: string; id: string; staffRole: string; granted: string[] }
/** `forbiddenScopes`: scopes its own audience names that its client may not ask for. */
type AgentConfig = { clientId: string; secretVariable: string; audience: string; scopes: string[]; forbiddenScopes: string[]; subject: { username: string; scope: string } }
type MachineConfig = { clientId: string; secretVariable: string; id: string; role: string; scope: string; forbiddenScopes: string[] }
/** A sub-agent the orchestrator calls (an entry of `agents`), the scope it asks for there, and whether only the orchestrator's client may ask for that scope. */
type DelegationConfig = { audience: string; scope: string; onlyThisClient: boolean }
type OrchestratorConfig = {
  clientId: string
  secretVariable: string
  /** The scope of a caller's token for the orchestrator. */
  scope: string
  /** The people whose token for the orchestrator it exchanges. */
  callers: string[]
  delegations: DelegationConfig[]
  /** Scopes its client may not ask for. */
  forbiddenScopes: string[]
}

type GateConfig = {
  issuer: string
  clientId: string
  clientSecretVariable: string
  redirectUri: string
  lifetimeSeconds: number
  requestTimeoutMs: number
  /** Each custom scope and the audiences it names. */
  scopes: Map<string, string[]>
  deskScopes: string[]
  deskForbiddenScopes: string[]
  staffRoles: string[]
  machineRoles: string[]
  users: UserConfig[]
  agents: AgentConfig[]
  orchestrator: OrchestratorConfig
  machines: MachineConfig[]
  audienceOnlyClients: string[]
  exchangeOffDescription: string
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
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isRecords = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(isRecord)

function loadConfig(path: string): GateConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const scopes = new Map<string, string[]>()
  for (const [name, audiences] of Object.entries(field(raw, 'scopes', isRecord, 'an object'))) {
    if (!isStrings(audiences)) throw new UsageError(`config: scopes.${name} must be a list of strings`)
    scopes.set(name, audiences)
  }
  const config: GateConfig = {
    issuer: field(raw, 'issuer', isString, 'a string'),
    clientId: field(raw, 'clientId', isString, 'a string'),
    clientSecretVariable: field(raw, 'clientSecretVariable', isString, 'a string'),
    redirectUri: field(raw, 'redirectUri', isString, 'a string'),
    lifetimeSeconds: field(raw, 'lifetimeSeconds', isNumber, 'a number'),
    requestTimeoutMs: field(raw, 'requestTimeoutMs', isNumber, 'a number'),
    scopes,
    deskScopes: field(raw, 'deskScopes', isStrings, 'a list of strings'),
    deskForbiddenScopes: field(raw, 'deskForbiddenScopes', isStrings, 'a list of strings'),
    staffRoles: field(raw, 'staffRoles', isStrings, 'a list of strings'),
    machineRoles: field(raw, 'machineRoles', isStrings, 'a list of strings'),
    users: field(raw, 'users', isRecords, 'a list of objects').map((user) => ({
      username: field(user, 'username', isString, 'a string'),
      passwordVariable: field(user, 'passwordVariable', isString, 'a string'),
      id: field(user, 'id', isString, 'a string'),
      staffRole: field(user, 'staffRole', isString, 'a string'),
      granted: field(user, 'granted', isStrings, 'a list of strings'),
    })),
    agents: field(raw, 'agents', isRecords, 'a list of objects').map((agent) => {
      const subject = field(agent, 'subject', isRecord, 'an object')
      return {
        clientId: field(agent, 'clientId', isString, 'a string'),
        secretVariable: field(agent, 'secretVariable', isString, 'a string'),
        audience: field(agent, 'audience', isString, 'a string'),
        scopes: field(agent, 'scopes', isStrings, 'a list of strings'),
        // Scopes of its own audience that the agent's client may not ask for, whose refusals the gate states (G9). Optional; none when absent.
        forbiddenScopes: agent.forbiddenScopes === undefined ? [] : field(agent, 'forbiddenScopes', isStrings, 'a list of strings'),
        subject: { username: field(subject, 'username', isString, 'a string'), scope: field(subject, 'scope', isString, 'a string') },
      }
    }),
    orchestrator: loadOrchestrator(field(raw, 'orchestrator', isRecord, 'an object')),
    machines: field(raw, 'machines', isRecords, 'a list of objects').map((machine) => ({
      clientId: field(machine, 'clientId', isString, 'a string'),
      secretVariable: field(machine, 'secretVariable', isString, 'a string'),
      id: field(machine, 'id', isString, 'a string'),
      role: field(machine, 'role', isString, 'a string'),
      scope: field(machine, 'scope', isString, 'a string'),
      // Scopes the machine's client may not ask for, whose refusals the gate states (G11). Optional; none when absent.
      forbiddenScopes: machine.forbiddenScopes === undefined ? [] : field(machine, 'forbiddenScopes', isStrings, 'a list of strings'),
    })),
    audienceOnlyClients: field(raw, 'audienceOnlyClients', isStrings, 'a list of strings'),
    exchangeOffDescription: field(raw, 'exchangeOffDescription', isString, 'a string'),
  }
  const orchestrator = config.orchestrator
  for (const name of [
    ...config.deskScopes,
    ...config.deskForbiddenScopes,
    ...config.users.flatMap((user) => user.granted),
    orchestrator.scope,
    ...orchestrator.forbiddenScopes,
    ...config.machines.flatMap((machine) => machine.forbiddenScopes),
    ...config.agents.flatMap((agent) => agent.forbiddenScopes),
    ...orchestrator.delegations.map((delegation) => delegation.scope),
  ]) {
    if (!config.scopes.has(name)) throw new UsageError(`config: ${name} is not in scopes`)
  }
  for (const delegation of orchestrator.delegations) {
    if (!config.agents.some((agent) => agent.clientId === delegation.audience)) throw new UsageError(`config: orchestrator.delegations names ${delegation.audience}, which is not in agents`)
  }
  for (const caller of orchestrator.callers) {
    if (!config.users.some((user) => user.username === caller)) throw new UsageError(`config: orchestrator.callers names ${caller}, who is not in users`)
  }
  if (config.users.length === 0) throw new UsageError('config: users is empty')
  return config
}

function loadOrchestrator(raw: Record<string, unknown>): OrchestratorConfig {
  return {
    clientId: field(raw, 'clientId', isString, 'a string'),
    secretVariable: field(raw, 'secretVariable', isString, 'a string'),
    scope: field(raw, 'scope', isString, 'a string'),
    callers: field(raw, 'callers', isStrings, 'a list of strings'),
    delegations: field(raw, 'delegations', isRecords, 'a list of objects').map((delegation) => ({
      audience: field(delegation, 'audience', isString, 'a string'),
      scope: field(delegation, 'scope', isString, 'a string'),
      onlyThisClient: field(delegation, 'onlyThisClient', (value): value is boolean => typeof value === 'boolean', 'true or false'),
    })),
    forbiddenScopes: field(raw, 'forbiddenScopes', isStrings, 'a list of strings'),
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

const held: string[] = []
function holds(statement: string): void {
  held.push(statement)
  process.stderr.write(`gate: holds: ${statement}\n`)
}

/** Holds `statement` if the judge found nothing; otherwise fails it on the first departure. */
function judged(statement: string, violations: readonly Violation[]): void {
  const first = violations[0]
  if (first !== undefined) throw new StatementFailed(`${statement}: ${first.statement}`, first.detail)
  holds(statement)
}

// ---------- HTTP ----------

/** Sends a front-channel URL on the browser's origin to the origin the gate reaches the provider at. */
function toTransport(url: string, browserOrigin: string, transportOrigin: string): string {
  const parsed = new URL(url)
  if (parsed.origin !== browserOrigin && parsed.origin !== transportOrigin) {
    throw new StatementFailed('G14 front-channel URL on the browser origin', `${parsed.origin} is neither ${browserOrigin} nor ${transportOrigin}`)
  }
  return `${transportOrigin}${parsed.pathname}${parsed.search}`
}

/** The answer's error code and description, for the report and for a failure's detail. */
const refusal = (answer: Answer): { status: number } & ReturnType<typeof errorOf> => ({ status: answer.status, ...errorOf(answer.body) })

// ---------- discovery and keys ----------

type Keys = ReturnType<typeof createRemoteJWKSet>

/** GET a URL and its JSON body. A provider that does not answer fails `statement`. */
async function getJson(http: Http, url: string, statement: string): Promise<Answer> {
  let response: Response
  try {
    response = await request(http, url)
  } catch (error) {
    throw new StatementFailed(statement, `request failed: ${(error as Error).message}`)
  }
  return { status: response.status, body: response.status === 200 ? await json(response) : {} }
}

async function discover(http: Http, transport: string, config: GateConfig): Promise<Discovery> {
  const realmPath = new URL(config.issuer).pathname
  const url = `${transport}${realmPath}/.well-known/openid-configuration`
  const statement = `G14 the discovery document at ${url} answers 200, names its endpoints, and names issuer ${config.issuer}`
  const answer = await getJson(http, url, statement)
  const { discovery, violations } = checkDiscovery(answer.status, answer.body, config.issuer)
  judged(statement, violations)
  if (discovery === null) throw new Error('checkDiscovery held without a discovery document')

  const jwksStatement = `G14 jwks_uri ${discovery.jwks_uri} answers 200 with keys`
  const jwks = await getJson(http, discovery.jwks_uri, jwksStatement)
  judged(jwksStatement, checkKeySet(jwks.status, jwks.body))
  return discovery
}

/** A field checkTokenAnswer has already found to be a non-empty string. */
function tokenField(body: Body, name: string): string {
  const value = body[name]
  if (typeof value !== 'string') throw new Error(`${name} is not a string after checkTokenAnswer held`)
  return value
}

type Verified = { header: Record<string, unknown>; claims: Claims }

/** The token's RS256 signature against the published keys (jose refuses any other alg). Returns its header and claims; the token itself is never reported. */
async function verifyToken(token: string, keys: Keys, statement: string): Promise<Verified> {
  try {
    const header = decodeProtectedHeader(token)
    const { payload } = await jwtVerify(token, keys, { algorithms: ['RS256'] })
    holds(statement)
    return { header: { alg: header.alg, kid: header.kid, typ: header.typ }, claims: { ...payload } }
  } catch (error) {
    throw new StatementFailed(statement, (error as Error).message)
  }
}

/** checkTokenAnswer for `fields`, then the access token's signature. */
async function verifiedAnswer(answer: Answer, keys: Keys, statement: string, fields: readonly string[] = ['access_token']): Promise<Verified> {
  judged(statement, checkTokenAnswer(answer.status, answer.body, fields))
  return verifyToken(tokenField(answer.body, 'access_token'), keys, `${statement}: the access token is a JWS signed with RS256 by a key at jwks_uri`)
}

// ---------- the sign-in ----------

type Secrets = { deskSecret: string; passwords: Map<string, string>; clientSecrets: Map<string, string> }

type SignedIn = { accessToken: Verified; idToken: string; refreshToken: string }

/** The Authorization Code flow with PKCE, as a browser and the desk's server would run it, asking for `scope`. */
async function signIn(http: Http, transport: string, config: GateConfig, discovery: Discovery, keys: Keys, user: UserConfig, secrets: Secrets, scope: string): Promise<SignedIn> {
  const who = user.username
  const browserOrigin = new URL(config.issuer).origin
  const jar = new CookieJar()
  const verifier = codeVerifier(randomBytes(32))
  const state = randomBytes(16).toString('base64url')

  const authorize = authorizationUrl(toTransport(discovery.authorization_endpoint, browserOrigin, transport), config, scope, state, codeChallengeS256(verifier))
  const page = await openSignInPage(http, authorize, jar)
  const shown = checkSignInPage(page.status, page.html)
  judged(`G1 ${who}: the authorization endpoint answers with the sign-in page`, shown.violations)
  if (shown.action === null) throw new Error('checkSignInPage held without an action')
  const action = shown.action

  const password = secrets.passwords.get(who)
  if (password === undefined) throw new UsageError(`no password for ${who}`)
  const posted = await postSignInForm(http, toTransport(action, browserOrigin, transport), jar, who, password)
  const redirect = checkSignInRedirect(posted, action, config.redirectUri, state)
  judged(`G1 ${who}: the sign-in form redirects to ${config.redirectUri} with a code and the state`, redirect.violations)
  if (redirect.code === null) throw new Error('checkSignInRedirect held without a code')

  const exchanged = await exchangeCode(http, discovery, config, secrets, redirect.code, verifier)
  const accessToken = await verifiedAnswer(exchanged, keys, `G1 ${who}: the token endpoint exchanges the code for an access token, an ID token and a refresh token`, [
    'access_token',
    'id_token',
    'refresh_token',
  ])
  return { accessToken, idToken: tokenField(exchanged.body, 'id_token'), refreshToken: tokenField(exchanged.body, 'refresh_token') }
}

/** The ID token's signature, issuer and audience, then the roles the desk's server reads from it. Returns its roles claim. */
async function checkIdToken(idToken: string, keys: Keys, config: GateConfig, user: UserConfig): Promise<unknown> {
  const who = user.username
  const signed = `G14 ${who}: the ID token is a JWS signed with RS256 by a key at jwks_uri, for issuer ${config.issuer} and audience ${config.clientId}`
  let claims: Claims
  try {
    const { payload } = await jwtVerify(idToken, keys, { algorithms: ['RS256'], issuer: config.issuer, audience: config.clientId })
    claims = { ...payload }
  } catch (error) {
    throw new StatementFailed(signed, (error as Error).message)
  }
  holds(signed)
  judged(`G14 ${who}: the ID token carries roles holding ${user.staffRole} and no other lab role`, checkIdTokenRoles(claims, user.staffRole, labRoles(config)))
  return claims.roles
}

const labRoles = (config: GateConfig): string[] => [...config.staffRoles, ...config.machineRoles]
const customScopes = (config: GateConfig): string[] => [...config.scopes.keys()]
const audiencesOf = (config: GateConfig, scopes: readonly string[]): string[] => [...new Set(scopes.flatMap((scope) => config.scopes.get(scope) ?? []))]

// ---------- refreshes, exchanges and client credentials ----------

function clientSecret(secrets: Secrets, clientId: string): string {
  const secret = secrets.clientSecrets.get(clientId)
  if (secret === undefined) throw new UsageError(`no secret for client ${clientId}`)
  return secret
}

// ---------- the authorization endpoint's refusals ----------

async function authorizationRefused(
  http: Http,
  transport: string,
  config: GateConfig,
  discovery: Discovery,
  statement: string,
  parameters: Record<string, string>,
  expectedError?: string,
): Promise<{ status: number; error: string | null }> {
  const browserOrigin = new URL(config.issuer).origin
  const url = new URL(toTransport(discovery.authorization_endpoint, browserOrigin, transport))
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'openid', state: 'gate-refusal', ...parameters }).toString()
  const response = await request(http, url.toString())
  await response.arrayBuffer()
  const { error, violations } = checkAuthorizationRefused({ status: response.status, location: response.headers.get('location') }, url.toString(), expectedError)
  judged(statement, violations)
  return { status: response.status, error }
}

// ---------- main ----------

type TokenEntry = { header: Record<string, unknown>; claims: Claims }

type Report = {
  passed: boolean
  failed: string | null
  transport: string
  discovery: Discovery | null
  users: { username: string; header: Record<string, unknown>; claims: Claims; idTokenRoles: unknown; narrowed: Record<string, TokenEntry> }[]
  machines: { clientId: string; header: Record<string, unknown>; claims: Claims }[]
  exchanges: { clientId: string; subject: string; header: Record<string, unknown>; claims: Claims }[]
  passwordGrant: { status: number; error: unknown } | null
  refused: Record<string, { status: number; error: unknown; error_description?: unknown }>
  held: string[]
}

type Subject = { name: string; token: string; claims: Claims; audiences: string[] }

async function main(): Promise<number> {
  const configPath = process.argv[2]
  if (configPath === undefined) throw new UsageError('usage: node gate.ts <config.json>')
  const config = loadConfig(configPath)
  const transport = new URL(requiredEnv('IDENTITY_URL')).origin
  const secrets: Secrets = {
    deskSecret: requiredEnv(config.clientSecretVariable),
    passwords: new Map(config.users.map((user) => [user.username, requiredEnv(user.passwordVariable)])),
    clientSecrets: new Map([...config.agents, config.orchestrator, ...config.machines].map((client) => [client.clientId, requiredEnv(client.secretVariable)])),
  }
  const http: Http = { timeoutMs: config.requestTimeoutMs }
  const report: Report = { passed: false, failed: null, transport, discovery: null, users: [], machines: [], exchanges: [], passwordGrant: null, refused: {}, held }
  const custom = customScopes(config)
  const roles = labRoles(config)
  const audiencesOfScope = (scope: string): string[] => config.scopes.get(scope) ?? []

  try {
    const discovery = await discover(http, transport, config)
    report.discovery = discovery
    const keys = createRemoteJWKSet(new URL(discovery.jwks_uri))
    const everyDeskScope = ['openid', ...config.deskScopes].join(' ')

    // The token each person's session gives for one scope (G3), kept for the exchanges (G7 to G10).
    const narrowed = new Map<string, { token: string; claims: Claims }>()
    const narrowedKey = (username: string, scope: string): string => `${username} ${scope}`
    // The first person's refresh token, kept for G6.
    let firstRefreshToken: string | null = null

    // ---------- G1, G2: each person signs in; G3, G4, G5: a token per target ----------
    for (const user of config.users) {
      const who = user.username
      const session = await signIn(http, transport, config, discovery, keys, user, secrets, everyDeskScope)
      firstRefreshToken ??= session.refreshToken
      const { header, claims } = session.accessToken
      const entry: Report['users'][number] = { username: who, header, claims, idTokenRoles: null, narrowed: {} }
      report.users.push(entry)
      judged(`G1 ${who}: the sign-in grants exactly ${user.granted.join(' ')}`, checkGrantedScopes(claims.scope, user.granted, custom))
      judged(
        `G2 ${who}: the access token carries the issuer, the granted scopes' audiences, client_id, the fixed sub, preferred_username, name, roles with ${user.staffRole} alone of the lab roles, no realm_access or resource_access, and the lifetime`,
        checkPersonToken(claims, {
          issuer: config.issuer,
          clientId: config.clientId,
          lifetimeSeconds: config.lifetimeSeconds,
          sub: user.id,
          username: who,
          audiences: audiencesOf(config, user.granted),
          staffRole: user.staffRole,
          labRoles: roles,
        }),
      )
      entry.idTokenRoles = await checkIdToken(session.idToken, keys, config, user)

      for (const scope of user.granted) {
        const statement = `G3 ${who}: a refresh with scope=openid ${scope} gives a token for ${audiencesOfScope(scope).join(' and ')} alone`
        const answer = await refresh(http, config, discovery, secrets, session.refreshToken, `openid ${scope}`)
        const verified = await verifiedAnswer(answer, keys, `${statement}: answered`, ['access_token', 'refresh_token'])
        judged(statement, checkNarrowedToken(verified.claims, { scope, audiences: audiencesOfScope(scope), customScopes: custom }))
        entry.narrowed[scope] = verified
        narrowed.set(narrowedKey(who, scope), { token: tokenField(answer.body, 'access_token'), claims: verified.claims })

        // G4: the refresh token that refresh returned keeps the session's whole reach.
        const returned = tokenField(answer.body, 'refresh_token')
        const wholeStatement = `G4 ${who}: the refresh token returned with the ${scope} token, asked for every desk scope, still grants exactly ${user.granted.join(' ')}`
        const whole = await verifiedAnswer(await refresh(http, config, discovery, secrets, returned, everyDeskScope), keys, `${wholeStatement}: answered`)
        judged(wholeStatement, checkGrantedScopes(whole.claims.scope, user.granted, custom))
        for (const other of user.granted.filter((name) => name !== scope)) {
          const nextStatement = `G4 ${who}: the refresh token returned with the ${scope} token obtains a token for ${other}`
          const next = await verifiedAnswer(await refresh(http, config, discovery, secrets, returned, `openid ${other}`), keys, `${nextStatement}: answered`)
          judged(nextStatement, checkNarrowedToken(next.claims, { scope: other, audiences: audiencesOfScope(other), customScopes: custom }))
        }
      }

      for (const scope of config.deskScopes.filter((name) => !user.granted.includes(name))) {
        const statement = `G5 ${who}: a refresh for ${scope}, which the role does not grant, is answered 200 without ${scope} or its audiences`
        const answer = await refresh(http, config, discovery, secrets, session.refreshToken, `openid ${scope}`)
        let claims: Claims | undefined
        if (answer.status === 200) claims = (await verifiedAnswer(answer, keys, `${statement}: answered`)).claims
        judged(statement, checkUngrantedScope(answer.status, claims, { scope, audiences: audiencesOfScope(scope) }))
      }
    }

    // ---------- G11, G12: the machines, by client credentials ----------
    const machineTokens = new Map<string, { token: string; claims: Claims }>()
    for (const machine of config.machines) {
      const secret = clientSecret(secrets, machine.clientId)
      const statement = `G11/G12 ${machine.clientId}: client credentials with scope=${machine.scope} give a token with aud, client_id, the fixed sub, preferred_username service-account-${machine.clientId}, a name, roles with ${machine.role} and no staff role`
      const answer = await clientCredentials(http, discovery, machine.clientId, secret, machine.scope)
      const verified = await verifiedAnswer(answer, keys, `${statement}: answered`)
      report.machines.push({ clientId: machine.clientId, ...verified })
      judged(
        statement,
        checkMachineToken(verified.claims, {
          issuer: config.issuer,
          clientId: machine.clientId,
          sub: machine.id,
          username: `service-account-${machine.clientId}`,
          audiences: audiencesOfScope(machine.scope),
          scope: machine.scope,
          role: machine.role,
          staffRoles: config.staffRoles,
        }),
      )
      machineTokens.set(machine.clientId, { token: tokenField(answer.body, 'access_token'), claims: verified.claims })

      for (const forbiddenScope of machine.forbiddenScopes) {
        const refused = await clientCredentials(http, discovery, machine.clientId, secret, forbiddenScope)
        report.refused[`${machine.clientId}_${forbiddenScope}`] = refusal(refused)
        judged(
          `G11 ${machine.clientId}: asking for ${forbiddenScope}, which its client may not ask for, is refused invalid_scope`,
          checkErrorAnswer(refused.status, refused.body, { status: 400, error: 'invalid_scope' }),
        )
      }
    }

    // ---------- G7, G8, G11: each agent exchanges the token it is called with ----------
    const subjectOf = (username: string, scope: string): { token: string; claims: Claims } => {
      const found = narrowed.get(narrowedKey(username, scope))
      if (found === undefined) throw new UsageError(`config: no ${scope} token for ${username}; ${username} is not granted ${scope}`)
      return found
    }
    // The people's tokens the agents are called with (the two intake agents are called with the same one).
    const people: Subject[] = []
    for (const agent of config.agents) {
      const name = `${agent.subject.username}'s ${agent.subject.scope} token`
      if (people.some((entry) => entry.name === name)) continue
      people.push({ name, ...subjectOf(agent.subject.username, agent.subject.scope), audiences: audiencesOfScope(agent.subject.scope) })
    }
    const machines: Subject[] = []
    for (const machine of config.machines) {
      const token = machineTokens.get(machine.clientId)
      if (token !== undefined) machines.push({ name: `${machine.clientId}'s ${machine.scope} token`, ...token, audiences: audiencesOfScope(machine.scope) })
    }

    for (const agent of config.agents) {
      const secret = clientSecret(secrets, agent.clientId)
      for (const subject of [...people, ...machines].filter((entry) => entry.audiences.includes(agent.clientId))) {
        const statement = `G7/G8/G11 ${agent.clientId} exchanges ${subject.name} for audience=${agent.audience} scope=${agent.scopes.join(' ')}: aud ${agent.audience} alone, client_id and azp ${agent.clientId}, the subject's sub, preferred_username, name, roles and exp, every scope asked for and no other custom scope, no refresh token`
        const answer = await exchange(http, discovery, agent.clientId, secret, subject.token, agent.audience, agent.scopes)
        const verified = await verifiedAnswer(answer, keys, `${statement}: answered`)
        report.exchanges.push({ clientId: agent.clientId, subject: subject.name, ...verified })
        judged(statement, checkExchangedToken(answer.body, verified.claims, subject.claims, { issuer: config.issuer, clientId: agent.clientId, audience: agent.audience, scopes: agent.scopes, customScopes: custom }))
      }
    }

    // ---------- G15, G16: the chain, caller to orchestrator to sub-agent to tool server ----------
    const orchestrator = config.orchestrator
    const orchestratorSecret = clientSecret(secrets, orchestrator.clientId)
    const agentNamed = (clientId: string): AgentConfig => {
      const found = config.agents.find((agent) => agent.clientId === clientId)
      if (found === undefined) throw new UsageError(`config: ${clientId} is not in agents`)
      return found
    }
    for (const caller of orchestrator.callers) {
      const subject: Subject = { name: `${caller}'s ${orchestrator.scope} token`, ...subjectOf(caller, orchestrator.scope), audiences: audiencesOfScope(orchestrator.scope) }
      for (const delegation of orchestrator.delegations) {
        // G15: the first exchange, by the orchestrator, for the sub-agent.
        const statement = `G15 ${orchestrator.clientId} exchanges ${subject.name} for audience=${delegation.audience} scope=${delegation.scope}: aud ${delegation.audience} alone, client_id and azp ${orchestrator.clientId}, the subject's sub, preferred_username, name, roles and exp, the scope asked for and no other custom scope, no refresh token`
        const answer = await exchange(http, discovery, orchestrator.clientId, orchestratorSecret, subject.token, delegation.audience, [delegation.scope])
        const verified = await verifiedAnswer(answer, keys, `${statement}: answered`)
        report.exchanges.push({ clientId: orchestrator.clientId, subject: subject.name, ...verified })
        judged(
          statement,
          checkExchangedToken(answer.body, verified.claims, subject.claims, { issuer: config.issuer, clientId: orchestrator.clientId, audience: delegation.audience, scopes: [delegation.scope], customScopes: custom }),
        )

        // G16: the second exchange, by the sub-agent, of the token the orchestrator called it with.
        const subAgent = agentNamed(delegation.audience)
        const delegated = { name: `${orchestrator.clientId}'s ${delegation.scope} token for ${caller}`, claims: verified.claims }
        const secondStatement = `G16 ${subAgent.clientId} exchanges ${delegated.name} for audience=${subAgent.audience} scope=${subAgent.scopes.join(' ')}: aud ${subAgent.audience} alone, client_id and azp ${subAgent.clientId}, the subject's sub, preferred_username, name, roles and exp, every scope asked for and no other custom scope, no refresh token`
        const second = await exchange(http, discovery, subAgent.clientId, clientSecret(secrets, subAgent.clientId), tokenField(answer.body, 'access_token'), subAgent.audience, subAgent.scopes)
        const secondVerified = await verifiedAnswer(second, keys, `${secondStatement}: answered`)
        report.exchanges.push({ clientId: subAgent.clientId, subject: delegated.name, ...secondVerified })
        judged(
          secondStatement,
          checkExchangedToken(second.body, secondVerified.claims, delegated.claims, { issuer: config.issuer, clientId: subAgent.clientId, audience: subAgent.audience, scopes: subAgent.scopes, customScopes: custom }),
        )
      }
    }

    // ---------- G9: a person's token an agent is not an audience of ----------
    for (const agent of config.agents) {
      const secret = clientSecret(secrets, agent.clientId)
      for (const subject of people.filter((entry) => !entry.audiences.includes(agent.clientId))) {
        const answer = await exchange(http, discovery, agent.clientId, secret, subject.token, agent.audience, agent.scopes)
        report.refused[`${agent.clientId}_not_audience_of_${subject.name}`] = refusal(answer)
        judged(
          `G9 ${agent.clientId}: exchanging ${subject.name}, which it is not an audience of, is refused 403 "Client is not within the token audience"`,
          checkErrorAnswer(answer.status, answer.body, { status: 403, error: 'access_denied', description: 'Client is not within the token audience' }),
        )
      }
    }
    // The orchestrator, given the tokens for the other agents, asking for its first sub-agent.
    const firstDelegation = orchestrator.delegations[0]
    if (firstDelegation === undefined) throw new UsageError('config: orchestrator.delegations is empty')
    for (const subject of people.filter((entry) => !entry.audiences.includes(orchestrator.clientId))) {
      const answer = await exchange(http, discovery, orchestrator.clientId, orchestratorSecret, subject.token, firstDelegation.audience, [firstDelegation.scope])
      report.refused[`${orchestrator.clientId}_not_audience_of_${subject.name}`] = refusal(answer)
      judged(
        `G9 ${orchestrator.clientId}: exchanging ${subject.name}, which it is not an audience of, is refused 403 "Client is not within the token audience"`,
        checkErrorAnswer(answer.status, answer.body, { status: 403, error: 'access_denied', description: 'Client is not within the token audience' }),
      )
    }

    // ---------- G13, G14: refused grants and authorization requests ----------
    const firstUser = config.users[0]
    if (firstUser === undefined) throw new UsageError('config: users is empty')
    const password = await tokenRequest(http, discovery, {
      grant_type: 'password',
      username: firstUser.username,
      password: secrets.passwords.get(firstUser.username) ?? '',
      scope: 'openid',
      client_id: config.clientId,
      client_secret: secrets.deskSecret,
    })
    report.passwordGrant = { status: password.status, error: password.body.error }
    judged('G13 the token endpoint refuses the password grant for desk', checkRefused(password.status, password.body))
    const deskCredentials = await clientCredentials(http, discovery, config.clientId, secrets.deskSecret, undefined)
    report.refused.client_credentials = refusal(deskCredentials)
    judged('G13 the token endpoint refuses the client-credentials grant for desk', checkRefused(deskCredentials.status, deskCredentials.body))
    for (const clientId of config.audienceOnlyClients) {
      const answer = await clientCredentials(http, discovery, clientId, undefined, undefined)
      report.refused[`${clientId}_client_credentials`] = refusal(answer)
      judged(`G13 the token endpoint refuses the client-credentials grant for ${clientId}`, checkRefused(answer.status, answer.body))
    }
    report.refused.no_code_challenge = await authorizationRefused(http, transport, config, discovery, 'G14 the authorization endpoint refuses a request with no code_challenge', {
      response_type: 'code',
    })
    report.refused.plain_code_challenge = await authorizationRefused(http, transport, config, discovery, 'G14 the authorization endpoint refuses code_challenge_method=plain', {
      response_type: 'code',
      code_challenge: codeVerifier(randomBytes(32)),
      code_challenge_method: 'plain',
    })
    report.refused.implicit = await authorizationRefused(http, transport, config, discovery, 'G14 the authorization endpoint refuses response_type=token', {
      response_type: 'token',
      nonce: 'gate-refusal',
      code_challenge: codeChallengeS256(codeVerifier(randomBytes(32))),
      code_challenge_method: 'S256',
    })

    // ---------- Last, the answers the throwaway runs did not observe on this path ----------

    // G10: no client but the agents can exchange.
    const firstAgent = config.agents[0]
    if (firstAgent === undefined) throw new UsageError('config: agents is empty')
    const deskToken = subjectOf(firstAgent.subject.username, firstAgent.subject.scope)
    {
      // A token issued to desk itself, so the audience rule would not refuse it: only token exchange being off does.
      const answer = await exchange(http, discovery, config.clientId, secrets.deskSecret, deskToken.token, firstAgent.audience, firstAgent.scopes)
      report.refused[`${config.clientId}_exchange`] = refusal(answer)
      judged(
        `G10 ${config.clientId} exchanging a token issued to itself is refused: token exchange is off`,
        checkErrorAnswer(answer.status, answer.body, { status: 400, error: 'invalid_request', description: config.exchangeOffDescription }),
      )
    }
    for (const clientId of config.audienceOnlyClients) {
      // These clients have no secret anyone holds, so the refusal can only be of the client itself.
      const answer = await exchange(http, discovery, clientId, undefined, deskToken.token, clientId, firstAgent.scopes)
      report.refused[`${clientId}_exchange`] = refusal(answer)
      judged(`G10 ${clientId} cannot exchange a token`, checkRefused(answer.status, answer.body))
    }
    for (const machine of config.machines) {
      const own = machineTokens.get(machine.clientId)
      if (own === undefined) throw new UsageError(`no token for ${machine.clientId}`)
      const answer = await exchange(http, discovery, machine.clientId, clientSecret(secrets, machine.clientId), own.token, firstAgent.audience, firstAgent.scopes)
      report.refused[`${machine.clientId}_exchange`] = refusal(answer)
      judged(
        `G10 ${machine.clientId} exchanging a token issued to itself is refused: token exchange is off`,
        checkErrorAnswer(answer.status, answer.body, { status: 400, error: 'invalid_request', description: config.exchangeOffDescription }),
      )
    }

    // G9: an agent asking for a scope its client may not ask for (the other kind of agent's scopes).
    for (const agent of config.agents) {
      const own = people.find((entry) => entry.audiences.includes(agent.clientId))
      const otherAgent = config.agents.find((entry) => entry.audience !== agent.audience)
      if (own === undefined || otherAgent === undefined) continue
      const answer = await exchange(http, discovery, agent.clientId, clientSecret(secrets, agent.clientId), own.token, otherAgent.audience, otherAgent.scopes)
      report.refused[`${agent.clientId}_scope_${otherAgent.scopes.join('_')}`] = refusal(answer)
      judged(
        `G9 ${agent.clientId}: asking for ${otherAgent.scopes.join(' ')}, which its client may not ask for, is refused invalid_scope`,
        checkErrorAnswer(answer.status, answer.body, { status: 400, error: 'invalid_scope' }),
      )
    }

    // G9: an agent asking for a scope of its own audience that its client may not ask for.
    for (const agent of config.agents.filter((entry) => entry.forbiddenScopes.length > 0)) {
      const own = people.find((entry) => entry.audiences.includes(agent.clientId))
      if (own === undefined) throw new UsageError(`config: no person's token names ${agent.clientId}, so its forbiddenScopes cannot be asked for`)
      for (const forbiddenScope of agent.forbiddenScopes) {
        const answer = await exchange(http, discovery, agent.clientId, clientSecret(secrets, agent.clientId), own.token, agent.audience, [forbiddenScope])
        report.refused[`${agent.clientId}_scope_${forbiddenScope}`] = refusal(answer)
        judged(
          `G9 ${agent.clientId}: asking for ${forbiddenScope}, which its client may not ask for, is refused invalid_scope`,
          checkErrorAnswer(answer.status, answer.body, { status: 400, error: 'invalid_scope' }),
        )
      }
    }

    // G9: an agent other than the orchestrator asking for a scope only the orchestrator's client may ask for.
    for (const delegation of orchestrator.delegations.filter((entry) => entry.onlyThisClient)) {
      for (const agent of config.agents) {
        const own = people.find((entry) => entry.audiences.includes(agent.clientId))
        if (own === undefined) continue
        const answer = await exchange(http, discovery, agent.clientId, clientSecret(secrets, agent.clientId), own.token, delegation.audience, [delegation.scope])
        report.refused[`${agent.clientId}_scope_${delegation.scope}`] = refusal(answer)
        judged(
          `G9 ${agent.clientId}: asking for ${delegation.scope}, which only ${orchestrator.clientId} may ask for, is refused invalid_scope`,
          checkErrorAnswer(answer.status, answer.body, { status: 400, error: 'invalid_scope' }),
        )
      }
    }

    // G9: the orchestrator asking for a scope its client may not ask for, with a token it is an audience of.
    const orchestratorCaller = orchestrator.callers[0]
    if (orchestratorCaller === undefined) throw new UsageError('config: orchestrator.callers is empty')
    for (const forbiddenScope of orchestrator.forbiddenScopes) {
      const own = subjectOf(orchestratorCaller, orchestrator.scope)
      const audience = audiencesOfScope(forbiddenScope)[0]
      if (audience === undefined) throw new UsageError(`config: ${forbiddenScope} names no audience`)
      const answer = await exchange(http, discovery, orchestrator.clientId, orchestratorSecret, own.token, audience, [forbiddenScope])
      report.refused[`${orchestrator.clientId}_scope_${forbiddenScope}`] = refusal(answer)
      judged(
        `G9 ${orchestrator.clientId}: asking for ${forbiddenScope}, which its client may not ask for, is refused invalid_scope`,
        checkErrorAnswer(answer.status, answer.body, { status: 400, error: 'invalid_scope' }),
      )
    }

    // G6: the desk client asking for a scope it may not ask for, at a refresh and at the authorization endpoint.
    if (firstRefreshToken === null) throw new UsageError('config: users is empty')
    for (const forbidden of config.deskForbiddenScopes) {
      const refreshed = await refresh(http, config, discovery, secrets, firstRefreshToken, `openid ${forbidden}`)
      report.refused[`desk_refresh_${forbidden}`] = refusal(refreshed)
      judged(`G6 a refresh by the desk client asking for ${forbidden} is refused invalid_scope`, checkErrorAnswer(refreshed.status, refreshed.body, { status: 400, error: 'invalid_scope' }))
      report.refused[`desk_authorize_${forbidden}`] = await authorizationRefused(
        http,
        transport,
        config,
        discovery,
        `G6 the authorization endpoint refuses the desk client asking for ${forbidden}, with invalid_scope`,
        { response_type: 'code', scope: `openid ${forbidden}`, code_challenge: codeChallengeS256(codeVerifier(randomBytes(32))), code_challenge_method: 'S256' },
        'invalid_scope',
      )
    }
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
  // The exit code is set and the process left to end by itself, so the whole report reaches a pipe:
  // process.exit would cut a report longer than the pipe's buffer.
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`gate: could not run: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  },
)
