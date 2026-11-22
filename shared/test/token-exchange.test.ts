// The token exchange (RFC 8693) against the stand-in issuer in test-support/, which answers the exchange as each
// test scripts it and signs real tokens. fetch is the real one, wrapped to record what is sent; the clock is the
// test's.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { ExchangeAnswer, StandInIssuer } from '../../test-support/issuer.ts';
import { createTokenExchange } from '../token-exchange.ts';
import type { TokenExchange, TokenExchangeResult } from '../token-exchange.ts';

const START = '2026-03-01T10:00:00.000Z';
// How far the exchange's clock has moved by the time the answer arrives.
const ANSWER_ARRIVES_AFTER_MS = 5_000;
const AGENT = 'intake-handwritten';
const SECRET = 'exchange-client-secret-4f9a1c';
const AUDIENCE = 'case-system';
const SCOPES = ['cases:write', 'cases:lookup'];
const TIMEOUT_MS = 2_000;

const SUBJECT_CLAIMS = {
  aud: [AGENT],
  client_id: 'desk',
  azp: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
  roles: ['default-roles-lab', 'desk'],
};

type Sent = { url: string; init: RequestInit | undefined };

type Rig = {
  issuer: StandInIssuer;
  exchange: TokenExchange;
  subjectToken: string;
  sent: Sent[];
  // How many times the exchange read its clock.
  clockReads: () => number;
  ask: (overrides?: { scopes?: readonly string[]; timeoutMs?: number }) => Promise<TokenExchangeResult>;
};

async function rig(t: TestContext, secret = SECRET): Promise<Rig> {
  const issuer = await startStandInIssuer({
    clientId: AGENT,
    clientSecret: SECRET,
    redirectUri: 'http://localhost:3000/auth/callback',
    postLogoutRedirectUri: 'http://localhost:3000/',
    now: () => new Date(START),
  });
  t.after(() => issuer.close());

  let at = new Date(START).getTime();
  let reads = 0;
  const now = (): Date => {
    reads++;
    return new Date(at);
  };
  const sent: Sent[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    sent.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const response = await fetch(input, init);
    at += ANSWER_ARRIVES_AFTER_MS;
    return response;
  };
  const exchange = createTokenExchange({ tokenEndpoint: `${issuer.url}/token`, clientId: AGENT, clientSecret: secret }, { fetch: recordingFetch, now });
  const subjectToken = await issuer.mintAccessToken({ lifetimeSeconds: 600, scopes: ['agents:intake'], claims: SUBJECT_CLAIMS });
  return {
    issuer,
    exchange,
    subjectToken,
    sent,
    clockReads: () => reads,
    ask: (overrides = {}) =>
      exchange({ subjectToken, audience: AUDIENCE, scopes: overrides.scopes ?? SCOPES, timeoutMs: overrides.timeoutMs ?? TIMEOUT_MS }),
  };
}

function raw(status: number, body: unknown, contentType = 'application/json'): ExchangeAnswer {
  return { kind: 'raw', status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function refused(result: TokenExchangeResult): { reason: string; detail: string } {
  assert.equal(result.kind, 'refused', `expected a refusal, got ${JSON.stringify(result)}`);
  return result.kind === 'refused' ? { reason: result.reason, detail: result.detail } : { reason: '', detail: '' };
}

function unavailable(result: TokenExchangeResult): string {
  assert.equal(result.kind, 'unavailable', `expected unavailable, got ${JSON.stringify(result)}`);
  return result.kind === 'unavailable' ? result.detail : '';
}

test('I05. one POST to the token endpoint, with exactly the RFC 8693 form fields and the two headers, and nothing else', async (t) => {
  const r = await rig(t);
  r.issuer.scriptExchange({ kind: 'grant', scopes: SCOPES });
  const result = await r.ask();
  assert.equal(result.kind, 'token');

  assert.equal(r.sent.length, 1);
  const [sent] = r.sent;
  assert.equal(sent?.url, `${r.issuer.url}/token`);
  assert.equal(sent?.init?.method, 'POST');
  assert.deepEqual(sent?.init?.headers, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
  const body = sent?.init?.body;
  assert.equal(typeof body, 'string');
  const expected = {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: r.subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: AUDIENCE,
    scope: 'cases:write cases:lookup',
    client_id: AGENT,
    client_secret: SECRET,
  };
  const fields = [...new URLSearchParams(typeof body === 'string' ? body : '').entries()];
  assert.deepEqual(Object.fromEntries(fields), expected);
  assert.equal(fields.length, Object.keys(expected).length, 'a field was sent twice');

  // What arrived at the provider: one request, the same form, no credential in a header.
  const received = r.issuer.received.filter((request) => request.path === '/token');
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]?.form, expected);
  assert.equal(received[0]?.authorization, null);
});

test('I06. a requested scope left out, a provider error and a non-bearer answer are refusals, each named; scopes match by whole name', async (t) => {
  const r = await rig(t);

  r.issuer.scriptExchange({ kind: 'grant', scopes: ['cases:write'] });
  const left = refused(await r.ask());
  assert.equal(left.reason, 'scope_not_granted');
  assert.match(left.detail, /cases:lookup/);

  r.issuer.scriptExchange({ kind: 'grant', scopes: ['cases:read-all'] });
  assert.equal(refused(await r.ask({ scopes: ['cases:read'] })).reason, 'scope_not_granted', 'a longer name granted');
  r.issuer.scriptExchange({ kind: 'grant', scopes: ['cases:read'] });
  assert.equal(refused(await r.ask({ scopes: ['cases:re'] })).reason, 'scope_not_granted', 'a shorter name asked');

  for (const [status, error, description] of [
    [400, 'invalid_scope', 'Invalid scopes: cases:review'],
    [403, 'access_denied', 'Client is not within the token audience'],
  ] as const) {
    r.issuer.scriptExchange({ kind: 'error', status, error, description });
    const answer = refused(await r.ask());
    assert.equal(answer.reason, 'provider_refused', error);
    assert.ok(answer.detail.includes(String(status)), `${error}: no status in ${answer.detail}`);
    assert.ok(answer.detail.includes(error), `${error}: no code in ${answer.detail}`);
    assert.ok(answer.detail.includes(description), `${error}: no description in ${answer.detail}`);
  }
  r.issuer.scriptExchange(raw(404, 'Not found.', 'text/plain'));
  const plain = refused(await r.ask());
  assert.equal(plain.reason, 'provider_refused', 'a 4xx that is not JSON');
  assert.match(plain.detail, /404/);

  const bearer = { access_token: 'opaque-access-token', token_type: 'Bearer', expires_in: 300, scope: 'cases:write cases:lookup' };
  for (const [name, body] of [
    ['token_type N_A', { ...bearer, token_type: 'N_A' }],
    ['no token_type', { ...bearer, token_type: undefined }],
    ['an empty access_token', { ...bearer, access_token: '' }],
    ['no access_token', { ...bearer, access_token: undefined }],
    ['expires_in zero', { ...bearer, expires_in: 0 }],
    ['expires_in a string', { ...bearer, expires_in: '300' }],
    ['no scope', { ...bearer, scope: undefined }],
  ] as const) {
    r.issuer.scriptExchange(raw(200, body));
    assert.equal(refused(await r.ask()).reason, 'not_a_bearer_token', name);
  }
  // Bearer is matched ignoring case.
  r.issuer.scriptExchange(raw(200, { ...bearer, token_type: 'bearer' }));
  assert.equal((await r.ask()).kind, 'token');

  // A wrong client secret is the provider's refusal, with its status and code.
  const wrongSecret = await rig(t, 'not-the-secret');
  wrongSecret.issuer.scriptExchange({ kind: 'grant', scopes: SCOPES });
  const answer = refused(await wrongSecret.ask());
  assert.equal(answer.reason, 'provider_refused');
  assert.match(answer.detail, /401/);
  assert.match(answer.detail, /invalid_client/);
});

// The test's own limit is far above the exchange's 200 ms: an exchange that ignores its time limit waits on the
// held connection and fails here.
test('I07. no answer within the time limit, a 5xx, a dropped connection and a 200 that is not JSON are unavailable, never refusals', { timeout: 10_000 }, async (t) => {
  const r = await rig(t);

  r.issuer.misbehave('hold_token');
  assert.match(unavailable(await r.ask({ timeoutMs: 200 })), /did not answer .*within 200 ms/);
  r.issuer.misbehave('none');

  for (const status of [500, 502, 503]) {
    r.issuer.scriptExchange(raw(status, { error: 'temporarily_unavailable' }));
    assert.match(unavailable(await r.ask()), new RegExp(String(status)));
  }

  r.issuer.misbehave('no_answer');
  unavailable(await r.ask());
  r.issuer.misbehave('none');

  r.issuer.scriptExchange(raw(200, '<html>Welcome</html>', 'text/html'));
  assert.match(unavailable(await r.ask()), /not JSON/);

  // Each call was one request: nothing was retried.
  assert.equal(r.sent.length, 6);
});

test('I08. no detail holds the subject token, the returned token or the client secret, whatever the provider answers', { timeout: 10_000 }, async (t) => {
  const r = await rig(t);
  const subject = r.subjectToken;
  const returned = 'returned-access-token-7d2e91';
  // What the provider could quote. A token is returned only in a 200 with an access_token, so only those quote it.
  const echo = `${subject} ${SECRET}`;
  const echoAll = `${echo} ${returned}`;
  const answers: { name: string; answer?: ExchangeAnswer; hold?: boolean; drop?: boolean }[] = [
    { name: 'an OAuth error quoting them', answer: { kind: 'error', status: 400, error: `invalid_grant ${SECRET}`, description: echo } },
    { name: 'a 403 quoting them', answer: raw(403, { error: SECRET, error_description: subject }) },
    { name: 'a 4xx that is not JSON', answer: raw(400, echo, 'text/plain') },
    { name: 'a 5xx quoting them', answer: raw(503, { error: echo }) },
    { name: 'a 200 that is not JSON', answer: raw(200, echo, 'text/plain') },
    { name: 'a 200 that is not an object', answer: raw(200, [echo]) },
    { name: 'a non-bearer 200', answer: raw(200, { access_token: returned, token_type: echoAll, expires_in: 300, scope: SCOPES.join(' ') }) },
    { name: 'a non-bearer 200 with a bad expiry', answer: raw(200, { access_token: returned, token_type: 'Bearer', expires_in: echoAll, scope: SCOPES.join(' ') }) },
    { name: 'a scope left out, the scope quoting them', answer: raw(200, { access_token: returned, token_type: 'Bearer', expires_in: 300, scope: `cases:write ${echoAll}` }) },
    { name: 'a signed token with a scope left out', answer: { kind: 'grant', scopes: ['cases:write'] } },
    { name: 'no answer in time', hold: true },
    { name: 'a dropped connection', drop: true },
  ];
  for (const row of answers) {
    if (row.answer !== undefined) r.issuer.scriptExchange(row.answer);
    r.issuer.misbehave(row.hold === true ? 'hold_token' : row.drop === true ? 'no_answer' : 'none');
    const result = await r.ask({ timeoutMs: row.hold === true ? 200 : TIMEOUT_MS });
    assert.notEqual(result.kind, 'token', row.name);
    const detail = result.kind === 'token' ? '' : result.detail;
    assert.ok(detail.length > 0, row.name);
    const signed = r.issuer.exchanged.at(-1);
    for (const [what, value] of [
      ['the subject token', subject],
      ['the client secret', SECRET],
      ['the returned token', returned],
      ['the signed token returned', signed],
    ] as const) {
      if (value !== undefined) {
        assert.ok(!detail.includes(value), `${row.name}: the detail holds ${what}: ${detail}`);
      }
    }
  }
});

test("I09. the expiry is the clock's time when the answer arrived plus expires_in, the clock read once", async (t) => {
  const r = await rig(t);
  // The stand-in's token expires when the subject token does: 600 s after START, on the provider's clock.
  r.issuer.scriptExchange({ kind: 'grant', scopes: [...SCOPES, 'openid'] });
  const granted = await r.ask();
  assert.equal(granted.kind, 'token');
  if (granted.kind !== 'token') return;
  assert.equal(granted.token, r.issuer.exchanged.at(-1));
  assert.deepEqual(granted.scopes, ['cases:write', 'cases:lookup', 'openid']);
  assert.deepEqual(granted.expiresAt, new Date(new Date(START).getTime() + ANSWER_ARRIVES_AFTER_MS + 600_000));
  assert.equal(r.clockReads(), 1);

  r.issuer.scriptExchange(raw(200, { access_token: 'opaque-access-token', token_type: 'Bearer', expires_in: 123, scope: SCOPES.join(' ') }));
  const second = await r.ask();
  assert.deepEqual(second.kind === 'token' ? second.expiresAt : undefined, new Date(new Date(START).getTime() + 2 * ANSWER_ARRIVES_AFTER_MS + 123_000));
  assert.equal(r.clockReads(), 2);
});
