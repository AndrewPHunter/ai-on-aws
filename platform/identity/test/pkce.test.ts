import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeChallengeS256 } from '../src/pkce.ts'

test('I1. the S256 challenge for the RFC 7636 Appendix B verifier is the challenge given there', () => {
  assert.equal(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})
