// A real access token for the runner, got as the gates get one: dana.desk signs in through the desk client with the
// authorization code flow and PKCE, on the stack's network. The secret and the password come from the environment
// (platform/identity/.env, passed by Compose) and are never written anywhere. Tokens are replaced before they have
// under 200 s left, since an agent refuses one with under 150 s.

import { randomBytes } from 'node:crypto';

import { signInFormAction } from '../../platform/identity/src/login-form.ts';
import { codeChallengeS256, codeVerifier } from '../../platform/identity/src/pkce.ts';

export const IDENTITY = 'http://identity:8080';
export const BROWSER_IDENTITY = 'http://localhost:8090';
const REALM = '/realms/lab';
const CLIENT_ID = 'desk';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';
const USER = 'dana.desk';
const TIMEOUT_MS = 20_000;

export class SignInFailed extends Error {}

export type Token = { token: string; expiresAt: number };

const request = (url: string, init: RequestInit = {}): Promise<Response> => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });

function toTransport(url: string): string {
  const parsed = new URL(url);
  if (parsed.origin === BROWSER_IDENTITY || parsed.origin === IDENTITY) return `${IDENTITY}${parsed.pathname}${parsed.search}`;
  throw new SignInFailed(`an identity URL on an unexpected origin: ${parsed.origin}`);
}

// Signs in as dana.desk. `now` is the clock the token's expiry is measured by (milliseconds).
export async function signIn(secret: string, password: string, now: () => number): Promise<Token> {
  const cookies = new Map<string, string>();
  const take = (response: Response): void => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  };
  const cookie = (): string => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

  const verifier = codeVerifier(randomBytes(32));
  const state = randomBytes(16).toString('base64url');
  const authorize = new URL(`${IDENTITY}${REALM}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: 'S256',
  }).toString();
  const page = await request(authorize.toString());
  take(page);
  if (page.status !== 200) throw new SignInFailed(`the sign-in page answered ${page.status}`);
  const action = toTransport(signInFormAction(await page.text()));
  const posted = await request(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
    body: new URLSearchParams({ username: USER, password, credentialId: '' }).toString(),
  });
  await posted.arrayBuffer();
  const callback = new URL(posted.headers.get('location') ?? '', action);
  const code = callback.searchParams.get('code');
  if ((posted.status !== 302 && posted.status !== 303) || code === null || callback.searchParams.get('state') !== state) {
    throw new SignInFailed(`signing in as ${USER} did not return a code (status ${posted.status})`);
  }
  const started = now();
  const exchange = await request(`${IDENTITY}${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, client_id: CLIENT_ID, client_secret: secret }).toString(),
  });
  const tokens: unknown = await exchange.json().catch(() => undefined);
  const token = typeof tokens === 'object' && tokens !== null ? Reflect.get(tokens, 'access_token') : undefined;
  const expiresIn = typeof tokens === 'object' && tokens !== null ? Reflect.get(tokens, 'expires_in') : undefined;
  if (exchange.status !== 200 || typeof token !== 'string' || typeof expiresIn !== 'number') throw new SignInFailed(`the token exchange answered ${exchange.status}`);
  return { token, expiresAt: started + expiresIn * 1000 };
}

// Hands out a token, getting a new one before the current one has under `minLeftMs` left. Sign-ins are not made
// twice at once.
export class TokenSource {
  private current: Token | null = null;
  private pending: Promise<Token> | null = null;
  private readonly get: () => Promise<Token>;
  private readonly now: () => number;
  private readonly minLeftMs: number;
  signIns = 0;

  constructor(get: () => Promise<Token>, now: () => number, minLeftMs = 200_000) {
    this.get = get;
    this.now = now;
    this.minLeftMs = minLeftMs;
  }

  async token(): Promise<string> {
    if (this.current !== null && this.current.expiresAt - this.now() >= this.minLeftMs) return this.current.token;
    if (this.pending === null) {
      this.signIns++;
      this.pending = this.get().finally(() => {
        this.pending = null;
      });
    }
    this.current = await this.pending;
    if (this.current.expiresAt - this.now() < this.minLeftMs) throw new SignInFailed('a new token has under 200 s left');
    return this.current.token;
  }
}
