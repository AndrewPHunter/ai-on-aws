// Whether a token or an answer from the identity provider meets a statement of the identity gate
// (platform/identity/gate/gate.ts). Each function is pure: it is given claims already decoded from a token whose
// signature the gate has verified, or the status and parsed body of an answer, and returns every departure it
// finds. An empty list means the statement holds.
//
// A departure's detail names claims, status codes and error codes only. It never holds a token, a refresh token,
// a code, a secret or a password, whatever the input carries.

import { signInFormAction } from './login-form.ts'

export type Violation = { statement: string; detail: string }

export type Claims = Readonly<Record<string, unknown>>

/** A parsed JSON body of an answer from the token endpoint; what it holds is not trusted. */
export type Body = Readonly<Record<string, unknown>>

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

const describe = (value: unknown): string => (value === undefined ? 'missing' : JSON.stringify(value))

const sorted = (values: Iterable<string>): string[] => [...values].sort()

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  JSON.stringify(sorted(new Set(a))) === JSON.stringify(sorted(new Set(b)))

/** RFC 7519: aud is one string or a list of strings. Absent is no audience. Anything else is null. */
function audiencesOf(aud: unknown): string[] | null {
  if (aud === undefined) return []
  if (typeof aud === 'string') return [aud]
  if (Array.isArray(aud) && aud.every((entry) => typeof entry === 'string')) return aud
  return null
}

/** RFC 6749 section 3.3: scope is a space-separated list. Absent is no scope. Anything but a string is null. */
function scopesOf(scope: unknown): string[] | null {
  if (scope === undefined) return []
  if (typeof scope !== 'string') return null
  return scope.split(' ').filter((entry) => entry !== '')
}

/** The departures of a token's aud from exactly the given audiences, in any order. */
function exactAudiences(claims: Claims, expected: readonly string[], statement: string): Violation[] {
  const audiences = audiencesOf(claims.aud)
  if (audiences === null || !sameSet(audiences, expected)) {
    return [{ statement, detail: `expected exactly ${JSON.stringify(sorted(expected))}, got ${describe(claims.aud)}` }]
  }
  return []
}

/** The departures of a token's roles from: a list of strings holding `role` and none of `forbidden`. */
function rolesHold(claims: Claims, role: string, forbidden: readonly string[], prefix: string): Violation[] {
  const roles = claims.roles
  if (!Array.isArray(roles) || !roles.every((entry) => typeof entry === 'string')) {
    return [{ statement: `${prefix}roles is a list of strings`, detail: `got ${describe(roles)}` }]
  }
  const violations: Violation[] = []
  if (!roles.includes(role)) {
    violations.push({ statement: `${prefix}roles holds ${role}`, detail: `${role} not in ${JSON.stringify(roles)}` })
  }
  const present = forbidden.filter((name) => name !== role && roles.includes(name))
  if (present.length > 0) {
    violations.push({ statement: `${prefix}roles holds no other lab role`, detail: `${present.join(', ')} in ${JSON.stringify(roles)}` })
  }
  return violations
}

// ---------- G1: the scopes a sign-in grants ----------

/**
 * G1. The custom scopes in a token's scope claim are exactly `expected`. Scopes that are not custom (openid,
 * profile, email) are not judged. `customScopes` is every scope the realm defines for a capability.
 */
export function checkGrantedScopes(scope: unknown, expected: readonly string[], customScopes: readonly string[]): Violation[] {
  const scopes = scopesOf(scope)
  if (scopes === null) return [{ statement: 'scope is a space-separated string', detail: `got ${describe(scope)}` }]
  const granted = scopes.filter((name) => customScopes.includes(name))
  const missing = expected.filter((name) => !granted.includes(name))
  const extra = granted.filter((name) => !expected.includes(name))
  const violations: Violation[] = []
  if (missing.length > 0) violations.push({ statement: 'every scope the role grants is granted', detail: `missing ${missing.join(' ')}; scope ${describe(scope)}` })
  if (extra.length > 0) violations.push({ statement: 'no scope the role does not grant is granted', detail: `extra ${extra.join(' ')}; scope ${describe(scope)}` })
  return violations
}

// ---------- G2 and G14: a person's access token from the sign-in, and its ID token ----------

export type PersonExpectations = {
  issuer: string
  clientId: string
  lifetimeSeconds: number
  /** The user's fixed id, which is the token's sub. */
  sub: string
  username: string
  /** Exactly the audiences of the scopes granted. */
  audiences: readonly string[]
  /** The person's one staff role. */
  staffRole: string
  /** Every lab role (staff and machine); the token holds none but `staffRole`. */
  labRoles: readonly string[]
}

/** G2, with the issuer, audience and lifetime of G14. A person's access token, as the sign-in issues it. */
export function checkPersonToken(claims: Claims, expected: PersonExpectations): Violation[] {
  const violations: Violation[] = []
  const fail = (statement: string, detail: string): void => {
    violations.push({ statement, detail })
  }
  if (claims.iss !== expected.issuer) fail('iss', `expected ${JSON.stringify(expected.issuer)}, got ${describe(claims.iss)}`)
  violations.push(...exactAudiences(claims, expected.audiences, 'aud is the audiences of the scopes granted'))
  if (claims.client_id !== expected.clientId) fail('client_id', `expected ${JSON.stringify(expected.clientId)}, got ${describe(claims.client_id)}`)
  if (claims.sub !== expected.sub) fail('sub is the fixed id', `expected ${JSON.stringify(expected.sub)}, got ${describe(claims.sub)}`)
  if (claims.preferred_username !== expected.username) {
    fail('preferred_username', `expected ${JSON.stringify(expected.username)}, got ${describe(claims.preferred_username)}`)
  }
  if (!nonEmptyString(claims.name)) fail('name', `expected a non-empty string, got ${describe(claims.name)}`)
  violations.push(...rolesHold(claims, expected.staffRole, expected.labRoles, ''))
  for (const name of ['realm_access', 'resource_access'] as const) {
    if (claims[name] !== undefined) fail(`no ${name}`, `${name} is present`)
  }
  const { exp, iat } = claims
  if (typeof exp !== 'number' || typeof iat !== 'number' || exp - iat !== expected.lifetimeSeconds) {
    fail('lifetime', `expected exp - iat = ${expected.lifetimeSeconds}, got exp ${describe(exp)}, iat ${describe(iat)}`)
  }
  return violations
}

/** G14. The ID token carries the top-level roles the client reads, holding the person's staff role and no other lab role. */
export function checkIdTokenRoles(claims: Claims, staffRole: string, labRoles: readonly string[]): Violation[] {
  return rolesHold(claims, staffRole, labRoles, 'ID token ')
}

// ---------- G3 and G4: a token narrowed to one scope by a refresh ----------

export type NarrowedExpectations = {
  /** The one scope asked for. */
  scope: string
  /** Exactly that scope's audiences. */
  audiences: readonly string[]
  customScopes: readonly string[]
}

/** G3 and G4. A token from a refresh with `scope=openid <scope>`: aud is that scope's audiences, and scope holds it alone of the custom scopes. */
export function checkNarrowedToken(claims: Claims, expected: NarrowedExpectations): Violation[] {
  const violations = exactAudiences(claims, expected.audiences, `aud is exactly the audiences of ${expected.scope}`)
  const scopes = scopesOf(claims.scope)
  if (scopes === null) return [...violations, { statement: 'scope is a space-separated string', detail: `got ${describe(claims.scope)}` }]
  if (!scopes.includes(expected.scope)) {
    violations.push({ statement: `scope holds ${expected.scope}`, detail: `scope ${describe(claims.scope)}` })
  }
  const others = scopes.filter((name) => name !== expected.scope && expected.customScopes.includes(name))
  if (others.length > 0) {
    violations.push({ statement: 'scope holds no other custom scope', detail: `also ${others.join(' ')}` })
  }
  return violations
}

// ---------- G5: a refresh for a scope the role does not grant ----------

export type UngrantedExpectations = {
  /** The scope asked for, which the person's role does not grant. */
  scope: string
  /** That scope's audiences, none of which the token may name. */
  audiences: readonly string[]
}

/**
 * G5. Asked for a scope the role does not grant, the token endpoint answers 200 and leaves the scope out. `claims`
 * are the decoded access token of a 200, or undefined when there was none.
 */
export function checkUngrantedScope(status: number, claims: Claims | undefined, expected: UngrantedExpectations): Violation[] {
  if (status !== 200 || claims === undefined) {
    return [{ statement: 'answered 200 with a token', detail: `status ${status}${claims === undefined ? ', no access token' : ''}` }]
  }
  const violations: Violation[] = []
  const scopes = scopesOf(claims.scope)
  if (scopes === null || scopes.includes(expected.scope)) {
    violations.push({ statement: `scope lacks ${expected.scope}`, detail: `scope ${describe(claims.scope)}` })
  }
  const audiences = audiencesOf(claims.aud)
  const named = audiences === null ? null : expected.audiences.filter((name) => audiences.includes(name))
  if (named === null || named.length > 0) {
    violations.push({ statement: `aud names no audience of ${expected.scope}`, detail: `aud ${describe(claims.aud)}` })
  }
  return violations
}

// ---------- G6, G9, G10, G11, G13: answers that refuse ----------

export type ErrorExpectations = { status: number; error: string; description?: string }

/** The error code and description of an answer, for a report: never any other field of the body. */
export function errorOf(body: Body): { error: unknown; error_description: unknown } {
  return { error: body.error, error_description: body.error_description }
}

/** G6, G9, G10, G11. The token endpoint refuses with exactly this status and error (and description, when given), and issues no token. */
export function checkErrorAnswer(status: number, body: Body, expected: ErrorExpectations): Violation[] {
  const violations: Violation[] = []
  const answer = `status ${status}, error ${describe(body.error)}, error_description ${describe(body.error_description)}`
  if (status !== expected.status) violations.push({ statement: `answered ${expected.status}`, detail: answer })
  if (body.error !== expected.error) violations.push({ statement: `error is ${expected.error}`, detail: answer })
  if (expected.description !== undefined && body.error_description !== expected.description) {
    violations.push({ statement: `error_description is "${expected.description}"`, detail: answer })
  }
  if (body.access_token !== undefined) violations.push({ statement: 'no access token is issued', detail: `status ${status}, an access_token is present` })
  return violations
}

/** G10, G13. The token endpoint refuses (a 4xx) and issues no token, whatever its reason. */
export function checkRefused(status: number, body: Body): Violation[] {
  const violations: Violation[] = []
  if (status < 400 || status >= 500) {
    violations.push({ statement: 'answered 4xx', detail: `status ${status}, error ${describe(body.error)}` })
  }
  if (body.access_token !== undefined) violations.push({ statement: 'no access token is issued', detail: `status ${status}, an access_token is present` })
  return violations
}

// ---------- G7, G8, G11, G15, G16: a token an agent obtained by exchange ----------

export type ExchangeExpectations = {
  issuer: string
  /** The agent that exchanged: the token's client_id and azp. */
  clientId: string
  /** The one audience asked for. */
  audience: string
  /** Every scope asked for. */
  scopes: readonly string[]
}

/**
 * G7, G8, G11, G15, G16. The answer to an exchange (`body`, its other fields) and the token it issued (`claims`), against the
 * token that was exchanged (`subject`): one audience, the agent as client_id and azp, the subject's identity and
 * roles, every scope asked for, the subject's expiry, and no refresh token.
 */
export function checkExchangedToken(body: Body, claims: Claims, subject: Claims, expected: ExchangeExpectations): Violation[] {
  const violations: Violation[] = []
  const fail = (statement: string, detail: string): void => {
    violations.push({ statement, detail })
  }
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') fail('token_type is Bearer', `got ${describe(body.token_type)}`)
  if (body.refresh_token !== undefined) fail('no refresh token', 'a refresh_token is present')
  if (claims.iss !== expected.issuer) fail('iss', `expected ${JSON.stringify(expected.issuer)}, got ${describe(claims.iss)}`)
  violations.push(...exactAudiences(claims, [expected.audience], `aud is ${expected.audience} alone`))
  for (const name of ['client_id', 'azp'] as const) {
    if (claims[name] !== expected.clientId) fail(`${name} is the agent`, `expected ${JSON.stringify(expected.clientId)}, got ${describe(claims[name])}`)
  }
  for (const name of ['sub', 'preferred_username', 'name'] as const) {
    if (!nonEmptyString(claims[name]) || claims[name] !== subject[name]) {
      fail(`${name} is the exchanged token's`, `expected ${describe(subject[name])}, got ${describe(claims[name])}`)
    }
  }
  const roles = claims.roles
  const subjectRoles = subject.roles
  const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  if (!isStrings(roles) || !isStrings(subjectRoles) || !sameSet(roles, subjectRoles)) {
    fail("roles are the exchanged token's", `expected ${describe(subjectRoles)}, got ${describe(roles)}`)
  }
  const scopes = scopesOf(claims.scope)
  const missing = scopes === null ? [...expected.scopes] : expected.scopes.filter((name) => !scopes.includes(name))
  if (missing.length > 0) fail('scope holds every scope asked for', `missing ${missing.join(' ')}; scope ${describe(claims.scope)}`)
  if (typeof claims.exp !== 'number' || claims.exp !== subject.exp) fail("exp is the exchanged token's", `expected ${describe(subject.exp)}, got ${describe(claims.exp)}`)
  return violations
}

// ---------- G11, G12: a machine's token by client credentials ----------

export type MachineExpectations = {
  issuer: string
  clientId: string
  /** The service account's fixed id. */
  sub: string
  /** service-account-<client>. */
  username: string
  /** Exactly the audiences of the scope asked for. */
  audiences: readonly string[]
  /** The scope asked for. */
  scope: string
  /** The machine's one role. */
  role: string
  /** Every staff role; the token holds none of them. */
  staffRoles: readonly string[]
}

/** G11, G12. A machine's access token by client credentials: its audience, client, fixed sub, name, role and scope. */
export function checkMachineToken(claims: Claims, expected: MachineExpectations): Violation[] {
  const violations: Violation[] = []
  const fail = (statement: string, detail: string): void => {
    violations.push({ statement, detail })
  }
  if (claims.iss !== expected.issuer) fail('iss', `expected ${JSON.stringify(expected.issuer)}, got ${describe(claims.iss)}`)
  violations.push(...exactAudiences(claims, expected.audiences, `aud is exactly the audiences of ${expected.scope}`))
  if (claims.client_id !== expected.clientId) fail('client_id', `expected ${JSON.stringify(expected.clientId)}, got ${describe(claims.client_id)}`)
  if (claims.sub !== expected.sub) fail('sub is the fixed id', `expected ${JSON.stringify(expected.sub)}, got ${describe(claims.sub)}`)
  if (claims.preferred_username !== expected.username) {
    fail('preferred_username', `expected ${JSON.stringify(expected.username)}, got ${describe(claims.preferred_username)}`)
  }
  if (!nonEmptyString(claims.name)) fail('name', `expected a non-empty string, got ${describe(claims.name)}`)
  violations.push(...rolesHold(claims, expected.role, expected.staffRoles, ''))
  const scopes = scopesOf(claims.scope)
  if (scopes === null || !scopes.includes(expected.scope)) fail(`scope holds ${expected.scope}`, `scope ${describe(claims.scope)}`)
  return violations
}

// ---------- G6, G14: answers of the authorization endpoint that refuse ----------

/** What an authorization endpoint answered: its status and, for a redirect, the Location header (or null). */
export type AuthorizationAnswer = { status: number; location: string | null }

/**
 * G6, G14. The authorization endpoint refuses a request: it answers 400, or redirects back with error= and without
 * a code or a token (in the query or the fragment). With `expectedError`, only a redirect carrying exactly that
 * error holds, since a 400 page does not say which error it is. `requestUrl` resolves a relative Location.
 * Returns the error the redirect carried (null for a 400 or no redirect) and the departures.
 */
export function checkAuthorizationRefused(
  answer: AuthorizationAnswer,
  requestUrl: string,
  expectedError?: string,
): { error: string | null; violations: Violation[] } {
  if (answer.status === 400 && expectedError === undefined) return { error: null, violations: [] }
  if (answer.status !== 302 && answer.status !== 303) {
    return { error: null, violations: [{ statement: expectedError === undefined ? 'answered 400 or a redirect' : 'answered with a redirect', detail: `status ${answer.status}` }] }
  }
  let back: URL
  try {
    back = new URL(answer.location ?? '', requestUrl)
  } catch {
    return { error: null, violations: [{ statement: 'the redirect names a URL', detail: `status ${answer.status}, an unreadable Location` }] }
  }
  const fields = new URLSearchParams(back.hash.startsWith('#') ? back.hash.slice(1) : back.search)
  const error = fields.get('error')
  const violations: Violation[] = []
  if (error === null) violations.push({ statement: 'the redirect carries an error', detail: `status ${answer.status}, no error` })
  else if (expectedError !== undefined && error !== expectedError) {
    violations.push({ statement: `the redirect carries error ${expectedError}`, detail: `error ${JSON.stringify(error)}` })
  }
  const given = ['code', 'access_token', 'id_token'].filter((name) => fields.has(name))
  if (given.length > 0) violations.push({ statement: 'the redirect carries no code or token', detail: `it carries ${given.join(', ')}` })
  return { error, violations }
}

// ---------- G14: discovery and the key set ----------

/** The fields of a discovery document the gate uses. */
export type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

const DISCOVERY_FIELDS = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const

/**
 * G14. The realm's discovery document answers 200, names each endpoint the gate uses, and names `issuer`. Returns
 * those fields when every one is a non-empty string (whatever the issuer), and the departures.
 */
export function checkDiscovery(status: number, body: Body, issuer: string): { discovery: Discovery | null; violations: Violation[] } {
  if (status !== 200) return { discovery: null, violations: [{ statement: 'answers 200', detail: `status ${status}` }] }
  const violations: Violation[] = []
  for (const name of DISCOVERY_FIELDS) {
    if (!nonEmptyString(body[name])) violations.push({ statement: `names ${name}`, detail: `got ${describe(body[name])}` })
  }
  if (violations.length > 0) return { discovery: null, violations }
  const discovery: Discovery = {
    issuer: String(body.issuer),
    authorization_endpoint: String(body.authorization_endpoint),
    token_endpoint: String(body.token_endpoint),
    jwks_uri: String(body.jwks_uri),
  }
  if (discovery.issuer !== issuer) violations.push({ statement: `issuer is ${issuer}`, detail: `got ${JSON.stringify(discovery.issuer)}` })
  return { discovery, violations }
}

/** G14. The key set at jwks_uri answers 200 with at least one key. */
export function checkKeySet(status: number, body: Body): Violation[] {
  if (status !== 200) return [{ statement: 'answers 200', detail: `status ${status}` }]
  if (!Array.isArray(body.keys) || body.keys.length === 0) return [{ statement: 'holds keys', detail: `keys ${Array.isArray(body.keys) ? 'is empty' : describe(body.keys)}` }]
  return []
}

// ---------- G1: the sign-in form's redirect, and answers that carry tokens ----------

/** What the sign-in form's POST answered: its status and its Location header (or null). */
export type SignInAnswer = { status: number; location: string | null }

/**
 * G1. The sign-in form, posted with the right password, redirects to `redirectUri` with a code and the state the
 * gate sent. `action` is the form's URL, against which a relative Location resolves. Returns the code (null when
 * there is none) and the departures; a departure names the address and the error, never the code.
 */
export function checkSignInRedirect(answer: SignInAnswer, action: string, redirectUri: string, state: string): { code: string | null; violations: Violation[] } {
  if (answer.status !== 302 && answer.status !== 303) {
    return { code: null, violations: [{ statement: 'answered with a redirect', detail: `status ${answer.status} (a sign-in page shown again means the password or the account is wrong)` }] }
  }
  let callback: URL
  try {
    callback = new URL(answer.location ?? '', action)
  } catch {
    return { code: null, violations: [{ statement: 'the redirect names a URL', detail: `status ${answer.status}, an unreadable Location` }] }
  }
  const violations: Violation[] = []
  const at = `${callback.origin}${callback.pathname}`
  if (at !== redirectUri) violations.push({ statement: `redirects to ${redirectUri}`, detail: `redirected to ${at}` })
  const code = callback.searchParams.get('code')
  if (code === null || code === '') violations.push({ statement: 'carries a code', detail: `no code; error ${JSON.stringify(callback.searchParams.get('error'))}` })
  if (callback.searchParams.get('state') !== state) violations.push({ statement: 'carries the state sent', detail: 'the state does not match' })
  return { code: violations.length === 0 ? code : null, violations }
}

/**
 * G1, G3, G4, G7, G8, G11, G12, G15, G16. The token endpoint answers 200 with each of `fields` (access_token, id_token,
 * refresh_token) a non-empty string. A departure names the status, the error code and the missing field only.
 */
export function checkTokenAnswer(status: number, body: Body, fields: readonly string[]): Violation[] {
  if (status !== 200) {
    return [{ statement: 'answered 200', detail: `status ${status}, error ${describe(body.error)}, error_description ${describe(body.error_description)}` }]
  }
  return fields.filter((name) => !nonEmptyString(body[name])).map((name) => ({ statement: `the answer holds ${name}`, detail: `no ${name} in the answer` }))
}

/**
 * G1. The authorization endpoint answers 200 with Keycloak's sign-in page: a form "kc-form-login" with an absolute
 * action. Returns the action (null when there is none) and the departures.
 */
export function checkSignInPage(status: number, html: string): { action: string | null; violations: Violation[] } {
  if (status !== 200) return { action: null, violations: [{ statement: 'answers 200', detail: `status ${status}` }] }
  try {
    return { action: signInFormAction(html), violations: [] }
  } catch (error) {
    return { action: null, violations: [{ statement: 'is the sign-in page', detail: (error as Error).message }] }
  }
}
