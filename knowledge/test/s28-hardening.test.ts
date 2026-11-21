// S28 (T7). The compose file hardens both services: all capabilities dropped, no new privileges, an init process;
// the retrieval service's root filesystem is read-only. The search engine's is not, for the reason the file gives
// (OpenSearch writes its keystore into its configuration folder at every start). Read as text.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');

function block(service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  assert.notEqual(start, -1, service);
  const rest = compose.slice(start + service.length + 4);
  const end = rest.search(/\n {2}\S|\n\S/);
  return end === -1 ? rest : rest.slice(0, end);
}

for (const service of ['search', 'knowledge']) {
  test(`S28. ${service}: all capabilities dropped, no new privileges, init`, () => {
    const text = block(service);
    assert.match(text, /\n {4}cap_drop:\n {6}- ALL\n/);
    assert.match(text, /\n {4}security_opt:\n {6}- no-new-privileges:true\n/);
    assert.match(text, /\n {4}init: true\n/);
    assert.doesNotMatch(text, /cap_add|privileged/);
  });
}

test('S28. knowledge has a read-only root; search has none, and says why', () => {
  assert.match(block('knowledge'), /\n {4}read_only: true\n/);
  const search = block('search');
  assert.doesNotMatch(search, /read_only: true/);
  assert.match(search, /# No read_only: .*keystore/s);
});
