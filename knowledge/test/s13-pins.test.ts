// S13. The scripts and compose files pin the search engine and Node by digest; the search service publishes no port.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const knowledge = new URL('../', import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, knowledge), 'utf8');

const SEARCH_DIGEST = 'opensearchproject/opensearch@sha256:3bf4fe26aeb9f7b03c0ebcb1302bb24e855ee6b89fd926d26a71a83ef6f7e076';

test('S13. the search engine is pinned by digest and publishes no port; the retrieval service is built from the toolchain', () => {
  const compose = read('compose.yaml');
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((match) => match[1]);
  // The only images: the search engine by digest, and the retrieval service's own build.
  assert.deepEqual(images, [SEARCH_DIGEST, 'ai-on-aws-knowledge:local']);

  // The search service's block: no ports key.
  const search = /\n {2}search:\n([\s\S]*?)\n {2}knowledge:\n/.exec(compose)?.[1] ?? '';
  assert.notEqual(search, '');
  assert.doesNotMatch(search, /^\s*ports:/m);
  // The retrieval service is built from the run stage of toolchain/Dockerfile, which pins Node by digest.
  const service = compose.slice(compose.indexOf('\n  knowledge:\n'));
  assert.match(service, /dockerfile: toolchain\/Dockerfile\n\s*target: run\n\s*args:\n\s*PIECE: knowledge/);
  assert.match(service, /"127\.0\.0\.1:8002:8000"/);
});

test('S13. the scripts and the gate reach Node only through the image built from toolchain/Dockerfile', () => {
  for (const script of ['index.sh', 'gate.sh']) {
    const text = read(script);
    assert.match(text, /^\. ".*\/lib\.sh"$/m, `${script} must use lib.sh`);
    assert.match(text, /^build_image$/m, `${script} must build the image`);
    assert.doesNotMatch(text, /\bnode[:@]/, `${script} names a Node image itself`);
  }
  const gate = read('gate/compose.yaml');
  assert.match(gate, /image: \$\{KNOWLEDGE_IMAGE:\?/);
  assert.doesNotMatch(gate, /\bnode[:@]/);
  assert.doesNotMatch(gate, /^\s*ports:/m);
});
