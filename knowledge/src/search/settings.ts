// The retrieval service's settings, read by name from the environment object given. Pure, so it is tested with
// plain objects; server.ts turns a missing setting into an exit.
//
// SEARCH_STRATEGY says how search_label ranks: keyword, vector, fused or fused_reranked. The model never chooses it.
// For any strategy but keyword the embedding server's address and model name, the key, and the embedding identity
// (repository, revision, dimensions) are required; for fused_reranked the reranker's address and model name too.
// With keyword none of them is read.

import type { AccessTokenSettings } from '../../../shared/access-token.ts';
import type { ConfiguredIdentity } from '../vectors/recipe.ts';

export const STRATEGIES = ['keyword', 'vector', 'fused', 'fused_reranked'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type ModelSettings = {
  // The key every model server expects. Sent to the two model servers only.
  apiKey: string;
  embed: { baseUrl: string; modelId: string; identity: ConfiguredIdentity };
  rerank: { baseUrl: string; modelId: string } | null;
};

export type RetrievalSettings = {
  // The search engine's REST address on the stack's network.
  searchUrl: string;
  // The alias searched: the index command points it at the index it built.
  searchIndex: string;
  strategy: Strategy;
  // Null for keyword.
  models: ModelSettings | null;
  // A token needs only to be valid now: a call here is short.
  auth: AccessTokenSettings;
};

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string, meaning: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value.trim();
}

function modelUrl(env: Env, name: string, meaning: string): string {
  const value = required(env, name, meaning).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+\/v1$/.test(value)) throw new Error(`${name} must be an http or https address ending in /v1.`);
  return value;
}

function modelSettingsFrom(env: Env, strategy: Strategy): ModelSettings | null {
  if (strategy === 'keyword') return null;
  const embedBaseUrl = modelUrl(env, 'MODEL_EMBED_BASE_URL', "the embedding server's address, ending in /v1 (model/.env)");
  const embedModelId = required(env, 'EMBED_MODEL_ID', 'the name the embedding server serves its model under (model/retrieval.env)');
  const apiKey = required(env, 'MODEL_API_KEY', 'the key the model servers expect (model/.env)');
  const repository = required(env, 'EMBED_MODEL_REPO', "the embedding model's repository (model/retrieval.env)");
  const revision = required(env, 'EMBED_MODEL_REVISION', "the embedding model's revision (model/retrieval.env)");
  const dimensionsText = required(env, 'EMBED_DIMENSIONS', 'the numbers in each vector (model/retrieval.env)');
  if (!/^[1-9]\d*$/.test(dimensionsText)) throw new Error('EMBED_DIMENSIONS must be a whole number.');
  let rerank: ModelSettings['rerank'] = null;
  if (strategy === 'fused_reranked') {
    rerank = {
      baseUrl: modelUrl(env, 'MODEL_RERANK_BASE_URL', "the reranker's address, ending in /v1 (model/.env)"),
      modelId: required(env, 'RERANK_MODEL_ID', 'the name the reranker serves its model under (model/retrieval.env)'),
    };
  }
  return { apiKey, embed: { baseUrl: embedBaseUrl, modelId: embedModelId, identity: { repository, revision, dimensions: Number(dimensionsText) } }, rerank };
}

export function retrievalSettingsFrom(env: Env): RetrievalSettings {
  const searchUrl = required(env, 'SEARCH_URL', "the search engine's address, such as http://search:9200");
  if (!/^https?:\/\/[^/\s]+$/.test(searchUrl)) {
    throw new Error('SEARCH_URL must be an http or https origin with no path, such as http://search:9200.');
  }
  const searchIndex = required(env, 'SEARCH_INDEX', 'the index or alias searched, such as labels');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(searchIndex)) {
    throw new Error('SEARCH_INDEX must be a lowercase index or alias name.');
  }
  const named = required(env, 'SEARCH_STRATEGY', `how search_label ranks: ${STRATEGIES.join(', ')}`);
  const strategy = STRATEGIES.find((candidate) => candidate === named);
  if (strategy === undefined) throw new Error(`SEARCH_STRATEGY must be one of ${STRATEGIES.join(', ')}.`);
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
    strategy,
    models: modelSettingsFrom(env, strategy),
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
