// Loads the chunks into the search engine under an index named from what it holds, and moves the alias to it only
// once the engine's count of documents equals the number of chunks read.
//
//   - The index already there with the right count and the alias on it: nothing is changed.
//   - The index there with the right count, the alias elsewhere: only the alias moves.
//   - Otherwise the index is (re)created with the explicit definition and every chunk is sent once. If the engine
//     refuses any item of a bulk request, or the count then differs, the alias stays where it was, the new index
//     is removed, and the result is a failure.
// Older indexes are left in place and listed.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { chunkPath } from '../chunk/run.ts';
import type { Engine, EngineAnswer } from './engine.ts';
import { INDEX_DEFINITION, INDEX_PREFIX, indexName } from './mapping.ts';

export type IndexOptions = {
  engine: Engine;
  dataDir: string;
  alias: string;
  // Chunks sent in one bulk request.
  batchSize: number;
  log: (line: string) => void;
};

export type IndexOutcome = {
  exitCode: 0 | 1;
  index: string;
  chunks: number;
  changed: 'nothing' | 'alias-moved' | 'built' | 'count-differed' | 'items-refused';
  olderIndexes: string[];
};

// The engine could not be asked, or answered in a way that stops the run. Nothing about the alias was changed.
export class IndexingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexingError';
  }
}

// The engine's answer to a bulk request: whether any item failed, and each item's result.
const bulkSchema = z.object({
  errors: z.boolean(),
  items: z.array(
    z.object({ index: z.object({ status: z.number().optional(), error: z.object({ type: z.string().optional() }).passthrough().nullable().optional() }).optional() }),
  ),
});

const reportSchema = z.object({
  chunks: z.object({ total: z.number().int().nonnegative() }),
  labels: z.array(z.object({ setId: z.string(), version: z.number().int().positive(), status: z.string() })),
});

function describe(answer: EngineAnswer): string {
  if (answer.kind === 'timeout') return 'the search engine did not answer in time';
  if (answer.kind === 'unreachable') return 'the search engine could not be reached';
  return `the search engine answered with status ${answer.status}`;
}

async function expect(engine: Engine, statuses: number[], method: Parameters<Engine['send']>[0], path: string, body?: unknown, type?: string): Promise<unknown> {
  const answer = await engine.send(method, path, body, type);
  if (answer.kind !== 'answer' || !statuses.includes(answer.status)) throw new IndexingError(`${method} ${path}: ${describe(answer)}`);
  return answer.body;
}

async function count(engine: Engine, index: string): Promise<number> {
  const body = await expect(engine, [200], 'GET', `/${index}/_count`);
  const parsed = z.object({ count: z.number().int().nonnegative() }).safeParse(body);
  if (!parsed.success) throw new IndexingError(`GET /${index}/_count: the answer has no count`);
  return parsed.data.count;
}

// The indexes the alias points at now; none if the alias does not exist.
async function aliasTargets(engine: Engine, alias: string): Promise<string[]> {
  const answer = await engine.send('GET', `/_alias/${alias}`);
  if (answer.kind === 'answer' && answer.status === 404) return [];
  if (answer.kind !== 'answer' || answer.status !== 200) throw new IndexingError(`GET /_alias/${alias}: ${describe(answer)}`);
  if (typeof answer.body !== 'object' || answer.body === null) throw new IndexingError(`GET /_alias/${alias}: the answer is not an object`);
  return Object.keys(answer.body).sort();
}

async function exists(engine: Engine, index: string): Promise<boolean> {
  const answer = await engine.send('HEAD', `/${index}`);
  if (answer.kind === 'answer' && (answer.status === 200 || answer.status === 404)) return answer.status === 200;
  throw new IndexingError(`HEAD /${index}: ${describe(answer)}`);
}

async function moveAlias(engine: Engine, alias: string, from: string[], to: string): Promise<void> {
  const actions: unknown[] = from.filter((index) => index !== to).map((index) => ({ remove: { index, alias } }));
  actions.push({ add: { index: to, alias } });
  await expect(engine, [200], 'POST', '/_aliases', { actions });
}

async function olderIndexes(engine: Engine, current: string): Promise<string[]> {
  const body = await expect(engine, [200], 'GET', `/_cat/indices/${INDEX_PREFIX}*?format=json&h=index`);
  const parsed = z.array(z.object({ index: z.string() })).safeParse(body);
  if (!parsed.success) throw new IndexingError('GET /_cat/indices: the answer is not a list of indexes');
  return parsed.data.map((row) => row.index).filter((index) => index !== current).sort();
}

export async function readChunks(dataDir: string): Promise<{ report: Buffer; total: number; chunks: { id: string }[] }> {
  const report = await readFile(join(dataDir, 'chunk-report.json'));
  const parsed = reportSchema.safeParse(JSON.parse(report.toString('utf8')));
  if (!parsed.success) throw new IndexingError('knowledge/data/chunk-report.json is not a chunk report: run knowledge/chunk.sh');
  const chunks: { id: string }[] = [];
  for (const label of parsed.data.labels) {
    if (label.status !== 'chunked') continue;
    const text = await readFile(chunkPath(dataDir, label.setId, label.version), 'utf8');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const chunk: unknown = JSON.parse(line);
      const id: unknown = typeof chunk === 'object' && chunk !== null ? Reflect.get(chunk, 'id') : undefined;
      if (typeof id !== 'string') throw new IndexingError(`a chunk of ${label.setId} has no id`);
      chunks.push(chunk as { id: string });
    }
  }
  if (chunks.length !== parsed.data.chunks.total) {
    throw new IndexingError(`the chunk files hold ${chunks.length} chunks, the chunk report counts ${parsed.data.chunks.total}: run knowledge/chunk.sh`);
  }
  return { report, total: parsed.data.chunks.total, chunks };
}

export async function indexChunks(options: IndexOptions): Promise<IndexOutcome> {
  const { engine, alias, log } = options;
  const { report, chunks } = await readChunks(options.dataDir);
  const index = indexName(report);
  log(`index ${index} for ${chunks.length} chunks`);

  const targets = await aliasTargets(engine, alias);
  if (await exists(engine, index)) {
    if ((await count(engine, index)) === chunks.length) {
      if (targets.length === 1 && targets[0] === index) {
        log(`nothing to change: ${index} holds ${chunks.length} documents and ${alias} points at it`);
        return { exitCode: 0, index, chunks: chunks.length, changed: 'nothing', olderIndexes: await olderIndexes(engine, index) };
      }
      await moveAlias(engine, alias, targets, index);
      log(`${index} already holds ${chunks.length} documents; ${alias} now points at it`);
      return { exitCode: 0, index, chunks: chunks.length, changed: 'alias-moved', olderIndexes: await olderIndexes(engine, index) };
    }
    if (targets.includes(index)) throw new IndexingError(`${index} has the wrong count but ${alias} points at it; not touching it`);
    log(`${index} exists with the wrong count: rebuilding it`);
    await expect(engine, [200], 'DELETE', `/${index}`);
  }

  await expect(engine, [200], 'PUT', `/${index}`, INDEX_DEFINITION);
  let failedItems = 0;
  let firstErrorType: string | null = null;
  for (let start = 0; start < chunks.length; start += options.batchSize) {
    const batch = chunks.slice(start, start + options.batchSize);
    const lines = batch.flatMap((chunk) => [JSON.stringify({ index: { _index: index, _id: chunk.id } }), JSON.stringify(chunk)]);
    const answer = bulkSchema.safeParse(await expect(engine, [200], 'POST', '/_bulk', `${lines.join('\n')}\n`, 'application/x-ndjson'));
    if (!answer.success) {
      await expect(engine, [200], 'DELETE', `/${index}`);
      throw new IndexingError(`POST /_bulk: the answer is not a bulk result; ${index} removed, ${alias} left as it was`);
    }
    for (const item of answer.data.items) {
      const error = item.index?.error;
      if (error === undefined || error === null) continue;
      failedItems++;
      firstErrorType ??= typeof error === 'object' && typeof error.type === 'string' && /^[a-z_]{1,80}$/.test(error.type) ? error.type : 'unknown';
    }
    if (answer.data.errors && failedItems === 0) {
      failedItems++;
      firstErrorType ??= 'unknown';
    }
  }
  if (failedItems > 0) {
    // An item the engine refused is a failure, whatever the count says afterwards.
    await expect(engine, [200], 'DELETE', `/${index}`);
    log(`the engine refused ${failedItems} items (first error type: ${firstErrorType ?? 'unknown'}): ${index} removed, ${alias} left as it was`);
    return { exitCode: 1, index, chunks: chunks.length, changed: 'items-refused', olderIndexes: await olderIndexes(engine, index) };
  }
  await expect(engine, [200], 'POST', `/${index}/_refresh`);
  const held = await count(engine, index);
  if (held !== chunks.length) {
    await expect(engine, [200], 'DELETE', `/${index}`);
    log(`the engine holds ${held} documents, ${chunks.length} chunks were read: ${index} removed, ${alias} left as it was`);
    return { exitCode: 1, index, chunks: chunks.length, changed: 'count-differed', olderIndexes: await olderIndexes(engine, index) };
  }
  await moveAlias(engine, alias, targets, index);
  log(`built ${index} with ${held} documents; ${alias} now points at it`);
  return { exitCode: 0, index, chunks: chunks.length, changed: 'built', olderIndexes: await olderIndexes(engine, index) };
}
