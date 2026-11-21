// Proof Key for Code Exchange (RFC 7636), method S256 only.
import { createHash } from 'node:crypto'

// RFC 7636 section 4.1: 43 to 128 characters from the unreserved set.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

/** A code verifier made from at least 32 random bytes, which the caller supplies. */
export function codeVerifier(randomBytes: Uint8Array): string {
  if (randomBytes.length < 32) {
    throw new Error(`codeVerifier: needs at least 32 random bytes, got ${randomBytes.length}`)
  }
  return Buffer.from(randomBytes).toString('base64url')
}

/** BASE64URL(SHA256(ASCII(verifier))), without padding. Throws on a verifier RFC 7636 does not allow. */
export function codeChallengeS256(verifier: string): string {
  if (!VERIFIER.test(verifier)) {
    throw new Error('codeChallengeS256: the verifier must be 43 to 128 characters of A-Z a-z 0-9 - . _ ~')
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
