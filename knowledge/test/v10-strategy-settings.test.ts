// V10. SEARCH_STRATEGY: an unknown value is refused; each setting a strategy needs is named when missing; keyword needs
// none of them and reads none of them (values that would be refused for another strategy change nothing).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retrievalSettingsFrom } from '../src/search/settings.ts';

const BASE = {
  SEARCH_URL: 'http://search:9200',
  SEARCH_INDEX: 'labels',
  AUTH_DISCOVERY_URL: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
  AUTH_ISSUER: 'http://localhost:8090/realms/lab',
  AUTH_ALLOWED_AUDIENCE: 'lab-knowledge',
  AUTH_ALLOWED_CLIENTS: 'desk',
  AUTH_REQUIRED_SCOPES: 'labels:search',
  AUTH_ROLES_CLAIM: 'roles',
};

const EMBEDDING = {
  MODEL_EMBED_BASE_URL: 'http://models.invalid:8001/v1',
  EMBED_MODEL_ID: 'test-embedding',
  MODEL_API_KEY: 'test-key-not-real',
  EMBED_MODEL_REPO: 'example-org/test-embedding',
  EMBED_MODEL_REVISION: '0123456789abcdef0123456789abcdef01234567',
  EMBED_DIMENSIONS: '1024',
};
const RERANK = { MODEL_RERANK_BASE_URL: 'http://models.invalid:8002/v1', RERANK_MODEL_ID: 'test-reranker' };

const named = (name: string) => (error: unknown) => error instanceof Error && error.message.startsWith(`${name} is not set`);

test('V10. an unknown strategy, or none, is refused', () => {
  assert.throws(() => retrievalSettingsFrom({ ...BASE, SEARCH_STRATEGY: 'hybrid' }), /SEARCH_STRATEGY must be one of keyword, vector, fused, fused_reranked/);
  assert.throws(() => retrievalSettingsFrom(BASE), named('SEARCH_STRATEGY'));
});

test('V10. keyword needs none of the model settings, and reads none of them', () => {
  const plain = retrievalSettingsFrom({ ...BASE, SEARCH_STRATEGY: 'keyword' });
  assert.equal(plain.strategy, 'keyword');
  assert.equal(plain.models, null);
  // Values another strategy would refuse: keyword does not look at them.
  const junk = retrievalSettingsFrom({ ...BASE, SEARCH_STRATEGY: 'keyword', MODEL_EMBED_BASE_URL: 'not an address', EMBED_DIMENSIONS: 'many', MODEL_API_KEY: '' });
  assert.equal(junk.models, null);
});

test('V10. each setting a strategy needs is named when missing', () => {
  for (const strategy of ['vector', 'fused']) {
    const full = retrievalSettingsFrom({ ...BASE, ...EMBEDDING, SEARCH_STRATEGY: strategy });
    assert.equal(full.models?.rerank, null);
    assert.deepEqual(full.models?.embed.identity, { repository: EMBEDDING.EMBED_MODEL_REPO, revision: EMBEDDING.EMBED_MODEL_REVISION, dimensions: 1024 });
    for (const name of Object.keys(EMBEDDING)) {
      assert.throws(() => retrievalSettingsFrom({ ...BASE, ...EMBEDDING, [name]: undefined, SEARCH_STRATEGY: strategy }), named(name), `${strategy} ${name}`);
    }
    // The reranker's settings are not needed.
    assert.doesNotThrow(() => retrievalSettingsFrom({ ...BASE, ...EMBEDDING, SEARCH_STRATEGY: strategy }));
  }
  const reranked = retrievalSettingsFrom({ ...BASE, ...EMBEDDING, ...RERANK, SEARCH_STRATEGY: 'fused_reranked' });
  assert.deepEqual(reranked.models?.rerank, { baseUrl: RERANK.MODEL_RERANK_BASE_URL, modelId: 'test-reranker' });
  for (const name of [...Object.keys(EMBEDDING), ...Object.keys(RERANK)]) {
    assert.throws(() => retrievalSettingsFrom({ ...BASE, ...EMBEDDING, ...RERANK, [name]: undefined, SEARCH_STRATEGY: 'fused_reranked' }), named(name), name);
  }
});

test('V10. an embedding address not ending in /v1, or dimensions that are not a whole number, are refused', () => {
  assert.throws(() => retrievalSettingsFrom({ ...BASE, ...EMBEDDING, MODEL_EMBED_BASE_URL: 'http://models.invalid:8001', SEARCH_STRATEGY: 'vector' }), /MODEL_EMBED_BASE_URL must be/);
  assert.throws(() => retrievalSettingsFrom({ ...BASE, ...EMBEDDING, EMBED_DIMENSIONS: '10.5', SEARCH_STRATEGY: 'vector' }), /EMBED_DIMENSIONS must be a whole number/);
});
