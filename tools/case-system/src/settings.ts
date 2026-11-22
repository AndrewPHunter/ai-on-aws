// The case system's settings, read by name from the environment object given. Pure, so it is tested
// with plain objects; main.ts turns a missing setting into an exit.

import type { AccessTokenSettings } from '../../../shared/access-token.ts';

export type CaseSystemSettings = {
  databasePath: string;
  // A token needs only to be valid now: a call here is short.
  auth: AccessTokenSettings;
  // The role a token must list for its holder to decide a case.
  reviewerRole: string;
};

function required(env: Readonly<Record<string, string | undefined>>, name: string, meaning: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value.trim();
}

export function settingsFrom(env: Readonly<Record<string, string | undefined>>): CaseSystemSettings {
  const clients = required(env, 'AUTH_ALLOWED_CLIENTS', 'the client ids an access token may be issued to, separated by commas')
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client !== '');
  if (clients.length === 0) {
    throw new Error('AUTH_ALLOWED_CLIENTS names no client id.');
  }
  const scopes = required(env, 'AUTH_REQUIRED_SCOPES', 'the scopes an access token must hold at least one of, separated by commas')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  if (scopes.length === 0) {
    throw new Error('AUTH_REQUIRED_SCOPES names no scope.');
  }
  return {
    databasePath: required(env, 'CASE_DB_PATH', 'the path of the SQLite file that holds the cases'),
    auth: {
      discoveryUrl: required(env, 'AUTH_DISCOVERY_URL', "where to fetch the identity provider's discovery document"),
      issuer: required(env, 'AUTH_ISSUER', 'the issuer the discovery document and every access token must name'),
      audience: required(env, 'AUTH_ALLOWED_AUDIENCE', "a value that must be in the access token's aud"),
      allowedClients: clients,
      requiredScopes: scopes,
      rolesClaim: required(env, 'AUTH_ROLES_CLAIM', "the access-token claim holding the caller's roles"),
      minRemainingSeconds: 0,
    },
    reviewerRole: required(env, 'AUTH_REVIEWER_ROLE', 'the role a token must list for its holder to decide a case'),
  };
}
