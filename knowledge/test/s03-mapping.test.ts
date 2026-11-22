// S3. The mapping holds each field with the type the contract gives it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Chunk } from '../src/chunk/model.ts';
import { INDEX_DEFINITION } from '../src/search/mapping.ts';

test('S3. searched text, exact keywords, and stored-only fields', () => {
  const p = INDEX_DEFINITION.mappings.properties;
  assert.equal(INDEX_DEFINITION.mappings.dynamic, 'strict');
  // Searched as text with the standard analyzer.
  assert.deepEqual(p.text, { type: 'text', analyzer: 'standard' });
  assert.deepEqual(p.context, { type: 'text', analyzer: 'standard' });
  // Drug names: text, and an exact keyword compared without case or surrounding space.
  assert.deepEqual(p.drug, { type: 'text', analyzer: 'standard', fields: { exact: { type: 'keyword', normalizer: 'exact_name' } } });
  assert.deepEqual(INDEX_DEFINITION.settings.analysis.normalizer.exact_name, { type: 'custom', filter: ['lowercase', 'trim'] });
  // Exact keywords.
  for (const field of [p.setId, p.version, p.kind, p.format, p.part, p.type, p.section.properties.id, p.section.properties.code, p.section.properties.number]) {
    assert.deepEqual(field, { type: 'keyword' });
  }
  // Stored and returned, not searched.
  for (const field of [p.id, p.effectiveTime, p.documentTypeCode, p.source, p.section.properties.title, p.section.properties.path]) {
    assert.deepEqual(field, { type: 'keyword', index: false });
  }
  assert.deepEqual(p.repeated, { type: 'text', index: false });
  assert.deepEqual(p.words, { type: 'integer', index: false });
  assert.deepEqual(p.position, { type: 'object', enabled: false });
});

test('S3. the mapping names every field of a chunk and no other', () => {
  const fields: (keyof Chunk)[] = [
    'id', 'setId', 'version', 'effectiveTime', 'kind', 'format', 'documentTypeCode', 'drug', 'section', 'part', 'type',
    'position', 'text', 'repeated', 'context', 'words', 'source',
  ];
  assert.deepEqual(Object.keys(INDEX_DEFINITION.mappings.properties).sort(), [...fields].sort());
  assert.deepEqual(Object.keys(INDEX_DEFINITION.mappings.properties.section.properties).sort(), ['code', 'id', 'number', 'path', 'title']);
});
