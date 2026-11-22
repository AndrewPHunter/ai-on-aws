// A real access token for the runner: it gets one as its own client, `evaluation`, with its own secret, by client
// credentials, on the stack's network. The secret comes from the environment (platform/identity/.env, passed by
// Compose) and is never written anywhere. Tokens are replaced before they have under 200 s left, since an agent
// refuses one with under 150 s.

import { MachineTokenFailed, machineToken } from '../../shared/machine-token.ts';

const TOKEN_ENDPOINT = 'http://identity:8080/realms/lab/protocol/openid-connect/token';
const CLIENT_ID = 'evaluation';
const SCOPES = ['agents:expert'];
const TIMEOUT_MS = 20_000;

export class SignInFailed extends Error {}

export type Token = { token: string; expiresAt: number };

// One token for the runner, as the client `evaluation`. `now` is the clock the token's expiry is measured by
// (milliseconds).
export async function evaluationToken(secret: string, options: { fetch: typeof fetch; now: () => number }): Promise<Token> {
  try {
    return await machineToken({ tokenEndpoint: TOKEN_ENDPOINT, clientId: CLIENT_ID, clientSecret: secret, scopes: SCOPES, timeoutMs: TIMEOUT_MS }, options);
  } catch (error) {
    if (error instanceof MachineTokenFailed) throw new SignInFailed(error.message);
    throw error;
  }
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
