// G-unit: the identity gate's judging functions (platform/identity/src/judge.ts). For each, a token or answer
// that meets the statement passes, and each single departure from it fails with a sentence that names the
// departure and holds no token.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
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
  type Violation,
} from '../src/judge.ts'

// Stand-ins for a token and a refresh token, so a sentence that repeats one is caught.
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.SENTINEL-ACCESS-TOKEN.signature'
const REFRESH = 'eyJhbGciOiJIUzUxMiJ9.SENTINEL-REFRESH-TOKEN.signature'

const ISSUER = 'http://localhost:8090/realms/lab'
const CUSTOM = ['agents:intake', 'agents:expert', 'cases:write', 'cases:lookup', 'cases:read', 'cases:review', 'labels:search']
const LAB_ROLES = ['desk', 'medical-information', 'safety-reviewer', 'auditor', 'evaluation', 'knowledge-gate']
const STAFF_ROLES = ['desk', 'medical-information', 'safety-reviewer', 'auditor']

/** One departure, named by `statement` (a substring of the reported statement), and no token anywhere in what is reported. */
function departs(violations: readonly Violation[], statement: string, label: string): void {
  assert.equal(violations.length, 1, `${label}: expected one departure, got ${JSON.stringify(violations)}`)
  const [only] = violations
  assert.ok(only !== undefined && only.statement.includes(statement), `${label}: expected "${statement}", got ${JSON.stringify(only)}`)
  assert.ok(only.detail !== '', `${label}: the departure has no detail`)
  holdsNoToken(violations, label)
}

function holdsNoToken(violations: readonly Violation[], label: string): void {
  const text = JSON.stringify(violations)
  assert.ok(!text.includes('SENTINEL'), `${label}: a token appears in ${text}`)
}

test('G-unit. checkGrantedScopes (G1): exactly the scopes the role grants, judged on the custom scopes only', () => {
  assert.deepEqual(checkGrantedScopes('openid agents:intake agents:expert email profile', ['agents:intake', 'agents:expert'], CUSTOM), [])
  assert.deepEqual(checkGrantedScopes('openid email profile cases:read', ['cases:read'], CUSTOM), [])
  departs(checkGrantedScopes('openid agents:intake email profile', ['agents:intake', 'agents:expert'], CUSTOM), 'every scope the role grants', 'a scope missing')
  departs(checkGrantedScopes('openid agents:intake cases:read email', ['agents:intake'], CUSTOM), 'no scope the role does not grant', 'an extra scope')
  departs(checkGrantedScopes(['agents:intake'], ['agents:intake'], CUSTOM), 'space-separated', 'scope not a string')
  // A custom scope matched as a substring of another is not granted.
  departs(checkGrantedScopes('openid agents:intakes', ['agents:intake'], CUSTOM), 'every scope the role grants', 'a substring')
})

const person = {
  iss: ISSUER,
  aud: ['intake-strands', 'intake-handwritten'],
  azp: 'desk',
  client_id: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
  roles: ['desk', 'offline_access', 'default-roles-lab', 'uma_authorization'],
  scope: 'openid agents:intake email profile',
  iat: 1_800_000_000,
  exp: 1_800_000_600,
}
const personExpected = {
  issuer: ISSUER,
  clientId: 'desk',
  lifetimeSeconds: 600,
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  username: 'dana.desk',
  audiences: ['intake-handwritten', 'intake-strands'],
  staffRole: 'desk',
  labRoles: LAB_ROLES,
}

test("G-unit. checkPersonToken (G2): a person's access token from the sign-in", () => {
  assert.deepEqual(checkPersonToken(person, personExpected), [])
  // One audience may be a string.
  assert.deepEqual(checkPersonToken({ ...person, aud: 'case-system' }, { ...personExpected, audiences: ['case-system'] }), [])
  const departures: [string, Record<string, unknown>, string][] = [
    ['wrong issuer', { iss: 'http://identity:8080/realms/lab' }, 'iss'],
    ['an audience missing', { aud: ['intake-strands'] }, 'aud is the audiences'],
    ['an extra audience', { aud: ['intake-strands', 'intake-handwritten', 'case-system'] }, 'aud is the audiences'],
    ['no audience', { aud: undefined }, 'aud is the audiences'],
    ['wrong client_id', { client_id: 'intake-strands' }, 'client_id'],
    ['another sub', { sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f09' }, 'sub is the fixed id'],
    ['wrong preferred_username', { preferred_username: 'riley.reviewer' }, 'preferred_username'],
    ['no name', { name: undefined }, 'name'],
    ['roles not a list', { roles: 'desk' }, 'roles is a list of strings'],
    ['staff role missing', { roles: ['default-roles-lab', 'offline_access'] }, 'roles holds desk'],
    ['a second staff role', { roles: ['desk', 'auditor', 'default-roles-lab'] }, 'no other lab role'],
    ['a machine role', { roles: ['desk', 'evaluation'] }, 'no other lab role'],
    ['realm_access present', { realm_access: { roles: ['desk'] } }, 'no realm_access'],
    ['resource_access present', { resource_access: { desk: { roles: [] } } }, 'no resource_access'],
    ['wrong lifetime', { exp: 1_800_000_300 }, 'lifetime'],
  ]
  for (const [label, change, statement] of departures) departs(checkPersonToken({ ...person, ...change }, personExpected), statement, label)
})

test('G-unit. checkIdTokenRoles (G14): the ID token carries the staff role and no other lab role', () => {
  assert.deepEqual(checkIdTokenRoles({ roles: ['safety-reviewer', 'default-roles-lab'] }, 'safety-reviewer', LAB_ROLES), [])
  departs(checkIdTokenRoles({ sub: 'x' }, 'safety-reviewer', LAB_ROLES), 'ID token roles is a list of strings', 'roles missing')
  departs(checkIdTokenRoles({ roles: ['default-roles-lab'] }, 'safety-reviewer', LAB_ROLES), 'ID token roles holds safety-reviewer', 'staff role missing')
  departs(checkIdTokenRoles({ roles: ['safety-reviewer', 'desk'] }, 'safety-reviewer', LAB_ROLES), 'ID token roles holds no other lab role', 'another staff role')
})

test('G-unit. checkNarrowedToken (G3, G4): a refreshed token names that scope\'s audiences alone and no other custom scope', () => {
  const expected = { scope: 'agents:intake', audiences: ['intake-handwritten', 'intake-strands'], customScopes: CUSTOM }
  const token = { ...person, aud: ['intake-strands', 'intake-handwritten'], scope: 'openid agents:intake email profile' }
  assert.deepEqual(checkNarrowedToken(token, expected), [])
  assert.deepEqual(checkNarrowedToken({ aud: 'expert', scope: 'openid agents:expert profile' }, { scope: 'agents:expert', audiences: ['expert'], customScopes: CUSTOM }), [])
  departs(checkNarrowedToken({ ...token, aud: 'intake-strands' }, expected), 'aud is exactly the audiences of agents:intake', 'one of the two agents missing')
  departs(checkNarrowedToken({ ...token, aud: ['intake-strands', 'intake-handwritten', 'expert'] }, expected), 'aud is exactly', 'another audience')
  departs(checkNarrowedToken({ ...token, scope: 'openid email profile' }, expected), 'scope holds agents:intake', 'the scope missing')
  departs(checkNarrowedToken({ ...token, scope: 'openid agents:intake agents:expert' }, expected), 'no other custom scope', 'another custom scope')
})

test('G-unit. checkUngrantedScope (G5): 200, with the scope and its audiences left out', () => {
  const expected = { scope: 'agents:expert', audiences: ['expert'] }
  const token = { ...person, aud: undefined, scope: 'openid email profile' }
  assert.deepEqual(checkUngrantedScope(200, token, expected), [])
  departs(checkUngrantedScope(400, undefined, expected), 'answered 200', 'refused instead')
  departs(checkUngrantedScope(200, { ...token, scope: 'openid agents:expert email profile' }, expected), 'scope lacks agents:expert', 'the scope granted')
  departs(checkUngrantedScope(200, { ...token, aud: 'expert' }, expected), 'aud names no audience of agents:expert', 'its audience named')
})

test('G-unit. checkErrorAnswer (G6, G9, G10, G11): exactly this status, error and description, and no token', () => {
  const expected = { status: 403, error: 'access_denied', description: 'Client is not within the token audience' }
  const body = { error: 'access_denied', error_description: 'Client is not within the token audience' }
  assert.deepEqual(checkErrorAnswer(403, body, expected), [])
  assert.deepEqual(checkErrorAnswer(400, { error: 'invalid_scope', error_description: 'Invalid scopes: labels:search' }, { status: 400, error: 'invalid_scope' }), [])
  departs(checkErrorAnswer(400, body, expected), 'answered 403', 'another status')
  departs(checkErrorAnswer(403, { ...body, error: 'invalid_scope' }, expected), 'error is access_denied', 'another error')
  departs(checkErrorAnswer(403, { ...body, error_description: 'Invalid client' }, expected), 'error_description', 'another description')
  departs(checkErrorAnswer(403, { ...body, access_token: TOKEN, refresh_token: REFRESH }, expected), 'no access token is issued', 'a token issued')
  // What the report keeps of an answer: its error code and description, never a token.
  assert.deepEqual(errorOf({ ...body, access_token: TOKEN, refresh_token: REFRESH }), body)
})

test('G-unit. checkRefused (G10, G13): any 4xx, and no token', () => {
  assert.deepEqual(checkRefused(401, { error: 'unauthorized_client' }), [])
  assert.deepEqual(checkRefused(400, { error: 'unauthorized_client' }), [])
  departs(checkRefused(500, { error: 'unknown_error' }), 'answered 4xx', 'a server error')
  departs(checkRefused(200, { error: 'x' }), 'answered 4xx', 'a 200')
  departs(checkRefused(400, { error: 'x', access_token: TOKEN }), 'no access token is issued', 'a token with a 4xx')
  const both = checkRefused(200, { access_token: TOKEN, refresh_token: REFRESH, token_type: 'Bearer' })
  assert.equal(both.length, 2)
  holdsNoToken(both, 'a 200 with a token')
})

test('G-unit. checkExchangedToken (G7, G8, G11): one audience, the agent, the subject\'s identity, roles and expiry, both scopes, no refresh token', () => {
  const subject = { ...person, aud: ['intake-strands', 'intake-handwritten'] }
  const body = { access_token: TOKEN, token_type: 'Bearer', expires_in: 600, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }
  const claims = {
    ...person,
    aud: 'case-system',
    azp: 'intake-strands',
    client_id: 'intake-strands',
    roles: ['offline_access', 'desk', 'uma_authorization', 'default-roles-lab'],
    scope: 'cases:lookup email cases:write profile',
  }
  const expected = { issuer: ISSUER, clientId: 'intake-strands', audience: 'case-system', scopes: ['cases:write', 'cases:lookup'] }
  assert.deepEqual(checkExchangedToken(body, claims, subject, expected), [])
  assert.deepEqual(checkExchangedToken({ ...body, token_type: 'bearer' }, { ...claims, aud: ['case-system'] }, subject, expected), [])
  const departures: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ['not a bearer token', { token_type: 'N_A' }, {}, 'token_type is Bearer'],
    ['a refresh token', { refresh_token: REFRESH }, {}, 'no refresh token'],
    ['wrong issuer', {}, { iss: 'http://identity:8080/realms/lab' }, 'iss'],
    ['two audiences', {}, { aud: ['case-system', 'knowledge'] }, 'aud is case-system alone'],
    ['client_id not the agent', {}, { client_id: 'desk' }, 'client_id is the agent'],
    ['azp not the agent', {}, { azp: 'desk' }, 'azp is the agent'],
    ['another sub', {}, { sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01' }, "sub is the exchanged token's"],
    ['another preferred_username', {}, { preferred_username: 'riley.reviewer' }, "preferred_username is the exchanged token's"],
    ['no name', {}, { name: undefined }, "name is the exchanged token's"],
    ['other roles', {}, { roles: ['desk'] }, "roles are the exchanged token's"],
    ['a scope missing', {}, { scope: 'cases:write email profile' }, 'scope holds every scope asked for'],
    ['a later expiry', {}, { exp: 1_800_000_900 }, "exp is the exchanged token's"],
  ]
  for (const [label, bodyChange, claimsChange, statement] of departures) {
    departs(checkExchangedToken({ ...body, ...bodyChange }, { ...claims, ...claimsChange }, subject, expected), statement, label)
  }
})

test("G-unit. checkMachineToken (G11, G12): a machine's token by client credentials", () => {
  const claims = {
    iss: ISSUER,
    aud: 'expert',
    azp: 'evaluation',
    client_id: 'evaluation',
    sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f05',
    preferred_username: 'service-account-evaluation',
    name: 'Evaluation Harness',
    roles: ['evaluation', 'offline_access', 'default-roles-lab', 'uma_authorization'],
    scope: 'agents:expert email profile',
  }
  const expected = {
    issuer: ISSUER,
    clientId: 'evaluation',
    sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f05',
    username: 'service-account-evaluation',
    audiences: ['expert'],
    scope: 'agents:expert',
    role: 'evaluation',
    staffRoles: STAFF_ROLES,
  }
  assert.deepEqual(checkMachineToken(claims, expected), [])
  const departures: [string, Record<string, unknown>, string][] = [
    ['wrong issuer', { iss: 'http://identity:8080/realms/lab' }, 'iss'],
    ['another audience', { aud: ['expert', 'knowledge'] }, 'aud is exactly the audiences of agents:expert'],
    ['wrong client_id', { client_id: 'knowledge-gate' }, 'client_id'],
    ['another sub', { sub: '95bc07cf-4834-4730-a388-ac85f7f1c0c2' }, 'sub is the fixed id'],
    ['wrong preferred_username', { preferred_username: 'dana.desk' }, 'preferred_username'],
    ['no name', { name: '' }, 'name'],
    ['its role missing', { roles: ['offline_access'] }, 'roles holds evaluation'],
    ['a staff role', { roles: ['evaluation', 'desk'] }, 'no other lab role'],
    ['the scope missing', { scope: 'email profile' }, 'scope holds agents:expert'],
  ]
  for (const [label, change, statement] of departures) departs(checkMachineToken({ ...claims, ...change }, expected), statement, label)
})

test('G-unit. checkAuthorizationRefused (G6, G14): a 400, or a redirect back with an error and no code or token', () => {
  const request = 'http://identity:8080/realms/lab/protocol/openid-connect/auth?client_id=desk'
  const back = 'http://localhost:3000/auth/callback'
  assert.deepEqual(checkAuthorizationRefused({ status: 400, location: null }, request), { error: null, violations: [] })
  assert.deepEqual(checkAuthorizationRefused({ status: 302, location: `${back}?error=invalid_request&state=s` }, request), { error: 'invalid_request', violations: [] })
  assert.deepEqual(checkAuthorizationRefused({ status: 302, location: `${back}#error=unsupported_response_type&state=s` }, request), { error: 'unsupported_response_type', violations: [] })
  assert.deepEqual(checkAuthorizationRefused({ status: 302, location: `${back}?error=invalid_scope&state=s` }, request, 'invalid_scope'), { error: 'invalid_scope', violations: [] })

  departs(checkAuthorizationRefused({ status: 200, location: null }, request).violations, 'answered 400 or a redirect', 'the sign-in page instead')
  departs(checkAuthorizationRefused({ status: 302, location: `${back}?state=s` }, request).violations, 'the redirect carries an error', 'a redirect with no error')
  departs(checkAuthorizationRefused({ status: 302, location: `${back}?error=x&code=SENTINEL-CODE` }, request).violations, 'no code or token', 'a code with the error')
  departs(checkAuthorizationRefused({ status: 302, location: `${back}#error=x&access_token=${TOKEN}` }, request).violations, 'no code or token', 'a token with the error')
  // Asked for a particular error, a 400 does not say which it is, and another error does not hold.
  departs(checkAuthorizationRefused({ status: 400, location: null }, request, 'invalid_scope').violations, 'answered with a redirect', 'a 400 for invalid_scope')
  departs(checkAuthorizationRefused({ status: 302, location: `${back}?error=invalid_request` }, request, 'invalid_scope').violations, 'error invalid_scope', 'another error')
})

test('G-unit. checkDiscovery (G14): 200, each endpoint named, and the browser-facing issuer', () => {
  const body = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: 'http://identity:8080/realms/lab/protocol/openid-connect/token',
    jwks_uri: 'http://identity:8080/realms/lab/protocol/openid-connect/certs',
    userinfo_endpoint: 'http://identity:8080/realms/lab/protocol/openid-connect/userinfo',
  }
  const held = checkDiscovery(200, body, ISSUER)
  assert.deepEqual(held.violations, [])
  assert.deepEqual(held.discovery, { issuer: body.issuer, authorization_endpoint: body.authorization_endpoint, token_endpoint: body.token_endpoint, jwks_uri: body.jwks_uri })
  departs(checkDiscovery(404, {}, ISSUER).violations, 'answers 200', 'not found')
  departs(checkDiscovery(200, { ...body, issuer: 'http://identity:8080/realms/lab' }, ISSUER).violations, `issuer is ${ISSUER}`, 'the back-channel issuer')
  for (const name of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const without = checkDiscovery(200, { ...body, [name]: '' }, ISSUER)
    departs(without.violations, `names ${name}`, `${name} empty`)
    assert.equal(without.discovery, null)
  }
})

test('G-unit. checkKeySet (G14): 200 with at least one key', () => {
  assert.deepEqual(checkKeySet(200, { keys: [{ kty: 'RSA', kid: 'k1', alg: 'RS256' }] }), [])
  departs(checkKeySet(500, {}), 'answers 200', 'a server error')
  departs(checkKeySet(200, { keys: [] }), 'holds keys', 'no keys')
  departs(checkKeySet(200, {}), 'holds keys', 'keys missing')
})

const page = readFileSync(new URL('fixtures/keycloak-sign-in.html', import.meta.url), 'utf8')

test("G-unit. checkSignInPage (G1): 200 with Keycloak's sign-in form", () => {
  const held = checkSignInPage(200, page)
  assert.deepEqual(held.violations, [])
  assert.match(held.action ?? '', /^http:\/\/localhost:8090\/realms\/lab\/login-actions\/authenticate\?/)
  departs(checkSignInPage(400, page).violations, 'answers 200', 'an error page')
  const notThePage = checkSignInPage(200, '<html><body><p>We are sorry...</p></body></html>')
  departs(notThePage.violations, 'is the sign-in page', 'another page')
  assert.equal(notThePage.action, null)
})

test('G-unit. checkSignInRedirect (G1): a redirect to the callback with a code and the state sent, and no code in a sentence', () => {
  const action = 'http://localhost:8090/realms/lab/login-actions/authenticate?session_code=x'
  const callback = 'http://localhost:3000/auth/callback'
  const good = { status: 302, location: `${callback}?state=st&session_state=s&code=SENTINEL-CODE` }
  assert.deepEqual(checkSignInRedirect(good, action, callback, 'st'), { code: 'SENTINEL-CODE', violations: [] })
  const departures: [string, { status: number; location: string | null }, string][] = [
    ['the sign-in page again', { status: 200, location: null }, 'answered with a redirect'],
    ['another address', { status: 302, location: `http://localhost:3000/elsewhere?state=st&code=SENTINEL-CODE` }, `redirects to ${callback}`],
    ['no code', { status: 302, location: `${callback}?state=st&error=access_denied` }, 'carries a code'],
    ['another state', { status: 302, location: `${callback}?state=other&code=SENTINEL-CODE` }, 'carries the state sent'],
  ]
  for (const [label, answer, statement] of departures) {
    const result = checkSignInRedirect(answer, action, callback, 'st')
    departs(result.violations, statement, label)
    assert.equal(result.code, null, `${label}: a code is returned`)
  }
})

test('G-unit. checkTokenAnswer (G1, G3, G4, G7, G8, G11, G12): 200 with each field asked for, and no token in a sentence', () => {
  const body = { access_token: TOKEN, id_token: TOKEN, refresh_token: REFRESH, token_type: 'Bearer' }
  assert.deepEqual(checkTokenAnswer(200, body, ['access_token', 'id_token', 'refresh_token']), [])
  departs(checkTokenAnswer(400, { error: 'invalid_grant', error_description: 'Code not valid' }, ['access_token']), 'answered 200', 'a refusal')
  departs(checkTokenAnswer(200, { ...body, id_token: undefined }, ['access_token', 'id_token', 'refresh_token']), 'holds id_token', 'no ID token')
  departs(checkTokenAnswer(200, { ...body, refresh_token: '' }, ['access_token', 'refresh_token']), 'holds refresh_token', 'an empty refresh token')
  departs(checkTokenAnswer(200, { ...body, access_token: 42 }, ['access_token']), 'holds access_token', 'an access token that is not a string')
})
