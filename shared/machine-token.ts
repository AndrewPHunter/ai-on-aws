// A token for a machine that calls a service as itself: the client-credentials grant (RFC 6749, 4.4), sent as the
// client with its own secret, for the scopes it asks for. No person signs in.
//
// Everything it depends on is passed in: the settings, fetch, the clock and the time limit. One request per call,
// never retried. It does not check which scopes were granted: the identity provider leaves out a scope the client
// may not have and still answers 200, so the service the token is sent to is the check. No error message it throws
// holds the client secret or a token.

export type MachineTokenSettings = {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  timeoutMs: number;
};
// `now` is the clock the expiry is measured by, in milliseconds.
export type MachineTokenOptions = { fetch: typeof fetch; now: () => number };
// expiresAt is the clock's time when the answer arrived plus expires_in.
export type MachineToken = { token: string; expiresAt: number };

export class MachineTokenFailed extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function machineToken(settings: MachineTokenSettings, options: MachineTokenOptions): Promise<MachineToken> {
  const who = `client ${settings.clientId}`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    scope: settings.scopes.join(' '),
  });

  // The time limit covers the whole answer, its body included.
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let status: number;
  let text: string;
  try {
    const response = await options.fetch(settings.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'manual',
      signal,
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    // An error's message is not quoted: only its kind, which holds neither the secret nor a token.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new MachineTokenFailed(`the token endpoint did not answer ${who} within ${settings.timeoutMs} ms`);
    }
    throw new MachineTokenFailed(`the token endpoint could not be reached for ${who} (${error instanceof Error ? error.name : 'error'})`);
  }
  const arrived = options.now();

  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  if (status !== 200) {
    // The provider's error code is named when it is a plain OAuth code; its description is never quoted.
    const code = isRecord(answer) && typeof answer.error === 'string' && /^[a-z_]{1,64}$/.test(answer.error) ? `, ${answer.error}` : '';
    throw new MachineTokenFailed(`the token endpoint answered ${status}${code} to ${who}`);
  }
  const token = isRecord(answer) ? answer.access_token : undefined;
  const expiresIn = isRecord(answer) ? answer.expires_in : undefined;
  if (typeof token !== 'string' || token === '' || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new MachineTokenFailed(`the token endpoint answered 200 to ${who} without an access token and a positive expires_in`);
  }
  return { token, expiresAt: arrived + expiresIn * 1000 };
}
