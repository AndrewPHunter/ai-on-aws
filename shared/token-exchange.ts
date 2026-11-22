// The token exchange an agent makes to get a token for the one service it calls (OAuth 2.0 Token Exchange,
// RFC 8693): it sends the token it was given, as itself, and asks for one audience and the scopes it needs.
//
// This is the boundary that is replaced on AWS, where AgentCore Identity makes the exchange and the agent
// holds no client secret. Nothing about the identity provider behind it leaks out: the result is a token,
// a refusal or "unavailable".
//
// Everything it depends on is passed in: the settings, fetch, the clock and the time limit. One request per
// call, never retried. It logs nothing, and no detail it returns holds the subject token, the returned token
// or the client secret.

export type TokenExchangeSettings = { tokenEndpoint: string; clientId: string; clientSecret: string };
export type TokenExchangeOptions = { fetch: typeof fetch; now: () => Date };
export type TokenExchangeRequest = { subjectToken: string; audience: string; scopes: readonly string[]; timeoutMs: number };
export type TokenExchangeResult =
  // Every scope asked for was granted. expiresAt is the clock's time when the answer arrived plus expires_in.
  | { kind: 'token'; token: string; expiresAt: Date; scopes: string[] }
  // scope_not_granted: a bearer token without a scope asked for. provider_refused: a 4xx answer.
  // not_a_bearer_token: a 200 JSON object that is not a bearer token as described above.
  | { kind: 'refused'; reason: 'scope_not_granted' | 'provider_refused' | 'not_a_bearer_token'; detail: string }
  // No answer in time, a network failure, a 5xx or any other status (a redirect included), or a body that is
  // not JSON.
  | { kind: 'unavailable'; detail: string };
export type TokenExchange = (request: TokenExchangeRequest) => Promise<TokenExchangeResult>;

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const REDACTED = '[redacted]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export function createTokenExchange(settings: TokenExchangeSettings, options: TokenExchangeOptions): TokenExchange {
  return async (request) => {
    if (request.scopes.length === 0) {
      throw new Error('A token exchange must ask for at least one scope.');
    }
    const asked = [...request.scopes];

    // Whatever reaches a detail from outside (the provider's words, an error's message) passes through here.
    const secrets = [request.subjectToken, settings.clientSecret].filter((value) => value !== '');
    const scrub = (text: string, alsoHide: readonly string[] = []): string =>
      [...secrets, ...alsoHide.filter((value) => value !== '')].reduce((out, secret) => out.split(secret).join(REDACTED), text);

    const unavailable = (detail: string): TokenExchangeResult => ({ kind: 'unavailable', detail: scrub(detail) });
    const describe = (error: unknown): string => {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return `the identity provider did not answer the token exchange within ${request.timeoutMs} ms`;
      }
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
      return `the token exchange could not reach the identity provider: ${message}${cause}`;
    };

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: request.subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      audience: request.audience,
      scope: asked.join(' '),
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
    });

    // The time limit covers the whole answer, its body included.
    const signal = AbortSignal.timeout(request.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await options.fetch(settings.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
        signal,
        // A redirect is an answer like any other status, never followed: following it would send the form, the
        // secret and the subject token with it, in a second request.
        redirect: 'manual',
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      return unavailable(`${describe(error)}.`);
    }

    if (status >= 400 && status < 500) {
      const parsed = parseJson(text);
      const answer = parsed.ok && isRecord(parsed.value) ? parsed.value : undefined;
      const code = typeof answer?.error === 'string' ? answer.error : undefined;
      const description = typeof answer?.error_description === 'string' ? answer.error_description : undefined;
      const words = [code, description].filter((part) => part !== undefined).join(': ');
      return {
        kind: 'refused',
        reason: 'provider_refused',
        detail: scrub(`The identity provider refused the token exchange with status ${status}${words === '' ? '' : ` (${words})`}.`),
      };
    }
    if (status !== 200) {
      return unavailable(`The identity provider answered the token exchange with status ${status}.`);
    }

    const parsed = parseJson(text);
    if (!parsed.ok) {
      return unavailable("The identity provider's answer to the token exchange is not JSON.");
    }
    if (!isRecord(parsed.value)) {
      return unavailable("The identity provider's answer to the token exchange is not a JSON object.");
    }
    const answer = parsed.value;
    const token = answer.access_token;
    const tokenType = answer.token_type;
    const expiresIn = answer.expires_in;
    const scope = answer.scope;
    const notBearer = (what: string): TokenExchangeResult => ({
      kind: 'refused',
      reason: 'not_a_bearer_token',
      detail: `The identity provider's answer to the token exchange is not a bearer token: ${what}.`,
    });
    if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
      return notBearer('its token_type is not Bearer');
    }
    if (typeof token !== 'string' || token === '') {
      return notBearer('it has no access_token');
    }
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return notBearer('its expires_in is not a positive number');
    }
    if (typeof scope !== 'string') {
      return notBearer('it has no scope');
    }
    const granted = scope.split(' ').filter((name) => name !== '');
    const missing = asked.filter((name) => !granted.includes(name));
    if (missing.length > 0) {
      return {
        kind: 'refused',
        reason: 'scope_not_granted',
        detail: scrub(`The identity provider did not grant ${missing.join(', ')} in the token exchange.`, [token]),
      };
    }
    // Read once, after the answer has arrived.
    const now = options.now();
    return { kind: 'token', token, expiresAt: new Date(now.getTime() + expiresIn * 1000), scopes: granted };
  };
}
