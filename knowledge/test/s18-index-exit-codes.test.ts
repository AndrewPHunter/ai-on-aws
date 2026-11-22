// S18 (D4, D7). The index command's exit code for each outcome: 0 the alias points at a complete index; 1 items
// refused, or the count differed; 2 could not run: a missing chunk report, a chunk report or a chunk line that is not
// JSON (each naming the file, and the line for a chunk file), and a search engine that cannot be reached. Nothing of
// a chunk's text reaches standard error or standard output.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { sha256 } from '../src/files.ts';
import { indexName } from '../src/search/mapping.ts';
import { command } from './support/command.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { SET_ID } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';

const indexArgs = (dataDir: string, url: string): string[] => [
  'index', '--data', dataDir, '--search-url', url, '--alias', 'labels', '--batch-bytes', '1500', '--timeout-ms', '5000',
];

async function rig(t: TestContext) {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  return { where, standIn, fake, run: () => command(indexArgs(where.dataDir, standIn.url)) };
}

test('S18. exit 0: built, then nothing to change', async (t) => {
  const { where, run } = await rig(t);
  await writeChunks(where.dataDir, 3);
  assert.equal((await run()).code, 0);
  assert.equal((await run()).code, 0);
});

test('S18. exit 1: items refused', async (t) => {
  const { where, fake, run } = await rig(t);
  await writeChunks(where.dataDir, 3);
  fake.refuse(1);
  const outcome = await run();
  assert.equal(outcome.code, 1);
  assert.match(outcome.out.join('\n'), /refused 1 items/);
});

test('S18. exit 1: the count differed', async (t) => {
  const { where, fake, run } = await rig(t);
  await writeChunks(where.dataDir, 3);
  fake.shortCount(indexName(await readFile(join(where.dataDir, 'chunk-report.json'))));
  assert.equal((await run()).code, 1);
});

test('S18. exit 2: no chunk report, naming the file', async (t) => {
  const { where, standIn, run } = await rig(t);
  const outcome = await run();
  assert.equal(outcome.code, 2);
  assert.match(outcome.err.join('\n'), /chunk-report\.json does not exist: run knowledge\/chunk\.sh/);
  assert.deepEqual(standIn.received, []);
});

test('S18. exit 2: a chunk report that is not JSON, naming the file', async (t) => {
  const { where, run } = await rig(t);
  await writeFile(join(where.dataDir, 'chunk-report.json'), '{"chunks": Invented text');
  const outcome = await run();
  assert.equal(outcome.code, 2);
  const said = [...outcome.err, ...outcome.out].join('\n');
  assert.match(said, /chunk-report\.json is not JSON: run knowledge\/chunk\.sh/);
  assert.doesNotMatch(said, /Invented/);
});

test('S18. exit 2: a chunk line that is not JSON, naming the file and the line, and no label text', async (t) => {
  const { where, standIn, run } = await rig(t);
  await writeChunks(where.dataDir, 2);
  // The second line cut short, and the report's hash made to match, so it is the line that is refused.
  const path = join(where.dataDir, 'chunks', SET_ID, '3.jsonl');
  const lines = (await readFile(path, 'utf8')).split('\n');
  lines[1] = (lines[1] ?? '').slice(0, 40);
  const broken = lines.join('\n');
  await writeFile(path, broken);
  const report = JSON.parse(await readFile(join(where.dataDir, 'chunk-report.json'), 'utf8')) as { labels: { sha256: string }[] };
  const [label] = report.labels;
  if (label !== undefined) label.sha256 = sha256(Buffer.from(broken));
  await writeFile(join(where.dataDir, 'chunk-report.json'), JSON.stringify(report));

  const outcome = await run();

  assert.equal(outcome.code, 2);
  const said = [...outcome.err, ...outcome.out].join('\n');
  assert.match(said, new RegExp(`chunks/${SET_ID}/3\\.jsonl line 2 is not JSON: run knowledge/chunk\\.sh`));
  assert.doesNotMatch(said, /Invented|Examplamab|DOSAGE/);
  assert.deepEqual(standIn.received, []);
});

test('S18. exit 2: the search engine cannot be reached', async (t) => {
  const where = await folders(t);
  await writeChunks(where.dataDir, 2);
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => 'drop');
  const outcome = await command(indexArgs(where.dataDir, standIn.url));
  assert.equal(outcome.code, 2);
  assert.match(outcome.err.join('\n'), /could not be reached/);
});
