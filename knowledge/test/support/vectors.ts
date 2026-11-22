// What the vector tests (V01 to V18) share: the embed command's settings for the model stand-in, a retriever over the
// stand-ins whose deadlines the test controls, and the engine answers a vector search needs.

import { createModelClient } from '../../src/vectors/model-client.ts';
import { DOCUMENT_RECIPE, QUERY_INSTRUCTION } from '../../src/vectors/recipe.ts';
import type { EmbeddingIdentity } from '../../src/vectors/recipe.ts';
import type { Strategy } from '../../src/search/settings.ts';
import type { Retriever } from '../../src/search/tools.ts';
import type { SearchLimit } from '../../src/search/limits.ts';
import type { ModelStandIn } from './model-standin.ts';
import { hits } from './search-standin.ts';
import type { SearchReply, SearchRequest } from './search-standin.ts';

export const TEST_KEY = 'test-key-7f3a9c-not-a-real-key';
export const DIMENSIONS = 8;
export const REPOSITORY = 'example-org/test-embedding';
export const REVISION = '0123456789abcdef0123456789abcdef01234567';
export const CONCRETE = 'labels-00000000000000aa';

export function embedEnv(standIn: ModelStandIn, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    MODEL_EMBED_BASE_URL: standIn.baseUrl,
    MODEL_API_KEY: TEST_KEY,
    EMBED_MODEL_ID: 'test-embedding',
    EMBED_MODEL_REPO: REPOSITORY,
    EMBED_MODEL_REVISION: REVISION,
    EMBED_DIMENSIONS: String(DIMENSIONS),
    ...overrides,
  };
}

export const embedArgs = (dataDir: string): string[] => [
  'embed', '--data', dataDir, '--batch-size', '32', '--attempts', '3', '--waits-ms', '10,20', '--timeout-ms', '5000',
];

export const IDENTITY: EmbeddingIdentity = {
  repository: REPOSITORY,
  revision: REVISION,
  dimensions: DIMENSIONS,
  recipe: DOCUMENT_RECIPE,
  instruction: QUERY_INSTRUCTION,
  vectorsSha256: 'a'.repeat(64),
};

// A retriever over the model stand-in. Each client's deadline is a signal the test can end, so no test waits on a
// clock.
// The search's own limit is long unless the test gives one, so it never ends a search the test did not mean it to.
export function testRetriever(strategy: Strategy, standIn: ModelStandIn, limit: SearchLimit = { ms: 60_000, now: () => performance.now() }): { retriever: Retriever; expire: () => void } {
  let controller = new AbortController();
  const deadline = (): AbortSignal => {
    controller = new AbortController();
    return controller.signal;
  };
  const client = createModelClient({ baseUrl: standIn.baseUrl, apiKey: TEST_KEY, fetch: globalThis.fetch, deadline });
  return {
    retriever: {
      strategy,
      embedding: strategy === 'keyword' ? null : { client, modelId: 'test-embedding', identity: { repository: REPOSITORY, revision: REVISION, dimensions: DIMENSIONS } },
      rerank: strategy === 'fused_reranked' ? { client, modelId: 'test-reranker' } : null,
      verdicts: new Map(),
      limit,
    },
    expire: () => controller.abort(),
  };
}

// The engine's answer to GET /<alias>/_mapping: one concrete index, with the embedding identity it records.
export function mappingAnswer(identity: EmbeddingIdentity | null, index = CONCRETE): SearchReply {
  return { status: 200, body: { [index]: { mappings: { _meta: { embedding: identity } } } } };
}

export const isVectorSearch = (request: SearchRequest): boolean =>
  typeof request.body === 'object' && request.body !== null && JSON.stringify(request.body).includes('"script_score"');

// An engine for a vector strategy: the mapping, then keyword and vector searches answered from the lists given.
// Vector hits are scored as the engine scores them, (1 + cosine) / 2, from the cosines given.
export function vectorEngine(options: {
  identity?: EmbeddingIdentity | null;
  keyword?: Record<string, unknown>[];
  vector?: { source: Record<string, unknown>; cosine: number }[];
}): (request: SearchRequest) => SearchReply {
  return (request) => {
    if (request.method === 'GET' && request.path.endsWith('/_mapping')) return mappingAnswer(options.identity === undefined ? IDENTITY : options.identity);
    if (request.path.endsWith('/_count')) return { status: 200, body: { count: 1 } };
    if (isVectorSearch(request)) {
      const list = options.vector ?? [];
      return { status: 200, body: { hits: { total: { value: list.length }, hits: list.map((item) => ({ _score: (1 + item.cosine) / 2, _source: item.source })) } } };
    }
    return hits(options.keyword ?? []);
  };
}
