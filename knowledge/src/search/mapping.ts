// How chunks are held in the search engine, and the name of the index that holds them.
//
// Searched as text (standard analyzer): text, context, drug. Exact keywords: drug.exact (case-insensitive, trimmed),
// setId, version, kind, format, part, type, section.id, section.code, section.number. Everything else is stored
// and returned but not searched. The mapping is strict: a chunk with a field not named here is refused.

import { createHash } from 'node:crypto';

export const INDEX_PREFIX = 'labels-';

const stored = { type: 'keyword', index: false } as const;
const storedText = { type: 'text', index: false } as const;
const keyword = { type: 'keyword' } as const;

export const INDEX_DEFINITION = {
  settings: {
    index: { number_of_shards: 1, number_of_replicas: 0 },
    analysis: {
      normalizer: { exact_name: { type: 'custom', filter: ['lowercase', 'trim'] } },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: stored,
      setId: keyword,
      version: keyword,
      // Not searched, but sortable: find_labels lists the newest first.
      effectiveTime: stored,
      kind: keyword,
      format: keyword,
      documentTypeCode: stored,
      drug: { type: 'text', analyzer: 'standard', fields: { exact: { type: 'keyword', normalizer: 'exact_name' } } },
      section: {
        properties: {
          id: keyword,
          code: keyword,
          number: keyword,
          title: stored,
          path: stored,
        },
      },
      part: keyword,
      type: keyword,
      position: { type: 'object', enabled: false },
      text: { type: 'text', analyzer: 'standard' },
      repeated: storedText,
      context: { type: 'text', analyzer: 'standard' },
      words: { type: 'integer', index: false },
      source: stored,
    },
  },
} as const;

// JSON with keys in sorted order, so the same definition always gives the same bytes.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The index named from what it holds: the chunk report's bytes and the index definition.
export function indexName(chunkReport: Uint8Array, definition: unknown = INDEX_DEFINITION): string {
  const hash = createHash('sha256').update(chunkReport).update('\n').update(stableJson(definition)).digest('hex')
  return `${INDEX_PREFIX}${hash.slice(0, 16)}`;
}
