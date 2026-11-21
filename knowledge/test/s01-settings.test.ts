// S1. The settings function: each variable is required and named when missing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retrievalSettingsFrom } from '../src/search/settings.ts';

const ENV = {
  SEARCH_URL: 'http://search:9200',
  SEARCH_INDEX: 'labels',
  AUTH_DISCOVERY_URL: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
  AUTH_ISSUER: 'http://localhost:8090/realms/lab',
  AUTH_ALLOWED_AUDIENCE: 'lab-knowledge',
  AUTH_ALLOWED_CLIENTS: 'desk',
  AUTH_ROLES_CLAIM: 'roles',
};

test('S1. complete settings are read', () => {
  assert.deepEqual(retrievalSettingsFrom(ENV), {
    searchUrl: 'http://search:9200',
    searchIndex: 'labels',
    auth: {
      discoveryUrl: ENV.AUTH_DISCOVERY_URL,
      issuer: ENV.AUTH_ISSUER,
      audience: 'lab-knowledge',
      allowedClients: ['desk'],
      rolesClaim: 'roles',
      minRemainingSeconds: 0,
    },
  });
});

test('S1. each variable missing or blank is named', () => {
  for (const name of Object.keys(ENV)) {
    for (const value of [undefined, '  ']) {
      const env: Record<string, string | undefined> = { ...ENV, [name]: value };
      assert.throws(() => retrievalSettingsFrom(env), (error: unknown) => error instanceof Error && error.message.startsWith(`${name} is not set`), name);
    }
  }
});
