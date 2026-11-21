// The retrieval service's settings, read by name from the environment object given. Pure, so it is tested with
// plain objects; server.ts turns a missing setting into an exit.

import type { AccessTokenSettings } from '../../../shared/access-token.ts';

export type RetrievalSettings = {
  // The search engine's REST address on the stack's network.
  searchUrl: string;
  // The alias searched: the index command points it at the index it built.
  searchIndex: string;
  // A token needs only to be valid now: a call here is short.
  auth: AccessTokenSettings;
};

function required(env: Readonly<Record<string, string | undefined>>, name: string, meaning: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value.trim();
}

export function retrievalSettingsFrom(env: Readonly<Record<string, string | undefined>>): RetrievalSettings {
  const searchUrl = required(env, 'SEARCH_URL', "the search engine's address, such as http://search:9200");
  if (!/^https?:\/\/[^/\s]+$/.test(searchUrl)) {
    throw new Error('SEARCH_URL must be an http or https origin with no path, such as http://search:9200.');
  }
  const searchIndex = required(env, 'SEARCH_INDEX', 'the index or alias searched, such as labels');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(searchIndex)) {
    throw new Error('SEARCH_INDEX must be a lowercase index or alias name.');
  }
  const clients = required(env, 'AUTH_ALLOWED_CLIENTS', 'the client ids an access token may be issued to, separated by commas')
    .split(',')
    .map((client) => client.trim())
    .filter((client) => client !== '');
  if (clients.length === 0) {
    throw new Error('AUTH_ALLOWED_CLIENTS names no client id.');
  }
  return {
    searchUrl,
    searchIndex,
    auth: {
      discoveryUrl: required(env, 'AUTH_DISCOVERY_URL', "where to fetch the identity provider's discovery document"),
      issuer: required(env, 'AUTH_ISSUER', 'the issuer the discovery document and every access token must name'),
      audience: required(env, 'AUTH_ALLOWED_AUDIENCE', "a value that must be in the access token's aud"),
      allowedClients: clients,
      rolesClaim: required(env, 'AUTH_ROLES_CLAIM', "the access-token claim holding the caller's roles"),
      minRemainingSeconds: 0,
    },
  };
}
