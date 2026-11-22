// The case system's settings, read by name from the environment object given. Pure, so it is tested
// with plain objects; main.ts turns a missing setting into an exit.

import type { AccessTokenSettings } from '../../../shared/access-token.ts';
import { AGENT_SERVER_SCOPES, REVIEW_SERVER_SCOPES } from './scopes.ts';

export type CaseSystemSettings = {
  databasePath: string;
  // The token check of each server: the same issuer, audience and roles claim, its own clients, and the
  // scopes of its own tools or routes. A token needs only to be valid now: a call here is short.
  agentServerAuth: AccessTokenSettings;
  reviewServerAuth: AccessTokenSettings;
};

function required(env: Readonly<Record<string, string | undefined>>, name: string, meaning: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value.trim();
}

function clients(env: Readonly<Record<string, string | undefined>>, name: string, server: string): string[] {
  const listed = required(env, name, `the client ids an access token for the ${server} may be issued to, separated by commas`)
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client !== '');
  if (listed.length === 0) {
    throw new Error(`${name} names no client id.`);
  }
  return listed;
}

export function settingsFrom(env: Readonly<Record<string, string | undefined>>): CaseSystemSettings {
  const agentClients = clients(env, 'AUTH_AGENT_SERVER_CLIENTS', "agents' server");
  const reviewClients = clients(env, 'AUTH_REVIEW_SERVER_CLIENTS', 'review server');
  const shared = {
    discoveryUrl: required(env, 'AUTH_DISCOVERY_URL', "where to fetch the identity provider's discovery document"),
    issuer: required(env, 'AUTH_ISSUER', 'the issuer the discovery document and every access token must name'),
    audience: required(env, 'AUTH_ALLOWED_AUDIENCE', "a value that must be in the access token's aud"),
    rolesClaim: required(env, 'AUTH_ROLES_CLAIM', "the access-token claim holding the caller's roles"),
    minRemainingSeconds: 0,
  };
  return {
    databasePath: required(env, 'CASE_DB_PATH', 'the path of the SQLite file that holds the cases'),
    agentServerAuth: { ...shared, allowedClients: agentClients, requiredScopes: AGENT_SERVER_SCOPES },
    reviewServerAuth: { ...shared, allowedClients: reviewClients, requiredScopes: REVIEW_SERVER_SCOPES },
  };
}
