import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configFrom } from '../src/config.ts';

const AGENT = { id: 'intake', name: 'Intake agent', description: 'Answers and opens cases.', url: 'http://intake:8080/' };

const SIGN_IN = {
  OIDC_DISCOVERY_URL: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
  OIDC_ISSUER: 'http://localhost:8090/realms/lab',
  OIDC_CLIENT_ID: 'desk',
  OIDC_CLIENT_SECRET: 'not-a-real-secret',
  OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'http://localhost:3000/',
  OIDC_REVOCATION_ENDPOINT: 'http://identity:8080/realms/lab/protocol/openid-connect/revoke',
  APP_ORIGIN: 'http://localhost:3000',
  ROLES_CLAIM: 'roles',
  REVIEWER_ROLE: 'reviewer',
};

const VALID = {
  CLIENT_DB_PATH: '/data/client.db',
  CASE_REVIEW_URL: 'http://case-system:8001',
  AGENTS: JSON.stringify([AGENT]),
  WEB_ROOT: '/srv/web',
  ...SIGN_IN,
};

test('a complete environment gives the settings, with URLs stored without a trailing slash', () => {
  assert.deepEqual(configFrom({ ...VALID, CASE_REVIEW_URL: 'http://case-system:8001/' }), {
    dbPath: '/data/client.db',
    caseReviewUrl: 'http://case-system:8001',
    agents: [{ ...AGENT, url: 'http://intake:8080' }],
    webRoot: '/srv/web',
    oidc: {
      discoveryUrl: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
      issuer: 'http://localhost:8090/realms/lab',
      clientId: 'desk',
      clientSecret: 'not-a-real-secret',
      redirectUri: 'http://localhost:3000/auth/callback',
      // Kept byte for byte, trailing slash included: the provider compares it exactly.
      postLogoutRedirectUri: 'http://localhost:3000/',
      revocationEndpoint: 'http://identity:8080/realms/lab/protocol/openid-connect/revoke',
    },
    appOrigin: 'http://localhost:3000',
    rolesClaim: 'roles',
    reviewerRole: 'reviewer',
  });
});

test('C13. each sign-in setting is required: with any one removed or blank, reading the settings fails naming it', () => {
  for (const name of Object.keys(SIGN_IN)) {
    const missing: NodeJS.ProcessEnv = { ...VALID };
    delete missing[name];
    assert.throws(() => configFrom(missing), new RegExp(`^Error: ${name} is not set`), name);
    assert.throws(() => configFrom({ ...VALID, [name]: '  ' }), new RegExp(`^Error: ${name} is not set`), name);
  }
  assert.equal(configFrom({ ...VALID, OIDC_REVOCATION_ENDPOINT: 'none' }).oidc.revocationEndpoint, null);
  for (const value of ['identity:8080/revoke', 'not a url', 'ftp://identity/revoke', 'None']) {
    assert.throws(
      () => configFrom({ ...VALID, OIDC_REVOCATION_ENDPOINT: value }),
      /^Error: OIDC_REVOCATION_ENDPOINT must be an http or https URL, or the word none/,
      value,
    );
  }
});

test('an empty list of agents is valid', () => {
  assert.deepEqual(configFrom({ ...VALID, AGENTS: '[]' }).agents, []);
});

test('each required setting that is missing or blank is named in the error', () => {
  for (const name of ['CLIENT_DB_PATH', 'CASE_REVIEW_URL', 'AGENTS', 'WEB_ROOT'] as const) {
    const missing: NodeJS.ProcessEnv = { ...VALID };
    delete missing[name];
    assert.throws(() => configFrom(missing), new RegExp(`^Error: ${name} is not set`));
    assert.throws(() => configFrom({ ...VALID, [name]: '  ' }), new RegExp(`^Error: ${name} is not set`));
  }
});

test('a case review URL that is not an http URL is refused', () => {
  assert.throws(() => configFrom({ ...VALID, CASE_REVIEW_URL: 'case-system:8001' }), /CASE_REVIEW_URL/);
  assert.throws(() => configFrom({ ...VALID, CASE_REVIEW_URL: 'not a url' }), /CASE_REVIEW_URL is not a URL/);
});

test('AGENTS that is not JSON, not an array, or has a bad entry is refused with where the problem is', () => {
  assert.throws(() => configFrom({ ...VALID, AGENTS: '[{' }), /AGENTS is not JSON/);
  assert.throws(() => configFrom({ ...VALID, AGENTS: '{}' }), /AGENTS is not valid/);
  assert.throws(() => configFrom({ ...VALID, AGENTS: JSON.stringify([{ ...AGENT, url: 'ftp://x' }]) }), /AGENTS is not valid at 0\.url/);
  assert.throws(() => configFrom({ ...VALID, AGENTS: JSON.stringify([{ ...AGENT, id: '' }]) }), /AGENTS is not valid at 0\.id/);
  assert.throws(() => configFrom({ ...VALID, AGENTS: JSON.stringify([{ id: 'a', name: 'A', url: 'http://a' }]) }), /at 0\.description/);
});

test('two agents with the same id are refused', () => {
  assert.throws(
    () => configFrom({ ...VALID, AGENTS: JSON.stringify([AGENT, { ...AGENT, name: 'Another' }]) }),
    /the agent id "intake" is used more than once/,
  );
});

test('an agent may not take an identifier the status report uses for another part', () => {
  assert.throws(
    () =>
      configFrom({
        CLIENT_DB_PATH: '/data/client.sqlite',
        CASE_REVIEW_URL: 'http://case-system:8001',
        WEB_ROOT: '/web',
        AGENTS: JSON.stringify([{ id: 'knowledge', name: 'Clash', description: '', url: 'http://agent:8080' }]),
      }),
    /reserved/,
  );
});
