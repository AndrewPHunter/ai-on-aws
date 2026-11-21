// Loads the chunks into the search engine under an index named from what it holds, and moves the alias to it only
// once the engine's count of documents equals the number of chunks read.
//
//   - The index already there with the right count and the alias on it: nothing is changed.
//   - The index there with the right count, the alias elsewhere: only the alias moves.
//   - Otherwise the index is (re)created with the explicit definition and every chunk is sent once. If the engine
//     refuses any item of a bulk request, or the count then differs, the result is a failure (exit 1). If anything
//     else fails once the index may exist (the create, a bulk request refused as a whole or not answered, the
//     refresh, the count, the alias move), the run cannot go on (exit 2). Either way the new index is removed and
//     the alias stays where it was; if the removal fails, the run says so and names the index left behind.
// Older indexes are left in place and listed.
//
// The chunk report records the sha256 of each chunk file, and each file is checked against it before anything is
// sent. The index name comes from the report's bytes, so it changes whenever any chunk's bytes change.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { chunkPath } from '../chunk/run.ts';
import { sha256 } from '../files.ts';
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

// The run could not go on: a file it needs is missing or unreadable, or the engine could not be asked or answered in
// a way that stops it. The alias was not changed.
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
  labels: z.array(
    z.object({
      setId: z.string(),
      version: z.number().int().positive(),
      status: z.string(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  ),
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

// Reads a file the run needs. Missing or unreadable is "could not run", naming the file.
async function readNeeded(path: string, shown: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new IndexingError(`${shown} does not exist: run knowledge/chunk.sh`);
    throw new IndexingError(`${shown} could not be read`);
  }
}

// Parses JSON that came from label data. A failure names the file (and line) and never carries the parser's own
// message, which quotes the input.
function parseLabelJson(text: string, where: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new IndexingError(`${where} is not JSON: run knowledge/chunk.sh`);
  }
}

// The chunk report, and every chunk of every chunked label, each file checked against the sha256 the report records
// for it. The bytes hashed are the bytes parsed.
export async function readChunks(dataDir: string): Promise<{ report: Buffer; total: number; chunks: { id: string }[] }> {
  const report = await readNeeded(join(dataDir, 'chunk-report.json'), 'chunk-report.json');
  const parsed = reportSchema.safeParse(parseLabelJson(report.toString('utf8'), 'chunk-report.json'));
  if (!parsed.success) throw new IndexingError('chunk-report.json is not a chunk report: run knowledge/chunk.sh');
  const chunks: { id: string }[] = [];
  for (const label of parsed.data.labels) {
    if (label.status !== 'chunked') continue;
    const shown = `chunks/${label.setId}/${label.version}.jsonl`;
    if (label.sha256 === undefined) {
      throw new IndexingError(`chunk-report.json records no sha256 for the chunk file of ${label.setId}: run knowledge/chunk.sh again`);
    }
    const bytes = await readNeeded(chunkPath(dataDir, label.setId, label.version), shown);
    if (sha256(bytes) !== label.sha256) throw new IndexingError(`${shown} does not match the sha256 in the chunk report: run knowledge/chunk.sh again`);
    for (const [at, line] of bytes.toString('utf8').split('\n').entries()) {
      if (line === '') continue;
      const chunk = parseLabelJson(line, `${shown} line ${at + 1}`);
      const id: unknown = typeof chunk === 'object' && chunk !== null ? Reflect.get(chunk, 'id') : undefined;
      if (typeof id !== 'string') throw new IndexingError(`${shown} line ${at + 1} has no id`);
      chunks.push(chunk as { id: string });
    }
  }
  if (chunks.length !== parsed.data.chunks.total) {
    throw new IndexingError(`the chunk files hold ${chunks.length} chunks, the chunk report counts ${parsed.data.chunks.total}: run knowledge/chunk.sh`);
  }
  return { report, total: parsed.data.chunks.total, chunks };
}

// Removes an index this run made, after a failure, and says what became of it. An index the alias points at is never
// removed: an alias move whose answer was lost may still have been made.
async function removeAfterFailure(engine: Engine, alias: string, index: string): Promise<string> {
  let targets: string[];
  try {
    targets = await aliasTargets(engine, alias);
  } catch {
    return `${index} is left behind, because ${alias} could not be read to make sure it does not point at it`;
  }
  if (targets.includes(index)) return `${alias} points at ${index}, so it is left in place`;
  const answer = await engine.send('DELETE', `/${index}`);
  if (answer.kind === 'answer' && (answer.status === 200 || answer.status === 404)) return `${index} removed, ${alias} left as it was`;
  return `${index} could not be removed (${describe(answer)}): ${index} is left behind; ${alias} left as it was`;
}

type Built = { held: number } | { failed: 'count-differed' | 'items-refused'; detail: string };

// Creates the index, sends every chunk once, refreshes and counts. Returns the count, or the outcome that makes the
// run a failure (exit 1). Throws IndexingError when the engine could not be asked or answered in a way that stops the
// run. Removes nothing: the caller does.
async function build(options: IndexOptions, index: string, chunks: readonly { id: string }[]): Promise<Built> {
  const { engine } = options;
  await expect(engine, [200], 'PUT', `/${index}`, INDEX_DEFINITION);
  let failedItems = 0;
  let firstErrorType: string | null = null;
  for (let start = 0; start < chunks.length; start += options.batchSize) {
    const batch = chunks.slice(start, start + options.batchSize);
    const lines = batch.flatMap((chunk) => [JSON.stringify({ index: { _index: index, _id: chunk.id } }), JSON.stringify(chunk)]);
    const answer = bulkSchema.safeParse(await expect(engine, [200], 'POST', '/_bulk', `${lines.join('\n')}\n`, 'application/x-ndjson'));
    if (!answer.success) throw new IndexingError('POST /_bulk: the answer is not a bulk result');
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
    return { failed: 'items-refused', detail: `the engine refused ${failedItems} items (first error type: ${firstErrorType ?? 'unknown'})` };
  }
  await expect(engine, [200], 'POST', `/${index}/_refresh`);
  const held = await count(engine, index);
  if (held !== chunks.length) return { failed: 'count-differed', detail: `the engine holds ${held} documents, ${chunks.length} chunks were read` };
  return { held };
}

function reasonOf(error: unknown, otherwise: string): string {
  return error instanceof IndexingError ? error.message : otherwise;
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

  // From here the run may have made an index (a create whose answer was lost may have been made): every way it ends
  // but success removes it.
  let built: Built;
  try {
    built = await build(options, index, chunks);
  } catch (error) {
    throw new IndexingError(`${reasonOf(error, 'the run stopped with an unexpected error')}; ${await removeAfterFailure(engine, alias, index)}`);
  }
  if ('failed' in built) {
    log(`${built.detail}: ${await removeAfterFailure(engine, alias, index)}`);
    return { exitCode: 1, index, chunks: chunks.length, changed: built.failed, olderIndexes: await olderIndexes(engine, index) };
  }

  try {
    await moveAlias(engine, alias, targets, index);
  } catch (error) {
    // The answer may have been lost after the move was made. The alias is read again before anything is removed.
    let now: string[] | undefined;
    try {
      now = await aliasTargets(engine, alias);
    } catch {
      now = undefined;
    }
    if (now === undefined || !(now.length === 1 && now[0] === index)) {
      throw new IndexingError(`${reasonOf(error, 'the alias could not be moved')}; ${await removeAfterFailure(engine, alias, index)}`);
    }
  }
  log(`built ${index} with ${built.held} documents; ${alias} now points at it`);
  return { exitCode: 0, index, chunks: chunks.length, changed: 'built', olderIndexes: await olderIndexes(engine, index) };
}
