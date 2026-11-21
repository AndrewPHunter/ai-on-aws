// What an access token issued to a desk user must carry (platform/identity/README.md, "Access token claims").
// The checker works on claims already decoded from a token whose signature has been verified.

export type ClaimExpectations = {
  issuer: string
  audiences: readonly string[]
  clientId: string
  reviewerRole: string
  /** Whether this user holds the reviewer role. */
  isReviewer: boolean
  lifetimeSeconds: number
}

/** The statement names a violation is reported under. */
export type ClaimStatement =
  | 'iss'
  | 'aud'
  | 'client_id'
  | 'roles is an array of strings'
  | 'reviewer role present for a reviewer'
  | 'reviewer role absent for a non-reviewer'
  | 'sub'
  | 'preferred_username'
  | 'name'
  | 'lifetime'

export type ClaimViolation = { statement: ClaimStatement; detail: string }

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

const describe = (value: unknown): string => (value === undefined ? 'missing' : JSON.stringify(value))

/** Every violation found, in the order of the claims table; an empty list means the token holds. */
export function checkClaims(claims: Readonly<Record<string, unknown>>, expected: ClaimExpectations): ClaimViolation[] {
  const violations: ClaimViolation[] = []
  const fail = (statement: ClaimStatement, detail: string): void => {
    violations.push({ statement, detail })
  }

  if (claims.iss !== expected.issuer) {
    fail('iss', `expected ${JSON.stringify(expected.issuer)}, got ${describe(claims.iss)}`)
  }

  // RFC 7519: aud is one string or an array of strings.
  const aud = claims.aud
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : []
  const missing = expected.audiences.filter((name) => !audiences.includes(name))
  if (missing.length > 0) fail('aud', `missing ${missing.join(', ')}; got ${describe(aud)}`)

  if (claims.client_id !== expected.clientId) {
    fail('client_id', `expected ${JSON.stringify(expected.clientId)}, got ${describe(claims.client_id)}`)
  }

  const roles = claims.roles
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) {
    fail('roles is an array of strings', `got ${describe(roles)}`)
  } else if (expected.isReviewer && !roles.includes(expected.reviewerRole)) {
    fail('reviewer role present for a reviewer', `${expected.reviewerRole} not in ${JSON.stringify(roles)}`)
  } else if (!expected.isReviewer && roles.includes(expected.reviewerRole)) {
    fail('reviewer role absent for a non-reviewer', `${expected.reviewerRole} in ${JSON.stringify(roles)}`)
  }

  for (const name of ['sub', 'preferred_username', 'name'] as const) {
    if (!nonEmptyString(claims[name])) fail(name, `expected a non-empty string, got ${describe(claims[name])}`)
  }

  const { exp, iat } = claims
  if (typeof exp !== 'number' || typeof iat !== 'number' || exp - iat !== expected.lifetimeSeconds) {
    fail('lifetime', `expected exp - iat = ${expected.lifetimeSeconds}, got exp ${describe(exp)}, iat ${describe(iat)}`)
  }

  return violations
}
