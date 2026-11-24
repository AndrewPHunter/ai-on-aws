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
//
// With an embed report (knowledge/embed.sh), it must name this chunk report, or nothing is built (exit 1). The vector
// files are checked against its hash, each document is loaded with its vector (and hasVector), the index records the
// embedding identity in _meta, the name covers the embed report's bytes too, and after the load the count of
// documents with a vector must equal the report's. Bulk requests are cut by size, not by count.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { chunkPath } from '../chunk/run.ts';
import { sha256 } from '../files.ts';
import { decodeVector } from '../vectors/recipe.ts';
import type { EmbeddingIdentity } from '../vectors/recipe.ts';
import type { Engine, EngineAnswer } from './engine.ts';
import { INDEX_PREFIX, indexDefinition, indexName } from './mapping.ts';

// The embedding stage's report, read here when present. Named here as well as by the stage, so indexing does not
// depend on the stage's module.
export const EMBED_REPORT = 'embed-report.json';

export type IndexOptions = {
  engine: Engine;
  dataDir: string;
  alias: string;
  // The most bytes of body one bulk request carries. A document larger than this is sent alone.
  batchBytes: number;
  log: (line: string) => void;
};

export type IndexOutcome = {
  exitCode: 0 | 1;
  // The index named from what was read; when the embed report names other chunks, the one that would have been built.
  index: string;
  chunks: number;
  changed: 'nothing' | 'alias-moved' | 'built' | 'count-differed' | 'items-refused' | 'vectors-differed' | 'embed-report-for-other-chunks';
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

const embedReportSchema = z.object({
  model: z.object({ repository: z.string(), revision: z.string(), servedAs: z.string() }),
  dimensions: z.number().int().positive(),
  recipe: z.string(),
  instruction: z.string(),
  chunkReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.object({ chunks: z.number().int().nonnegative(), vectors: z.number().int().nonnegative(), withoutVector: z.number().int().nonnegative() }),
  files: z.array(z.string().regex(/^[0-9a-f-]{36}\/\d+\.jsonl$/)),
  vectorFilesSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Embedding = {
  // The embed report's bytes, part of the index's name.
  report: Buffer;
  identity: EmbeddingIdentity;
  vectorCount: number;
  // Each vector by chunk id, as float32 (as the server returned it): about 4 KB each.
  vectors: Map<string, Float32Array>;
};

const vectorLineSchema = z.object({ id: z.string(), vector: z.string() });

// The embed report and the vectors it describes, or null when there is no embed report. 'other-chunks' when the
// report names a chunk report other than the one being loaded. The vector files are checked against the report's
// hash, and each vector against its dimensions, before anything is sent.
export async function readEmbedding(dataDir: string, chunkReport: Buffer): Promise<Embedding | 'other-chunks' | null> {
  let report: Buffer;
  try {
    report = await readFile(join(dataDir, EMBED_REPORT));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new IndexingError(`${EMBED_REPORT} could not be read`);
  }
  const parsed = embedReportSchema.safeParse(parseLabelJson(report.toString('utf8'), EMBED_REPORT));
  if (!parsed.success) throw new IndexingError(`${EMBED_REPORT} is not an embed report: run knowledge/embed.sh`);
  const embed = parsed.data;
  if (embed.chunkReportSha256 !== sha256(chunkReport)) return 'other-chunks';

  const vectors = new Map<string, Float32Array>();
  // The files' bytes are hashed as they are read, in the report's order, so none is held after it is parsed.
  const hash = createHash('sha256');
  for (const file of embed.files) {
    const shown = `vectors/${file}`;
    const bytes = await readNeeded(join(dataDir, 'vectors', file), shown);
    hash.update(bytes);
    for (const [at, line] of bytes.toString('utf8').split('\n').entries()) {
      if (line === '') continue;
      const entry = vectorLineSchema.safeParse(parseLabelJson(line, `${shown} line ${at + 1}`));
      if (!entry.success) throw new IndexingError(`${shown} line ${at + 1} is not a chunk id and a vector: run knowledge/embed.sh`);
      const values = decodeVector(entry.data.vector);
      if (values?.length !== embed.dimensions) throw new IndexingError(`${shown} line ${at + 1} has a vector of other than ${embed.dimensions} numbers`);
      vectors.set(entry.data.id, values);
    }
  }
  if (hash.digest('hex') !== embed.vectorFilesSha256) {
    throw new IndexingError(`the vector files do not match the sha256 in ${EMBED_REPORT}: run knowledge/embed.sh again`);
  }
  if (vectors.size !== embed.counts.vectors) {
    throw new IndexingError(`the vector files hold ${vectors.size} vectors, ${EMBED_REPORT} counts ${embed.counts.vectors}: run knowledge/embed.sh again`);
  }
  return {
    report,
    identity: {
      repository: embed.model.repository,
      revision: embed.model.revision,
      dimensions: embed.dimensions,
      recipe: embed.recipe,
      instruction: embed.instruction,
      vectorsSha256: embed.vectorFilesSha256,
    },
    vectorCount: embed.counts.vectors,
    vectors,
  };
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

type Built = { held: number } | { failed: 'count-differed' | 'items-refused' | 'vectors-differed'; detail: string };

// The bulk bodies for these chunks, one at a time: each an action line and a document line per chunk, cut so that no
// body is over the size given (a single document over it is sent alone). Every chunk is in exactly one body. Made
// as they are sent, so only one body (about 8 MB) is held at a time.
export function* bulkBodies(index: string, chunks: readonly { id: string }[], embedding: Embedding | null, maxBytes: number): Generator<string> {
  let current: string[] = [];
  let size = 0;
  for (const chunk of chunks) {
    const vector = embedding?.vectors.get(chunk.id);
    const document = embedding === null ? chunk : { ...chunk, hasVector: vector !== undefined, ...(vector === undefined ? {} : { embedding: Array.from(vector) }) };
    const pair = `${JSON.stringify({ index: { _index: index, _id: chunk.id } })}\n${JSON.stringify(document)}\n`;
    const bytes = Buffer.byteLength(pair, 'utf8');
    if (current.length > 0 && size + bytes > maxBytes) {
      yield current.join('');
      current = [];
      size = 0;
    }
    current.push(pair);
    size += bytes;
  }
  if (current.length > 0) yield current.join('');
}

// Creates the index, sends every chunk once, refreshes and counts (and, with vectors, counts the documents that have
// one). Returns the count, or the outcome that makes the run a failure (exit 1). Throws IndexingError when the engine
// could not be asked or answered in a way that stops the run. Removes nothing: the caller does.
async function build(options: IndexOptions, index: string, chunks: readonly { id: string }[], embedding: Embedding | null): Promise<Built> {
  const { engine } = options;
  await expect(engine, [200], 'PUT', `/${index}`, indexDefinition(embedding?.identity ?? null));
  let failedItems = 0;
  let firstErrorType: string | null = null;
  for (const body of bulkBodies(index, chunks, embedding, options.batchBytes)) {
    const answer = bulkSchema.safeParse(await expect(engine, [200], 'POST', '/_bulk', body, 'application/x-ndjson'));
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
  if (embedding !== null) {
    const body = await expect(engine, [200], 'POST', `/${index}/_count`, { query: { term: { hasVector: true } } });
    const counted = z.object({ count: z.number().int().nonnegative() }).safeParse(body);
    if (!counted.success) throw new IndexingError(`POST /${index}/_count: the answer has no count`);
    if (counted.data.count !== embedding.vectorCount) {
      return { failed: 'vectors-differed', detail: `the engine holds ${counted.data.count} documents with a vector, the embed report counts ${embedding.vectorCount}` };
    }
  }
  return { held };
}

function reasonOf(error: unknown, otherwise: string): string {
  return error instanceof IndexingError ? error.message : otherwise;
}

export async function indexChunks(options: IndexOptions): Promise<IndexOutcome> {
  const { engine, alias, log } = options;
  const { report, chunks } = await readChunks(options.dataDir);
  const embedding = await readEmbedding(options.dataDir, report);
  if (embedding === 'other-chunks') {
    log(`${EMBED_REPORT} was made from other chunks than the chunk report's: run knowledge/embed.sh again. Nothing was built and ${alias} was left as it was`);
    return { exitCode: 1, index: indexName(report), chunks: chunks.length, changed: 'embed-report-for-other-chunks', olderIndexes: [] };
  }
  const index = indexName(report, indexDefinition(embedding?.identity ?? null), embedding?.report ?? null);
  log(`index ${index} for ${chunks.length} chunks, ${embedding === null ? 'without vectors' : `${embedding.vectorCount} with a vector`}`);

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
    built = await build(options, index, chunks, embedding);
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
