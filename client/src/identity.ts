// The desk's side of OpenID Connect: where sign-in starts, how it is completed, how an access token is
// renewed, and where sign-out goes. openid-client runs the protocol and validates the ID token.
//
// The discovery document is fetched here, not by openid-client, and its issuer must equal OIDC_ISSUER
// exactly. In the lab it is fetched at http://identity:8080 and names http://localhost:8090/realms/lab;
// both are intended. openid-client's Configuration is then built from that document.
//
// Every Configuration is built by one function, configuration(), which
// - turns on checking the ID token's signature against the provider's published keys
//   (enableNonRepudiationChecks; openid-client does not check it otherwise),
// - allows plain-HTTP endpoints only when the provider's document names one (the local provider is HTTP),
// - and tells openid-client the time from this module's clock, by the one means it offers: the skew
//   between that clock and the real one. This is the only place the client reads the real clock.

import * as oidc from 'openid-client';

import { describe, isTimeout, seconds } from './agents.ts';
import type { PingResult } from './agents.ts';
import type { OidcConfig } from './config.ts';

// The time allowed for any one request to the provider during sign-in, refresh or sign-out.
export const IDENTITY_TIMEOUT_MS = 10_000;
// Leeway on the ID token's exp, iat and nbf, in seconds.
const CLOCK_TOLERANCE_SECONDS = 30;

export type SignedInUser = {
  sub: string;
  name: string;
  username: string;
  roles: string[];
  isReviewer: boolean;
};

export type TokenSet = {
  accessToken: string;
  // When the access token stops being valid, by this module's clock, in milliseconds since the epoch.
  accessExpiresAt: number;
  refreshToken: string | null;
  idToken: string;
};

export type PendingSignIn = { state: string; nonce: string; verifier: string };

// The provider cannot be reached, answers discovery with something unusable, or names another issuer.
// The message is a sentence for a person and holds nothing secret.
export class IdentityUnreachable extends Error {
  readonly issuerMismatch: boolean;

  constructor(message: string, issuerMismatch = false) {
    super(message);
    this.name = 'IdentityUnreachable';
    this.issuerMismatch = issuerMismatch;
  }
}

// The provider refused the code or the refresh token, or what it returned failed validation.
export class SignInRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInRefused';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Did a request fail to reach the provider at all (as against being answered with a refusal)?
function isTransportFailure(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (isTimeout(current) || current.name === 'AbortError') return true;
    if (current instanceof TypeError && current.message === 'fetch failed') return true;
  }
  return false;
}

// What is safe to log about a failure from openid-client: its kind, code and message. Never its cause,
// which can hold the provider's response body, tokens included.
function summary(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = isRecord(error) && typeof error.code === 'string' ? ` ${error.code}` : '';
  return `${error.name}${code}: ${error.message}`;
}

function nonEmpty(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== 'string' || value === '') {
    throw new SignInRefused(`The ID token has no ${name}.`);
  }
  return value;
}

export class IdentityProvider {
  private readonly config: OidcConfig;
  private readonly rolesClaim: string;
  private readonly reviewerRole: string;
  private readonly now: () => Date;
  private metadata: oidc.ServerMetadata | undefined;

  constructor(config: OidcConfig, roles: { claim: string; reviewerRole: string }, now: () => Date) {
    this.config = config;
    this.rolesClaim = roles.claim;
    this.reviewerRole = roles.reviewerRole;
    this.now = now;
  }

  // Fetches the discovery document and checks it. Throws IdentityUnreachable, saying why.
  private async discover(timeoutMs: number): Promise<oidc.ServerMetadata> {
    let response: Response;
    try {
      response = await fetch(this.config.discoveryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new IdentityUnreachable(`The identity provider did not answer within ${seconds(timeoutMs)}.`);
      }
      throw new IdentityUnreachable(`Could not reach the identity provider: ${describe(error)}.`);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new IdentityUnreachable(`The identity provider answered its discovery document with status ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IdentityUnreachable("The identity provider's discovery document is not JSON.");
    }
    if (!isRecord(body)) {
      throw new IdentityUnreachable("The identity provider's discovery document is not a JSON object.");
    }
    if (body.issuer !== this.config.issuer) {
      throw new IdentityUnreachable(
        `The identity provider names the issuer ${JSON.stringify(body.issuer)}, not ${JSON.stringify(this.config.issuer)} (OIDC_ISSUER).`,
        true,
      );
    }
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof body[name] !== 'string') {
        throw new IdentityUnreachable(`The identity provider's discovery document has no ${name}.`);
      }
    }
    return { ...body, issuer: this.config.issuer };
  }

  // The provider's document, fetched on first need and kept for the life of the process.
  private async metadataNow(): Promise<oidc.ServerMetadata> {
    this.metadata ??= await this.discover(IDENTITY_TIMEOUT_MS);
    return this.metadata;
  }

  private configuration(metadata: oidc.ServerMetadata): oidc.Configuration {
    const skewSeconds = Math.round((this.now().getTime() - Date.now()) / 1000);
    const configuration = new oidc.Configuration(
      metadata,
      this.config.clientId,
      {
        client_secret: this.config.clientSecret,
        [oidc.clockSkew]: skewSeconds,
        [oidc.clockTolerance]: CLOCK_TOLERANCE_SECONDS,
      },
      oidc.ClientSecretPost(this.config.clientSecret),
    );
    configuration.timeout = IDENTITY_TIMEOUT_MS / 1000;
    oidc.enableNonRepudiationChecks(configuration);
    const endpoints = [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
      metadata.end_session_endpoint,
      metadata.revocation_endpoint,
    ];
    if (endpoints.some((endpoint) => endpoint?.startsWith('http:') === true)) {
      oidc.allowInsecureRequests(configuration);
    }
    return configuration;
  }

  // Where to send the browser to sign in. Throws IdentityUnreachable.
  async authorizationUrl(pending: PendingSignIn): Promise<string> {
    const configuration = this.configuration(await this.metadataNow());
    return oidc
      .buildAuthorizationUrl(configuration, {
        response_type: 'code',
        redirect_uri: this.config.redirectUri,
        scope: 'openid',
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
        code_challenge_method: 'S256',
      })
      .toString();
  }

  private tokenSet(response: oidc.TokenEndpointResponse, previousIdToken: string | null): TokenSet {
    const idToken = response.id_token ?? previousIdToken;
    if (idToken === null) {
      throw new SignInRefused('The identity provider returned no ID token.');
    }
    // expires_in as the provider sent it, counted from this module's clock (openid-client's expiresIn()
    // counts from the real one). A lifetime not given is treated as already over, so the token is
    // renewed before use.
    const lifetimeSeconds = response.expires_in ?? 0;
    return {
      accessToken: response.access_token,
      accessExpiresAt: this.now().getTime() + lifetimeSeconds * 1000,
      refreshToken: response.refresh_token ?? null,
      idToken,
    };
  }

  private userFrom(claims: Record<string, unknown>): SignedInUser {
    const listed = claims[this.rolesClaim];
    // The provider leaves the claim out for a user with no roles.
    if (listed !== undefined && !(Array.isArray(listed) && listed.every((role) => typeof role === 'string'))) {
      throw new SignInRefused(`The ID token's ${this.rolesClaim} claim is not a list of role names.`);
    }
    const roles: string[] = listed === undefined ? [] : listed;
    return {
      sub: nonEmpty(claims, 'sub'),
      name: nonEmpty(claims, 'name'),
      username: nonEmpty(claims, 'preferred_username'),
      roles,
      isReviewer: roles.includes(this.reviewerRole),
    };
  }

  // Exchanges the code from the callback and validates the ID token: signature, issuer, audience, nonce,
  // expiry. Throws IdentityUnreachable or SignInRefused.
  async completeSignIn(callback: URLSearchParams, pending: PendingSignIn): Promise<{ user: SignedInUser; tokens: TokenSet }> {
    const configuration = this.configuration(await this.metadataNow());
    const currentUrl = new URL(this.config.redirectUri);
    currentUrl.search = callback.toString();
    let response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      response = await oidc.authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedNonce: pending.nonce,
        expectedState: pending.state,
        idTokenExpected: true,
      });
    } catch (error) {
      if (isTransportFailure(error)) {
        throw new IdentityUnreachable('The identity provider could not be reached to complete the sign-in.');
      }
      console.error(`Sign-in was refused or failed validation: ${summary(error)}`);
      throw new SignInRefused('The identity provider refused the sign-in, or what it returned did not validate.');
    }
    const claims = response.claims();
    if (claims === undefined) {
      throw new SignInRefused('The identity provider returned no ID token.');
    }
    return { user: this.userFrom({ ...claims }), tokens: this.tokenSet(response, null) };
  }

  // A new access token for a refresh token. Throws IdentityUnreachable or SignInRefused.
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (tokens.refreshToken === null) {
      throw new SignInRefused('The session has no refresh token.');
    }
    const configuration = this.configuration(await this.metadataNow());
    try {
      const response = await oidc.refreshTokenGrant(configuration, tokens.refreshToken);
      const renewed = this.tokenSet(response, tokens.idToken);
      return { ...renewed, refreshToken: renewed.refreshToken ?? tokens.refreshToken };
    } catch (error) {
      if (isTransportFailure(error)) {
        throw new IdentityUnreachable('The identity provider could not be reached to renew the access token.');
      }
      console.error(`Renewing an access token was refused: ${summary(error)}`);
      throw new SignInRefused('The identity provider refused to renew the access token.');
    }
  }

  // The provider's end-session URL: client_id and the post-logout redirect URI, and no token, since the
  // browser is given it. Throws IdentityUnreachable.
  async signOutUrl(): Promise<string> {
    const configuration = this.configuration(await this.metadataNow());
    return oidc
      .buildEndSessionUrl(configuration, {
        client_id: this.config.clientId,
        post_logout_redirect_uri: this.config.postLogoutRedirectUri,
      })
      .toString();
  }

  // Revokes a refresh token (RFC 7009) at the configured endpoint, authenticating as the client. The
  // address in the discovery document is not used: Keycloak gives it at the browser's address, which this
  // server cannot reach. Returns 'no_endpoint' without a call when the setting is none. Never throws: any
  // failure is returned as a sentence safe to log, holding no token.
  async revoke(refreshToken: string): Promise<{ outcome: 'revoked' | 'no_endpoint' } | { outcome: 'failed'; reason: string }> {
    const endpoint = this.config.revocationEndpoint;
    if (endpoint === null) {
      return { outcome: 'no_endpoint' };
    }
    let configuration: oidc.Configuration;
    try {
      configuration = this.configuration({ ...(await this.metadataNow()), revocation_endpoint: endpoint });
    } catch (error) {
      return { outcome: 'failed', reason: error instanceof IdentityUnreachable ? error.message : summary(error) };
    }
    try {
      await oidc.tokenRevocation(configuration, refreshToken, { token_type_hint: 'refresh_token' });
      return { outcome: 'revoked' };
    } catch (error) {
      return {
        outcome: 'failed',
        reason: isTransportFailure(error) ? 'The identity provider could not be reached.' : summary(error),
      };
    }
  }

  // For the status page: fetched afresh each time, and never kept.
  async check(timeoutMs: number): Promise<PingResult> {
    try {
      await this.discover(timeoutMs);
      return { outcome: 'up' };
    } catch (error) {
      return { outcome: 'down', reason: error instanceof IdentityUnreachable ? error.message : describe(error) };
    }
  }
}
