// S17 (D3, T1). The token is checked before anything about the request is read, the target included. With no
// token: GET, DELETE and POST on /mcp, another path, a target that cannot be parsed as a URL, and POST and HEAD on
// /ping are all 401 with the header; only GET /ping is answered without one. A target that cannot be parsed, with a
// valid token, is 400.

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';

import { createRetrievalServer } from '../src/search/http.ts';
import { listen, startTokens, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

// A request sent as written: fetch would normalise a target such as //.
function raw(url: string, method: string, target: string, authorization?: string): Promise<{ status: number; header: string | undefined }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sent = request({ hostname, port, method, path: target, headers: authorization === undefined ? {} : { authorization } }, (response) => {
      response.resume();
      response.on('end', () => {
        const header = response.headers['www-authenticate'];
        resolve({ status: response.statusCode ?? 0, header: typeof header === 'string' ? header : undefined });
      });
    });
    sent.on('error', reject);
    sent.end();
  });
}

test('S17. with no token, every method and target but GET /ping is 401 with the header', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([]));
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check), t);

  const refused: [string, string][] = [
    ['GET', '/mcp'],
    ['DELETE', '/mcp'],
    ['POST', '/mcp'],
    ['GET', '/another'],
    ['POST', '/ping'],
    ['HEAD', '/ping'],
    ['GET', '//'],
    ['GET', '//[not-a-host'],
  ];
  for (const [method, target] of refused) {
    const answer = await raw(url, method, target);
    assert.equal(answer.status, 401, `${method} ${target}`);
    assert.equal(answer.header, 'Bearer error="invalid_token"', `${method} ${target}`);
  }
  const ping = await raw(url, 'GET', '/ping');
  assert.equal(ping.status, 200);
  assert.equal(standIn.received.length, 0);
});

test('S17. a target that cannot be parsed, with a valid token, is 400', async (t) => {
  const standIn = await startSearchStandIn(t);
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check), t);

  const answer = await raw(url, 'GET', '//[not-a-host', `Bearer ${await tokens.mint()}`);

  assert.equal(answer.status, 400);
  assert.equal(standIn.received.length, 0);
});
