// Builds what search_label ranks with from the service's settings: nothing for keyword; the embedding server for
// vector and fused; the reranker as well for fused_reranked. Each model request has its own time limit, and every
// search, whatever its strategy, has one limit for the whole of it (limits.ts).

import { createModelClient } from '../vectors/model-client.ts';
import { DEFAULT_SEARCH_LIMIT, EMBEDDING_REQUEST_MS, RERANK_REQUEST_MS } from './limits.ts';
import type { SearchLimit } from './limits.ts';
import type { RetrievalSettings } from './settings.ts';
import { KEYWORD } from './tools.ts';
import type { Retriever } from './tools.ts';

export function retrieverFrom(settings: Pick<RetrievalSettings, 'strategy' | 'models'>, transport: typeof fetch, limit: SearchLimit = DEFAULT_SEARCH_LIMIT): Retriever {
  const { strategy, models } = settings;
  if (strategy === 'keyword' || models === null) return { ...KEYWORD, verdicts: new Map(), limit };
  const embedding = {
    client: createModelClient({ baseUrl: models.embed.baseUrl, apiKey: models.apiKey, fetch: transport, deadline: () => AbortSignal.timeout(EMBEDDING_REQUEST_MS) }),
    modelId: models.embed.modelId,
    identity: models.embed.identity,
  };
  const rerank =
    models.rerank === null
      ? null
      : {
          client: createModelClient({ baseUrl: models.rerank.baseUrl, apiKey: models.apiKey, fetch: transport, deadline: () => AbortSignal.timeout(RERANK_REQUEST_MS) }),
          modelId: models.rerank.modelId,
        };
  return { strategy, embedding, rerank, verdicts: new Map(), limit };
}
