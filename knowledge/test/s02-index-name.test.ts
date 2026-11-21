// S2. The index name changes when the chunk report's content changes and when the mapping changes, and is the same
// for the same inputs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INDEX_DEFINITION, indexName } from '../src/search/mapping.ts';

const REPORT = Buffer.from('{"chunks":{"total":3}}\n');

test('S2. the index name follows the chunk report and the mapping', () => {
  const name = indexName(REPORT);
  assert.match(name, /^labels-[0-9a-f]{16}$/);
  assert.equal(indexName(Buffer.from(REPORT)), name);
  assert.notEqual(indexName(Buffer.from('{"chunks":{"total":4}}\n')), name);
  const otherMapping = { ...INDEX_DEFINITION, settings: { ...INDEX_DEFINITION.settings, index: { number_of_shards: 2, number_of_replicas: 0 } } };
  assert.notEqual(indexName(REPORT, otherMapping), name);
  // The same definition with its keys in another order is the same definition.
  const reordered = { mappings: INDEX_DEFINITION.mappings, settings: INDEX_DEFINITION.settings };
  assert.equal(indexName(REPORT, reordered), name);
});
