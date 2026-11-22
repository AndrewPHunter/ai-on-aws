import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkClaims, checkIdTokenRoles, type ClaimExpectations, type ClaimStatement, type IdTokenStatement } from '../src/claims.ts'

const expectations = (isReviewer: boolean): ClaimExpectations => ({
  issuer: 'http://localhost:8090/realms/lab',
  audiences: ['lab-agents', 'lab-case-system', 'lab-knowledge'],
  clientId: 'desk',
  reviewerRole: 'reviewer',
  isReviewer,
  lifetimeSeconds: 600,
})

const reviewerToken: Record<string, unknown> = {
  iss: 'http://localhost:8090/realms/lab',
  aud: ['lab-agents', 'lab-case-system', 'lab-knowledge'],
  client_id: 'desk',
  roles: ['default-roles-lab', 'reviewer'],
  sub: '3f1c2a9e-0000-4000-8000-000000000001',
  preferred_username: 'riley.reviewer',
  name: 'Riley Reviewer',
  iat: 1_800_000_000,
  exp: 1_800_000_600,
}

const deskToken: Record<string, unknown> = {
  ...reviewerToken,
  roles: ['default-roles-lab'],
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
}

const cases: { name: string; token: Record<string, unknown>; isReviewer: boolean; expected: ClaimStatement[] }[] = [
  { name: 'valid reviewer token', token: reviewerToken, isReviewer: true, expected: [] },
  { name: 'valid non-reviewer token', token: deskToken, isReviewer: false, expected: [] },
  { name: 'wrong issuer', token: { ...reviewerToken, iss: 'http://identity:8080/realms/lab' }, isReviewer: true, expected: ['iss'] },
  { name: 'missing audience', token: { ...reviewerToken, aud: ['lab-agents', 'account'] }, isReviewer: true, expected: ['aud'] },
  { name: 'wrong client_id', token: { ...reviewerToken, client_id: 'other' }, isReviewer: true, expected: ['client_id'] },
  { name: 'roles not an array', token: { ...reviewerToken, roles: 'reviewer' }, isReviewer: true, expected: ['roles is an array of strings'] },
  { name: 'reviewer role missing for the reviewer', token: deskToken, isReviewer: true, expected: ['reviewer role present for a reviewer'] },
  { name: 'reviewer role present for the non-reviewer', token: reviewerToken, isReviewer: false, expected: ['reviewer role absent for a non-reviewer'] },
  { name: 'wrong lifetime', token: { ...reviewerToken, exp: 1_800_000_300 }, isReviewer: true, expected: ['lifetime'] },
]

test('I6. the claim checker reports each violation of the claims table by name', () => {
  for (const { name, token, isReviewer, expected } of cases) {
    const reported = checkClaims(token, expectations(isReviewer)).map((violation) => violation.statement)
    assert.deepEqual(reported, expected, name)
  }
})

const idTokenCases: { name: string; claims: Record<string, unknown>; isReviewer: boolean; expected: IdTokenStatement[] }[] = [
  { name: 'reviewer with reviewer', claims: { roles: ['default-roles-lab', 'reviewer'] }, isReviewer: true, expected: [] },
  { name: 'non-reviewer without reviewer', claims: { roles: ['default-roles-lab'] }, isReviewer: false, expected: [] },
  { name: 'roles missing', claims: { sub: 'x' }, isReviewer: true, expected: ['ID token roles is an array of strings'] },
  { name: 'reviewer for the non-reviewer', claims: { roles: ['reviewer'] }, isReviewer: false, expected: ['ID token reviewer role absent for a non-reviewer'] },
  { name: 'no reviewer for the reviewer', claims: { roles: ['default-roles-lab'] }, isReviewer: true, expected: ['ID token reviewer role present for a reviewer'] },
]

test('G1. the ID-token checker reports roles missing, reviewer for the non-reviewer, and no reviewer for the reviewer', () => {
  for (const { name, claims, isReviewer, expected } of idTokenCases) {
    const reported = checkIdTokenRoles(claims, { reviewerRole: 'reviewer', isReviewer }).map((violation) => violation.statement)
    assert.deepEqual(reported, expected, name)
  }
})

test('G2. the claim checker reports an access token whose audience lacks lab-knowledge', () => {
  const withoutKnowledge = { ...deskToken, aud: ['lab-agents', 'lab-case-system'] }
  const violations = checkClaims(withoutKnowledge, expectations(false))
  assert.deepEqual(violations.map((violation) => violation.statement), ['aud'])
  assert.match(violations[0]?.detail ?? '', /missing lab-knowledge/)
})
