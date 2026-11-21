// The check of an access token presented as `Authorization: Bearer <token>`, for every piece that serves
// requests on behalf of a signed-in member of staff: the agents, and the case system.
//
// It is configured by the same values as AgentCore Runtime's JWT authorizer (a discovery URL, an allowed
// audience, allowed client IDs read from the `client_id` claim), so the check made by a container
// locally is the one made in front of it on AWS.
//
// Everything it depends on is passed in: the settings, the clock, how long it waits before fetching the
// keys again, and how long it waits for the provider. It reads no environment variable and not the real
// clock: expiry and remaining life are judged on the clock it is given, with no tolerance, and the keys
// are fetched and matched here rather than by jose's remote key set (which keeps its own time).
// Only RS256 is accepted.

import { createLocalJWKSet, decodeProtectedHeader, errors, importJWK, jwtVerify } from 'jose';
import type { JSONWebKeySet, JWK } from 'jose';

export type AccessTokenSettings = {
  discoveryUrl: string;
  // Compared with the discovery document's issuer and every token's iss, as exact strings.
  issuer: string;
  // Must be among the token's aud.
  audience: string;
  // The token's client_id must be one of these.
  allowedClients: readonly string[];
  // The claim that holds the caller's roles as a flat list of names.
  rolesClaim: string;
  // How long, in seconds, a token must still be valid for.
  minRemainingSeconds: number;
};

export type AccessTokenOptions = {
  now: () => Date;
  // After a token names a key not in the cached set, the keys are fetched again only if this long has
  // passed since they were last fetched.
  keyRefetchWaitMs: number;
  // How long a request to the provider (discovery, keys) may take.
  timeoutMs: number;
};

export type Caller = {
  subject: string;
  username: string;
  name: string;
  clientId: string;
  roles: string[];
  expiresAt: Date;
  // The token as presented, to pass on to the services this caller's request reaches.
  token: string;
};

export type RefusalReason =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_client'
  | 'expired'
  | 'expires_too_soon';

export type TokenCheck =
  | { kind: 'caller'; caller: Caller }
  // The token is refused. The detail is a sentence for a person and never contains the token.
  | { kind: 'refused'; reason: RefusalReason; detail: string }
  // The token could not be checked: the provider's document or keys could not be had, or the document
  // names another issuer. Not a judgement on the token.
  | { kind: 'unavailable'; detail: string };

export type AccessTokenCheck = (authorization: string | undefined) => Promise<TokenCheck>;

class Unavailable extends Error {}

function refused(reason: RefusalReason, detail: string): TokenCheck {
  return { kind: 'refused', reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return 'it did not answer in time';
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

async function fetchJson(url: string, what: string, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Unavailable(`Could not fetch the identity provider's ${what}: ${describe(error)}.`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Unavailable(`The identity provider answered its ${what} with status ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Unavailable(`The identity provider's ${what} is not JSON.`);
  }
}

function nonEmpty(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function createAccessTokenCheck(settings: AccessTokenSettings, options: AccessTokenOptions): AccessTokenCheck {
  // Kept once fetched. A failed fetch leaves nothing behind, so the next check tries again.
  let jwksUri: Promise<string> | undefined;
  let keys: { set: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | undefined;

  async function discover(): Promise<string> {
    const document = await fetchJson(settings.discoveryUrl, 'discovery document', options.timeoutMs);
    if (!isRecord(document)) {
      throw new Unavailable("The identity provider's discovery document is not a JSON object.");
    }
    if (document.issuer !== settings.issuer) {
      throw new Unavailable(
        `The identity provider names the issuer ${JSON.stringify(document.issuer)}, not ${JSON.stringify(settings.issuer)}.`,
      );
    }
    if (typeof document.jwks_uri !== 'string') {
      throw new Unavailable("The identity provider's discovery document has no jwks_uri.");
    }
    return document.jwks_uri;
  }

  async function jwksLocation(): Promise<string> {
    jwksUri ??= discover().catch((error: unknown) => {
      jwksUri = undefined;
      throw error;
    });
    return jwksUri;
  }

  // The provider's keys, checked before they are used: a key set that cannot be used is the provider's
  // fault, reported as unavailable, never as a refusal of the caller's token.
  async function fetchKeys(): Promise<ReturnType<typeof createLocalJWKSet>> {
    const set = await fetchJson(await jwksLocation(), 'key set', options.timeoutMs);
    if (!isRecord(set) || !Array.isArray(set.keys)) {
      throw new Unavailable("The identity provider's key set has no keys.");
    }
    for (const key of set.keys) {
      if (!isRecord(key)) {
        throw new Unavailable("The identity provider's key set holds an entry that is not a key.");
      }
      // Every RSA signing key must import as an RS256 public key. Keys of other kinds, and keys marked
      // for encryption, are never used to verify a token and are left to jose.
      if (key.kty === 'RSA' && key.use !== 'enc' && (key.alg === undefined || key.alg === 'RS256')) {
        let usable = false;
        try {
          const imported = await importJWK(key as JWK, 'RS256');
          // RS256 needs a modulus of at least 2048 bits; jose would refuse a smaller key only at verify time.
          const algorithm: unknown = typeof imported === 'object' && 'algorithm' in imported ? imported.algorithm : undefined;
          const bits: unknown = typeof algorithm === 'object' && algorithm !== null ? Reflect.get(algorithm, 'modulusLength') : undefined;
          usable = typeof bits !== 'number' || bits >= 2048;
        } catch {
          usable = false;
        }
        if (!usable) {
          throw new Unavailable("The identity provider's key set holds an RSA key that is not a valid RS256 public key.");
        }
      }
    }
    let local: ReturnType<typeof createLocalJWKSet>;
    try {
      local = createLocalJWKSet(set as unknown as JSONWebKeySet);
    } catch {
      throw new Unavailable("The identity provider's key set is not a valid JSON Web Key Set.");
    }
    keys = { set: local, fetchedAt: options.now().getTime() };
    return local;
  }

  async function verify(token: string, now: Date): Promise<Record<string, unknown>> {
    const set = keys?.set ?? (await fetchKeys());
    try {
      return { ...(await jwtVerify(token, set, { algorithms: ['RS256'], currentDate: now, clockTolerance: 0 })).payload };
    } catch (error) {
      // A key the cached set does not hold: the provider may have new keys. Fetched again at most once
      // per wait, so tokens naming unknown keys cannot make every request fetch.
      const waited = keys === undefined || now.getTime() - keys.fetchedAt >= options.keyRefetchWaitMs;
      if (error instanceof errors.JWKSNoMatchingKey && waited) {
        const fresh = await fetchKeys();
        return { ...(await jwtVerify(token, fresh, { algorithms: ['RS256'], currentDate: now, clockTolerance: 0 })).payload };
      }
      throw error;
    }
  }

  function refusalFor(error: unknown): TokenCheck {
    if (error instanceof errors.JWTExpired) {
      return refused('expired', 'The access token has expired.');
    }
    if (error instanceof errors.JWKSNoMatchingKey) {
      return refused('bad_signature', 'The access token is signed by a key the identity provider does not publish.');
    }
    if (error instanceof errors.JWSSignatureVerificationFailed) {
      return refused('bad_signature', 'The access token signature does not verify against the identity provider keys.');
    }
    if (error instanceof errors.JOSEAlgNotAllowed) {
      return refused('bad_signature', 'The access token is not signed with RS256.');
    }
    if (error instanceof errors.JWTClaimValidationFailed) {
      return refused('malformed', `The access token's ${error.claim} claim is not valid.`);
    }
    return refused('malformed', 'The access token is not a well-formed signed JWT.');
  }

  return async (authorization) => {
    const match = /^Bearer +(\S+)\s*$/.exec(authorization ?? '');
    if (match === null || match[1] === undefined) {
      return refused('missing', 'The request has no Authorization header with a Bearer token.');
    }
    const token = match[1];

    let algorithm: unknown;
    try {
      algorithm = decodeProtectedHeader(token).alg;
    } catch {
      return refused('malformed', 'The access token is not a JWT.');
    }
    if (algorithm !== 'RS256') {
      return refused('bad_signature', 'The access token is not signed with RS256.');
    }

    const now = options.now();
    let claims: Record<string, unknown>;
    try {
      claims = await verify(token, now);
    } catch (error) {
      if (error instanceof Unavailable) {
        return { kind: 'unavailable', detail: error.message };
      }
      return refusalFor(error);
    }

    if (claims.iss !== settings.issuer) {
      return refused('wrong_issuer', `The access token was issued by ${JSON.stringify(claims.iss)}, not ${JSON.stringify(settings.issuer)}.`);
    }
    const aud = claims.aud;
    const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
    if (!audiences.includes(settings.audience)) {
      return refused('wrong_audience', `The access token is not meant for ${JSON.stringify(settings.audience)}.`);
    }
    const clientId = claims.client_id;
    if (typeof clientId !== 'string' || !settings.allowedClients.includes(clientId)) {
      return refused(
        'wrong_client',
        typeof clientId === 'string'
          ? `The access token was issued to the client ${JSON.stringify(clientId)}, which is not allowed here.`
          : 'The access token names no client_id.',
      );
    }
    const exp = claims.exp;
    if (typeof exp !== 'number') {
      return refused('malformed', 'The access token has no expiry.');
    }
    const remainingMs = exp * 1000 - now.getTime();
    if (remainingMs < settings.minRemainingSeconds * 1000) {
      return refused(
        'expires_too_soon',
        `The access token expires in ${Math.floor(remainingMs / 1000)} s; this service needs at least ${settings.minRemainingSeconds} s.`,
      );
    }
    const subject = nonEmpty(claims, 'sub');
    const username = nonEmpty(claims, 'preferred_username');
    const name = nonEmpty(claims, 'name');
    if (subject === undefined || username === undefined || name === undefined) {
      return refused('malformed', 'The access token lacks sub, preferred_username or name.');
    }
    const listed = claims[settings.rolesClaim];
    if (listed !== undefined && !(Array.isArray(listed) && listed.every((role) => typeof role === 'string'))) {
      return refused('malformed', `The access token's ${settings.rolesClaim} claim is not a list of role names.`);
    }
    return {
      kind: 'caller',
      caller: {
        subject,
        username,
        name,
        clientId,
        roles: listed === undefined ? [] : [...(listed as string[])],
        expiresAt: new Date(exp * 1000),
        token,
      },
    };
  };
}
