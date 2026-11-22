// STAND-IN OPENID CONNECT ISSUER, FOR TESTS ONLY. It is not the lab's identity provider (that is Keycloak,
// in platform/identity/) and nothing outside a test may start it.
//
// It runs on loopback and plays the provider's part in the Authorization Code flow with PKCE, with real
// RS256 signatures, so a test can drive a relying party through sign-in, refresh and sign-out for real:
//
//   GET  /.well-known/openid-configuration   discovery; the issuer it names can differ from where it listens,
//                                           as Keycloak's does in the lab (fetched at identity:8080, names
//                                           localhost:8090)
//   GET  /jwks                               its public key
//   GET  /authorize                          signs the scripted user in and redirects back with a code, the
//                                           state and iss (or with error=access_denied)
//   POST /token                              authorization_code (client secret and PKCE verifier enforced),
//                                           refresh_token, and token exchange (RFC 8693, client secret
//                                           enforced, its answer scripted by the test)
//   POST /revoke                             token revocation (RFC 7009), client secret enforced; a revoked
//                                           refresh token is refused from then on
//   GET  /logout                             end-session
//
// One property of an otherwise valid answer can be made wrong at a time (misbehave), so a test that passes
// against the valid answer and fails against one misbehaviour shows that check, and only that check, works.
// It records every request it receives. mintAccessToken signs an access token with chosen claims, scopes and
// lifetime (with its key, another key, HS256 or no signature at all), and rotateKey replaces its key, for
// the tests of the pieces that check access tokens.
//
// Scopes, as Keycloak decides them in the lab: a scripted user is granted a list of scopes. The access token
// from the code grant carries openid and every scope granted, in its scope claim and in the answer's scope. A
// refresh without a scope parameter does the same; one with a scope parameter narrows the access token to the
// requested scopes that were granted (openid is always granted), and leaves out the others with status 200.
// The refresh token keeps the user's full grant. A user given no scopes is granted none.
//
// A token exchange is answered as the test scripted it (scriptExchange); nothing is answered by default.
//
// Its key pair is generated when it starts; its clock (iat, exp) is passed in.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { SignJWT, UnsecuredJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import type { CryptoKey, JWK } from 'jose';

export type ScriptedUser = {
  sub: string;
  preferred_username: string;
  name: string;
  roles: string[];
  // The scopes the user's roles grant. None when absent.
  scopes?: readonly string[];
};

export type Misbehaviour =
  | 'none'
  // The discovery document names another issuer than the one this stand-in signs as.
  | 'wrong_discovery_issuer'
  // The authorization endpoint redirects back with error=access_denied instead of a code.
  | 'deny_sign_in'
  // The ID token from the code exchange is wrong in exactly one way.
  | 'wrong_nonce'
  | 'wrong_audience'
  | 'wrong_issuer'
  | 'other_key'
  | 'expired'
  // The token endpoint refuses the code, or the refresh token, with invalid_grant.
  | 'refuse_code'
  | 'refuse_refresh'
  // The revocation endpoint answers 503 and revokes nothing.
  | 'refuse_revocation'
  // Every request is answered by closing the connection.
  | 'no_answer'
  // Requests to the discovery document, the keys or the token endpoint are recorded and never answered: the
  // connection stays open until the caller gives up or the stand-in is closed. Other paths answer as usual.
  | 'hold_discovery'
  | 'hold_keys'
  | 'hold_token'
  // The keys endpoint answers 200 with something that is not a usable key set.
  | 'jwks_not_json'
  | 'jwks_without_keys'
  | 'jwks_with_bad_key';

export type StandInIssuerOptions = {
  clientId: string;
  clientSecret: string;
  // Compared byte for byte, as Keycloak does.
  redirectUri: string;
  postLogoutRedirectUri: string;
  now: () => Date;
  // The issuer it names in discovery and in tokens. Default: the address it listens on.
  issuer?: string;
  accessTokenLifetimeSeconds?: number;
  // The access token's audiences. Default: the lab's two, lab-agents and lab-case-system.
  audiences?: string[];
  // The revocation endpoint the discovery document names. Default: its own /revoke. Keycloak in the lab
  // names this one endpoint at the browser's address, which a container cannot reach; a test passes an
  // unreachable address here to show a relying party does not take it from discovery.
  discoveryRevocationEndpoint?: string;
  // Further clients that may use the token-exchange grant, each with its secret, besides clientId.
  exchangeClients?: readonly { clientId: string; clientSecret: string }[];
};

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

// How the token endpoint answers the next token-exchange requests, until scripted again.
export type ExchangeAnswer =
  // A really signed token for the requested audience (or the one given), carrying exactly these scopes. A
  // scope asked for and left out of this list is left out with status 200, as Keycloak does.
  | { kind: 'grant'; scopes: readonly string[]; audience?: string }
  // An OAuth error: the status, and a JSON body with error and error_description.
  | { kind: 'error'; status: number; error: string; description: string }
  // Any other answer, exactly as given: a 5xx, a body that is not JSON, a non-bearer answer.
  | { kind: 'raw'; status: number; contentType: string; body: string };

export type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  authorization: string | null;
};

export type IssuedTokens = { access_token: string; refresh_token: string; id_token: string };

export type MintOptions = {
  claims: Record<string, unknown>;
  lifetimeSeconds: number;
  // Written as the scope claim, separated by single spaces. A scope given in claims is used when this is absent.
  scopes?: readonly string[];
  // own_key: its current published key (RS256). other_key: an RS256 key it never publishes.
  // hs256: an HMAC with a secret of its own. none: an unsecured JWT, alg none, no signature.
  signedBy?: 'own_key' | 'other_key' | 'hs256' | 'none';
};

export type StandInIssuer = {
  // Where it listens, and the issuer it names (the same unless options.issuer was given).
  url: string;
  issuer: string;
  discoveryUrl: string;
  // Where its revocation endpoint really is, whatever discovery names.
  revocationUrl: string;
  signInAs: (user: ScriptedUser) => void;
  misbehave: (misbehaviour: Misbehaviour) => void;
  received: RecordedRequest[];
  // Every token it has handed out, so a test can look for them where they must not be.
  issued: IssuedTokens[];
  // Every access token it has handed out from a token exchange.
  exchanged: string[];
  scriptExchange: (answer: ExchangeAnswer) => void;
  mintAccessToken: (options: MintOptions) => Promise<string>;
  // Replaces its signing key with a new one under a new kid, as Keycloak does when it restarts. The old
  // key is no longer published, and tokens it signed no longer verify.
  rotateKey: () => Promise<void>;
  close: () => Promise<void>;
};

const CODE_LIFETIME_SECONDS = 60;
const EXPIRED_BY_SECONDS = 600;

type PendingCode = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | undefined;
  user: ScriptedUser;
  issuedAt: number;
};

function random(): string {
  return randomBytes(24).toString('base64url');
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function formOf(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function oauthError(response: ServerResponse, status: number, error: string, description: string): void {
  sendJson(response, status, { error, error_description: description });
}

// client_secret_post or client_secret_basic.
function clientCredentials(form: Record<string, string>, authorization: string | null): { id?: string; secret?: string } {
  if (authorization?.startsWith('Basic ') === true) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    if (at > 0) {
      return { id: decodeURIComponent(decoded.slice(0, at)), secret: decodeURIComponent(decoded.slice(at + 1)) };
    }
  }
  return { id: form.client_id, secret: form.client_secret };
}

export async function startStandInIssuer(options: StandInIssuerOptions): Promise<StandInIssuer> {
  let own = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  let kid = random();
  let publicJwk: JWK = { ...(await exportJWK(own.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const hmacSecret = randomBytes(32);

  let user: ScriptedUser | undefined;
  let misbehaviour: Misbehaviour = 'none';
  const received: RecordedRequest[] = [];
  const issued: IssuedTokens[] = [];
  const exchanged: string[] = [];
  let exchangeAnswer: ExchangeAnswer | undefined;
  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, ScriptedUser>();
  const accessLifetime = options.accessTokenLifetimeSeconds ?? 600;
  const audiences = options.audiences ?? ['lab-agents', 'lab-case-system'];

  let url = '';
  let issuer = '';

  async function sign(claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key);
  }

  async function tokensFor(subject: ScriptedUser, nonce: string | undefined, forCode: boolean, scope: string): Promise<IssuedTokens> {
    const now = seconds(options.now());
    const bad = forCode ? misbehaviour : 'none';
    const iat = bad === 'expired' ? now - EXPIRED_BY_SECONDS - accessLifetime : now;
    const access = await sign(
      {
        iss: issuer,
        aud: audiences,
        client_id: options.clientId,
        sub: subject.sub,
        preferred_username: subject.preferred_username,
        name: subject.name,
        roles: subject.roles,
        scope,
        iat: now,
        exp: now + accessLifetime,
      },
      own.privateKey,
    );
    const idClaims: Record<string, unknown> = {
      iss: bad === 'wrong_issuer' ? `${issuer}-other` : issuer,
      aud: bad === 'wrong_audience' ? `${options.clientId}-other` : options.clientId,
      azp: options.clientId,
      sub: subject.sub,
      preferred_username: subject.preferred_username,
      name: subject.name,
      roles: subject.roles,
      iat,
      exp: iat + accessLifetime,
    };
    if (nonce !== undefined) {
      idClaims.nonce = bad === 'wrong_nonce' ? `${nonce}-other` : nonce;
    }
    const id = await sign(idClaims, bad === 'other_key' ? other.privateKey : own.privateKey);
    const refresh = random();
    refreshTokens.set(refresh, subject);
    const tokens = { access_token: access, refresh_token: refresh, id_token: id };
    issued.push(tokens);
    return tokens;
  }

  // openid and the user's granted scopes; narrowed to those asked for when a request names scopes.
  function scopeFor(subject: ScriptedUser, requested: string | undefined): string {
    const granted = ['openid', ...(subject.scopes ?? [])];
    if (requested === undefined) {
      return granted.join(' ');
    }
    const asked = requested.split(' ').filter((name) => name !== '');
    return granted.filter((name) => asked.includes(name)).join(' ');
  }

  function authorize(response: ServerResponse, query: Record<string, string>): void {
    if (query.client_id !== options.clientId || query.redirect_uri !== options.redirectUri) {
      // As a provider must: an unknown client or redirect URI is never redirected to.
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('Unknown client or redirect URI.');
      return;
    }
    const back = new URL(options.redirectUri);
    const state = query.state;
    if (state !== undefined) {
      back.searchParams.set('state', state);
    }
    back.searchParams.set('iss', issuer);
    const fail = (error: string): void => {
      back.searchParams.set('error', error);
      response.writeHead(302, { location: back.toString() });
      response.end();
    };
    if (query.response_type !== 'code') return fail('unsupported_response_type');
    if (query.code_challenge_method !== 'S256' || query.code_challenge === undefined) return fail('invalid_request');
    if (misbehaviour === 'deny_sign_in' || user === undefined) return fail('access_denied');
    const code = random();
    codes.set(code, {
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      challenge: query.code_challenge,
      nonce: query.nonce,
      user,
      issuedAt: seconds(options.now()),
    });
    back.searchParams.set('code', code);
    response.writeHead(302, { location: back.toString() });
    response.end();
  }

  async function token(response: ServerResponse, form: Record<string, string>, authorization: string | null): Promise<void> {
    if (form.grant_type === TOKEN_EXCHANGE_GRANT) {
      const exchanger = isExchangeClient(form, authorization);
      if (exchanger === undefined) {
        oauthError(response, 401, 'invalid_client', 'Client authentication failed.');
        return;
      }
      await exchange(response, form, exchanger);
      return;
    }
    const client = clientCredentials(form, authorization);
    if (client.id !== options.clientId || client.secret !== options.clientSecret) {
      oauthError(response, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }
    if (form.grant_type === 'authorization_code') {
      const code = form.code === undefined ? undefined : codes.get(form.code);
      if (form.code !== undefined) {
        codes.delete(form.code);
      }
      if (misbehaviour === 'refuse_code' || code === undefined) {
        oauthError(response, 400, 'invalid_grant', 'The code is not valid.');
        return;
      }
      if (seconds(options.now()) - code.issuedAt > CODE_LIFETIME_SECONDS || form.redirect_uri !== code.redirectUri) {
        oauthError(response, 400, 'invalid_grant', 'The code is expired or the redirect URI differs.');
        return;
      }
      const verifier = form.code_verifier ?? '';
      if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== code.challenge) {
        oauthError(response, 400, 'invalid_grant', 'PKCE verification failed.');
        return;
      }
      const scope = scopeFor(code.user, undefined);
      const tokens = await tokensFor(code.user, code.nonce, true, scope);
      sendJson(response, 200, { ...tokens, token_type: 'Bearer', expires_in: accessLifetime, scope });
      return;
    }
    if (form.grant_type === 'refresh_token') {
      const subject = form.refresh_token === undefined ? undefined : refreshTokens.get(form.refresh_token);
      if (misbehaviour === 'refuse_refresh' || subject === undefined || form.refresh_token === undefined) {
        oauthError(response, 400, 'invalid_grant', 'The refresh token is not valid.');
        return;
      }
      refreshTokens.delete(form.refresh_token);
      const scope = scopeFor(subject, form.scope);
      const tokens = await tokensFor(subject, undefined, false, scope);
      sendJson(response, 200, { ...tokens, token_type: 'Bearer', expires_in: accessLifetime, scope });
      return;
    }
    oauthError(response, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }

  function isExchangeClient(form: Record<string, string>, authorization: string | null): string | undefined {
    const client = clientCredentials(form, authorization);
    const known = [{ clientId: options.clientId, clientSecret: options.clientSecret }, ...(options.exchangeClients ?? [])];
    return known.some((entry) => entry.clientId === client.id && entry.clientSecret === client.secret) ? client.id : undefined;
  }

  async function exchange(response: ServerResponse, form: Record<string, string>, clientId: string): Promise<void> {
    if (form.subject_token_type !== ACCESS_TOKEN_TYPE || form.subject_token === undefined || form.audience === undefined) {
      oauthError(response, 400, 'invalid_request', 'subject_token, subject_token_type and audience are required.');
      return;
    }
    let subject: Record<string, unknown>;
    try {
      const keys = createLocalJWKSet({ keys: [publicJwk] });
      subject = { ...(await jwtVerify(form.subject_token, keys, { algorithms: ['RS256'], currentDate: options.now() })).payload };
    } catch {
      oauthError(response, 400, 'invalid_token', 'The subject token is not valid.');
      return;
    }
    const answer = exchangeAnswer;
    if (answer === undefined) {
      oauthError(response, 400, 'invalid_request', 'The stand-in has no token-exchange answer scripted.');
      return;
    }
    if (answer.kind === 'error') {
      oauthError(response, answer.status, answer.error, answer.description);
      return;
    }
    if (answer.kind === 'raw') {
      response.writeHead(answer.status, { 'content-type': answer.contentType });
      response.end(answer.body);
      return;
    }
    const now = seconds(options.now());
    const exp = typeof subject.exp === 'number' ? subject.exp : now;
    const scope = answer.scopes.join(' ');
    const access = await sign(
      {
        iss: issuer,
        aud: answer.audience ?? form.audience,
        client_id: clientId,
        azp: clientId,
        sub: subject.sub,
        preferred_username: subject.preferred_username,
        name: subject.name,
        roles: subject.roles,
        scope,
        iat: now,
        exp,
      },
      own.privateKey,
    );
    exchanged.push(access);
    sendJson(response, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: exp - now,
      scope,
      issued_token_type: ACCESS_TOKEN_TYPE,
    });
  }

  function revoke(response: ServerResponse, form: Record<string, string>, authorization: string | null): void {
    const client = clientCredentials(form, authorization);
    if (client.id !== options.clientId || client.secret !== options.clientSecret) {
      oauthError(response, 401, 'invalid_client', 'Client authentication failed.');
      return;
    }
    if (misbehaviour === 'refuse_revocation') {
      oauthError(response, 503, 'temporarily_unavailable', 'Revocation is not available.');
      return;
    }
    // RFC 7009 section 2.2: an unknown token is not an error.
    if (form.token !== undefined) {
      refreshTokens.delete(form.token);
    }
    response.writeHead(200);
    response.end();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = new URL(request.url ?? '/', url);
    const authorization = request.headers.authorization ?? null;
    const form = request.method === 'POST' ? await formOf(request) : {};
    received.push({
      method: request.method ?? '',
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      form,
      authorization,
    });
    if (misbehaviour === 'no_answer') {
      request.socket.destroy();
      return;
    }
    const held =
      (misbehaviour === 'hold_discovery' && parsed.pathname === '/.well-known/openid-configuration') ||
      (misbehaviour === 'hold_keys' && parsed.pathname === '/jwks') ||
      (misbehaviour === 'hold_token' && parsed.pathname === '/token');
    if (held) {
      // Never answered: closed only by the caller or by close().
      return;
    }
    switch (`${request.method} ${parsed.pathname}`) {
      case 'GET /.well-known/openid-configuration':
        sendJson(response, 200, {
          issuer: misbehaviour === 'wrong_discovery_issuer' ? `${issuer}-other` : issuer,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          jwks_uri: `${url}/jwks`,
          end_session_endpoint: `${url}/logout`,
          revocation_endpoint: options.discoveryRevocationEndpoint ?? `${url}/revoke`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE_GRANT],
          authorization_response_iss_parameter_supported: true,
        });
        return;
      case 'GET /jwks':
        if (misbehaviour === 'jwks_not_json') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"keys": [');
          return;
        }
        if (misbehaviour === 'jwks_without_keys') {
          sendJson(response, 200, { signing: [publicJwk] });
          return;
        }
        if (misbehaviour === 'jwks_with_bad_key') {
          // An RSA key with no modulus.
          sendJson(response, 200, { keys: [{ kty: 'RSA', kid, alg: 'RS256', use: 'sig', e: 'AQAB' }] });
          return;
        }
        sendJson(response, 200, { keys: [publicJwk] });
        return;
      case 'GET /authorize':
        authorize(response, Object.fromEntries(parsed.searchParams));
        return;
      case 'POST /token':
        await token(response, form, authorization);
        return;
      case 'POST /revoke':
        revoke(response, form, authorization);
        return;
      case 'GET /logout': {
        const target = parsed.searchParams.get('post_logout_redirect_uri');
        if (target !== null && target !== options.postLogoutRedirectUri) {
          response.writeHead(400, { 'content-type': 'text/plain' });
          response.end('Unknown post-logout redirect URI.');
          return;
        }
        response.writeHead(target === null ? 200 : 302, target === null ? { 'content-type': 'text/plain' } : { location: target });
        response.end(target === null ? 'Signed out.' : undefined);
        return;
      }
      default:
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Not found.');
    }
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain' });
      }
      response.end(`The stand-in issuer failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The stand-in issuer has no port');
  }
  url = `http://127.0.0.1:${address.port}`;
  issuer = options.issuer ?? url;

  return {
    url,
    issuer,
    discoveryUrl: `${url}/.well-known/openid-configuration`,
    revocationUrl: `${url}/revoke`,
    signInAs: (next) => {
      user = next;
    },
    misbehave: (next) => {
      misbehaviour = next;
    },
    received,
    issued,
    exchanged,
    scriptExchange: (answer) => {
      exchangeAnswer = answer;
    },
    mintAccessToken: async ({ claims, lifetimeSeconds, signedBy, scopes }) => {
      const now = seconds(options.now());
      const body = { iss: issuer, iat: now, exp: now + lifetimeSeconds, ...claims, ...(scopes === undefined ? {} : { scope: scopes.join(' ') }) };
      if (signedBy === 'none') {
        return new UnsecuredJWT(body).encode();
      }
      if (signedBy === 'hs256') {
        return new SignJWT(body).setProtectedHeader({ alg: 'HS256', kid, typ: 'JWT' }).sign(hmacSecret);
      }
      return sign(body, signedBy === 'other_key' ? other.privateKey : own.privateKey);
    },
    rotateKey: async () => {
      own = await generateKeyPair('RS256', { extractable: true });
      kid = random();
      publicJwk = { ...(await exportJWK(own.publicKey)), kid, alg: 'RS256', use: 'sig' };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
