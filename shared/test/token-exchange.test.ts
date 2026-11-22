// The token exchange's invariant 7 ("Always true" in shared/README.md). The provider is a fetch function passed in.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTokenExchange } from '../token-exchange.ts';

const SUBJECT = 'subject-token-of-the-caller';
const SECRET = 'client-secret-of-the-agent';
const EXCHANGED = 'exchanged-token-for-the-case-system';
const NOW = new Date('2026-03-01T10:00:00.000Z');

const answer = (status: number, body: unknown) => (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const bearer = (scope: string) => answer(200, { access_token: EXCHANGED, token_type: 'Bearer', expires_in: 300, scope });

// The provider's own words repeat the subject token and the secret, so a sentence that passed them on would show.
const ROWS: { name: string; provider: () => Promise<Response>; result: string }[] = [
  { name: 'every scope granted', provider: bearer('cases:lookup cases:read'), result: 'token' },
  { name: 'the provider refuses', provider: answer(400, { error: 'invalid_grant', error_description: `${SUBJECT} is not valid for ${SECRET}` }), result: 'provider_refused' },
  { name: 'a scope left out of the grant', provider: bearer('cases:read'), result: 'scope_not_granted' },
  { name: 'no answer', provider: () => Promise.reject(new DOMException(`no answer to ${SECRET}`, 'TimeoutError')), result: 'unavailable' },
];

test('shared 7. a token only when every scope asked for is granted; refusal, partial grant and no answer differ and hold no secret', async () => {
  for (const row of ROWS) {
    const exchange = createTokenExchange(
      { tokenEndpoint: 'http://localhost:8090/token', clientId: 'intake-agent', clientSecret: SECRET },
      { fetch: row.provider, now: () => NOW },
    );
    const result = await exchange({ subjectToken: SUBJECT, audience: 'lab-case-system', scopes: ['cases:read', 'cases:lookup'], timeoutMs: 1000 });
    assert.equal(result.kind === 'refused' ? result.reason : result.kind, row.result, row.name);
    if (result.kind === 'token') {
      assert.equal(result.token, EXCHANGED, row.name);
    } else {
      for (const secret of [SUBJECT, SECRET, EXCHANGED]) assert.ok(!result.detail.includes(secret), `${row.name}: ${secret}`);
    }
  }
});
