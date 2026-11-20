// The built web app served from WEB_ROOT.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { deadUrl, startClient, tempDir } from './helpers.ts';

const INDEX = '<!doctype html><title>Medical information desk</title>';
const SECRET = 'outside the web root';

// A web root with the app in it, beside a file that must never be served.
async function clientWithApp(t: TestContext): Promise<string> {
  const dir = tempDir(t);
  const webRoot = join(dir, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), INDEX);
  writeFileSync(join(webRoot, 'assets', 'app-1a2b.js'), 'console.log("app");');
  writeFileSync(join(webRoot, 'assets', 'app-1a2b.css'), 'body{}');
  writeFileSync(join(webRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'secret.txt'), SECRET);
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot });
  return client.url;
}

test('index.html is served for / and is not cached', async (t) => {
  const url = await clientWithApp(t);
  const response = await fetch(`${url}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(await response.text(), INDEX);
});

test('files under /assets/ are served with their type and cached for good', async (t) => {
  const url = await clientWithApp(t);
  const script = await fetch(`${url}/assets/app-1a2b.js`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await script.text(), 'console.log("app");');

  const style = await fetch(`${url}/assets/app-1a2b.css`);
  assert.equal(style.headers.get('content-type'), 'text/css; charset=utf-8');
  await style.body?.cancel();

  const icon = await fetch(`${url}/favicon.svg`);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.equal(icon.headers.get('cache-control'), null);
  await icon.body?.cancel();
});

test('a path with no file is the app, so the app can route it', async (t) => {
  const url = await clientWithApp(t);
  for (const path of ['/inquiries/abc', '/cases', '/assets/missing.js']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), INDEX);
  }
});

test('a path that escapes the web root is 404 and does not fall back to the app', async (t) => {
  const url = await clientWithApp(t);
  // Encoded slashes survive URL parsing, so the server sees ".." only after decoding.
  for (const path of ['/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/%E0%A4%A']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 404, path);
    const body = await response.text();
    assert.ok(!body.includes(SECRET), path);
    assert.notEqual(body, INDEX, path);
  }
});

test('without a built app the server answers 503 and says so', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t) });
  const response = await fetch(`${client.url}/`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), 'The web app has not been built.');
});
