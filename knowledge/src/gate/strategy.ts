// The gate's statements about the strategy the running service answered with, as pure functions over what it
// returned and what the index records.

import { identityDifferences } from '../vectors/recipe.ts';
import type { ConfiguredIdentity, EmbeddingIdentity } from '../vectors/recipe.ts';

export const KNOWN_STRATEGIES = ['keyword', 'vector', 'fused', 'fused_reranked'] as const;
export type KnownStrategy = (typeof KNOWN_STRATEGIES)[number];

export function strategyOf(payload: Record<string, unknown>): KnownStrategy | null {
  const named = payload.strategy;
  return KNOWN_STRATEGIES.find((strategy) => strategy === named) ?? null;
}

export const usesVectors = (strategy: KnownStrategy): boolean => strategy !== 'keyword';

type Ranks = { keyword?: unknown; vector?: unknown; fused?: unknown; reranked?: unknown };

const isRank = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const isNull = (value: unknown): boolean => value === null;

// Whether one passage carries the ranks its strategy computes: a rank from 1 in each list the strategy always
// computes, and null in each list it does not. A fused passage is in the keyword list, the vector list, or both.
export function carriesRanks(ranks: unknown, strategy: KnownStrategy): boolean {
  if (typeof ranks !== 'object' || ranks === null) return false;
  const { keyword, vector, fused, reranked } = ranks as Ranks;
  const either = (isRank(keyword) || isNull(keyword)) && (isRank(vector) || isNull(vector)) && (isRank(keyword) || isRank(vector));
  switch (strategy) {
    case 'keyword':
      return isRank(keyword) && isNull(vector) && isNull(fused) && isNull(reranked);
    case 'vector':
      return isNull(keyword) && isRank(vector) && isNull(fused) && isNull(reranked);
    case 'fused':
      return either && isRank(fused) && isNull(reranked);
    case 'fused_reranked':
      return either && isRank(fused) && isRank(reranked);
  }
}

export function everyPassageCarriesRanks(passages: readonly { ranks?: unknown }[], strategy: KnownStrategy): boolean {
  return passages.every((passage) => carriesRanks(passage.ranks, strategy));
}

// The fields of the identity an index records that differ from the configured one (model/retrieval.env) and this
// code's recipe and instruction. ['identity'] when the index records none, or one that cannot be read.
export function recordedIdentityDifferences(recorded: unknown, configured: ConfiguredIdentity): string[] {
  if (typeof recorded !== 'object' || recorded === null) return ['identity'];
  const value = recorded as Partial<EmbeddingIdentity>;
  if (
    typeof value.repository !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.dimensions !== 'number' ||
    typeof value.recipe !== 'string' ||
    typeof value.instruction !== 'string' ||
    typeof value.vectorsSha256 !== 'string'
  ) {
    return ['identity'];
  }
  return identityDifferences(value as EmbeddingIdentity, configured);
}

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

// The embedding identity an engine's GET /<alias>/_mapping answer records for the one index the alias points at;
// undefined when the answer does not name exactly one index.
export function recordedEmbedding(mapping: unknown): unknown {
  const names = typeof mapping === 'object' && mapping !== null ? Object.keys(mapping) : [];
  const [index] = names;
  if (index === undefined || names.length !== 1) return undefined;
  return field(field(field(field(mapping, index), 'mappings'), '_meta'), 'embedding');
}

// The configured identity, from the environment the gate is given (model/retrieval.env); null when any part is
// missing.
export function configuredIdentity(env: Readonly<Record<string, string | undefined>>): ConfiguredIdentity | null {
  const repository = env.EMBED_MODEL_REPO?.trim();
  const revision = env.EMBED_MODEL_REVISION?.trim();
  const dimensions = env.EMBED_DIMENSIONS?.trim();
  if (!repository || !revision || !dimensions || !/^[1-9]\d*$/.test(dimensions)) return null;
  return { repository, revision, dimensions: Number(dimensions) };
}
