// The index command's invariants ("Always true" 29, 30 and 37 in docs/architecture/knowledge.md), one test each, and
// one wiring probe. The search engine is an in-memory engine that holds indexes and an alias as OpenSearch does; the
// chunks and vectors are made from invented labels by the real parse, chunk and embed stages.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { chunkPath } from '../src/chunk/run.ts';
import { sha256 } from '../src/files.ts';
import type { Engine, EngineAnswer } from '../src/search/engine.ts';
import { IndexingError, indexChunks } from '../src/search/indexing.ts';
import { INDEX_DEFINITION, indexName } from '../src/search/mapping.ts';
import { chunked, cli, embedded, folders, guid, label, memoryEngine, noResponse, ok, recorder, section } from './support.ts';
import type { Folders, Held } from './support.ts';

const TWO = section('1 USES', '<paragraph>Invented uses.</paragraph>') + section('2 DOSE', '<paragraph>Invented doses.</paragraph>');
const index = (engine: Engine, where: Folders) => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1 << 20, log: () => {} });
const indexFlags = (where: Folders): string[] => ['--data', where.dataDir, '--search-url', 'http://search.test', '--alias', 'labels', '--batch-bytes', '1000000', '--timeout-ms', '1000'];

test('knowledge 29. the alias points only at an index holding every chunk; any failure leaves the alias, removes the new index or names it, and never removes the index the alias points at', async (t) => {
  const where = await folders(t);
  await chunked(where, [label(1, TWO)]);
  const name = (await index(memoryEngine().engine, where)).index;
  const OLD = 'labels-0000000000000000';
  const fail = (): EngineAnswer => ok({ error: { type: 'invented_failure' } }, 500);
  type Hook = Parameters<typeof memoryEngine>[0];
  const rows: { name: string; on?: Hook; held?: (held: Held) => void; expected: { exit: number; alias: string[]; documents: number | null; wrote: boolean } }[] = [
    {
      name: 'an item refused',
      on: (r, apply) => (r.path === '/_bulk' ? (apply(), ok({ errors: true, items: [{ index: { status: 400, error: { type: 'mapper_parsing_exception' } } }] })) : apply()),
      expected: { exit: 1, alias: [OLD], documents: null, wrote: true },
    },
    { name: 'a count that differs', on: (r, apply) => (r.method === 'GET' && r.path === `/${name}/_count` ? ok({ count: 1 }) : apply()), expected: { exit: 1, alias: [OLD], documents: null, wrote: true } },
    { name: 'a refresh that fails', on: (r, apply) => (r.path.endsWith('/_refresh') ? fail() : apply()), expected: { exit: 2, alias: [OLD], documents: null, wrote: true } },
    { name: 'an alias move that fails', on: (r, apply) => (r.path === '/_aliases' ? fail() : apply()), expected: { exit: 2, alias: [OLD], documents: null, wrote: true } },
    { name: 'an alias move made, its answer lost', on: (r, apply) => (r.path === '/_aliases' ? (apply(), { kind: 'timeout' } as const) : apply()), expected: { exit: 0, alias: [name], documents: 2, wrote: true } },
    { name: 'a removal that fails', on: (r, apply) => (r.path === '/_bulk' || r.method === 'DELETE' ? fail() : apply()), expected: { exit: 2, alias: [OLD], documents: 0, wrote: true } },
    {
      name: 'this index, the wrong count, the alias on it',
      held: (held) => (held.indexes.set(name, new Map([['x', {}]])), held.aliases.set('labels', [name])),
      expected: { exit: 2, alias: [name], documents: 1, wrote: false },
    },
    { name: 'this index, the wrong count, no alias on it', held: (held) => void held.indexes.set(name, new Map([['x', {}]])), expected: { exit: 0, alias: [name], documents: 2, wrote: true } },
  ];
  for (const row of rows) {
    const { engine, held, sent } = memoryEngine(row.on);
    held.indexes.set(OLD, new Map([['old', {}]]));
    held.aliases.set('labels', [OLD]);
    row.held?.(held);
    const outcome = await index(engine, where).then(
      (done) => ({ exit: done.exitCode, message: '' }),
      (error: unknown) => ({ exit: error instanceof IndexingError ? 2 : -1, message: String(error) }),
    );
    const wrote = sent.some((r) => r.method === 'PUT' || r.method === 'DELETE' || r.path === '/_bulk');
    assert.deepEqual({ exit: outcome.exit, alias: held.aliases.get('labels'), documents: held.indexes.get(name)?.size ?? null, wrote }, row.expected, row.name);
    if (row.name === 'a removal that fails') assert.ok(outcome.message.includes(name), 'the index left behind is not named');
  }
});

test('knowledge 30. an index is named from the chunk report, the embed report and the mapping; a file changed since its report is refused; unchanged input changes nothing; an embed report of other chunks builds nothing', async (t) => {
  const where = await folders(t);
  await chunked(where, [label(1, TWO)]);
  const { engine, sent } = memoryEngine();
  const writesSince = (from: number) => sent.slice(from).filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
  const refusedUnsent = async (path: string, change: (text: string) => string, name: string): Promise<void> => {
    const bytes = await readFile(path);
    await writeFile(path, change(bytes.toString()));
    const from = sent.length;
    await assert.rejects(index(engine, where), IndexingError, name);
    assert.equal(sent.length, from, `${name}: something was sent`);
    await writeFile(path, bytes);
  };

  const first = await index(engine, where);
  let from = sent.length;
  assert.equal((await index(engine, where)).changed, 'nothing');
  assert.deepEqual(writesSince(from), [], 'unchanged input');
  await refusedUnsent(chunkPath(where.dataDir, guid(1), 1), (text) => text.replace('Invented uses', 'Invented usez'), 'a chunk file changed');

  await chunked(where, [label(1, TWO.replace('Invented uses', 'Other uses'))]);
  const rechunked = await index(engine, where);
  assert.notEqual(rechunked.index, first.index, 'other chunks');
  await embedded(where);
  const withVectors = await index(engine, where);
  assert.notEqual(withVectors.index, rechunked.index, 'vectors');
  await refusedUnsent(join(where.dataDir, 'vectors', guid(1), '1.jsonl'), (text) => text.replace('"vector":"A', '"vector":"B'), 'a vector file changed');

  await chunked(where, [label(1, TWO.replace('Invented uses', 'Third uses'))]);
  from = sent.length;
  const other = await index(engine, where);
  assert.deepEqual([other.exitCode, other.changed, writesSince(from)], [1, 'embed-report-for-other-chunks', []]);

  const report = await readFile(join(where.dataDir, 'chunk-report.json'));
  assert.notEqual(indexName(report, INDEX_DEFINITION), indexName(report, { ...INDEX_DEFINITION, settings: { index: { number_of_shards: 2 } } }), 'the mapping');
});

test('knowledge 37. no parser\'s message about label data reaches the index command\'s output: a line that is not JSON is named by its file and line number', async (t) => {
  const where = await folders(t);
  await chunked(where, [label(1, TWO)]);
  const MARK = 'Peppercorn';
  const file = chunkPath(where.dataDir, guid(1), 1);
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.splice(1, 0, `{"text": "${MARK} words" unclosed`);
  const bytes = lines.join('\n');
  await writeFile(file, bytes);
  const reportPath = join(where.dataDir, 'chunk-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { labels: { sha256: string }[] };
  for (const entry of report.labels) entry.sha256 = sha256(Buffer.from(bytes));
  await writeFile(reportPath, JSON.stringify(report));
  const run = await cli(['index', ...indexFlags(where)]);
  const output = [...run.out, ...run.err].join('\n');
  assert.equal(run.code, 2);
  assert.ok(output.includes(`chunks/${guid(1)}/1.jsonl line 2`), output);
  assert.equal(output.includes(MARK) || /JSON at position|Unexpected token/.test(output), false, output);
});

test('knowledge probe: the index command reads its flags and builds the index over the engine\'s REST API', async (t) => {
  const where = await folders(t);
  await chunked(where, [label(1, TWO)]);
  const { engine, held } = memoryEngine();
  const web = recorder(async (sent) => {
    const url = new URL(sent.url);
    const body = sent.body === '' ? undefined : sent.headers['content-type'] === 'application/json' ? (JSON.parse(sent.body) as unknown) : sent.body;
    const answer = await engine.send(sent.method as 'GET', `${url.pathname}${url.search}`, body);
    return answer.kind === 'answer' ? new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status }) : noResponse();
  });
  const run = await cli(['index', ...indexFlags(where)], web.fetch);
  assert.equal(run.code, 0, run.err.join('\n'));
  const [target = ''] = held.aliases.get('labels') ?? [];
  assert.equal(held.indexes.get(target)?.size, 2);
});
