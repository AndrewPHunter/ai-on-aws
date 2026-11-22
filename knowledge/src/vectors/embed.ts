// The embedding stage: a vector for every chunk of the last chunk run, from the embedding server.
//
//   - Reads the chunk report and every chunk file, each checked against the hash the report records.
//   - Asks the server for a vector of each chunk's document text (recipe.ts), in chunk-id order, in fixed batches.
//   - A batch the server refuses as over-length is sent again one passage at a time; a passage refused alone gets no
//     vector and is counted, by chunk id.
//   - A request that gets status 408, 429 or 5xx, or no answer, is tried again, up to the attempts given. Any other
//     failure, or a vector of the wrong length, fails the run: no report is written, and an old one is removed, so
//     no report ever describes vector files it did not write.
//   - Writes one file per label under vectors/ (one line per chunk with a vector: its id and the vector as base64 of
//     little-endian float32) and embed-report.json, which names the chunks it came from and hashes the files.
// Nothing here prints text, a vector or the key.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256, writeIfChanged } from '../files.ts';
import { EMBED_REPORT, IndexingError, readChunks } from '../search/indexing.ts';
import type { ModelAnswer, ModelClient } from './model-client.ts';
import { DOCUMENT_RECIPE, QUERY_INSTRUCTION, decodeVector, documentText } from './recipe.ts';

export type EmbedSettings = {
  // The name the server lists the model under, which every request carries.
  modelId: string;
  repository: string;
  revision: string;
  dimensions: number;
  batchSize: number;
  // Requests in all for one batch or passage, the first included.
  attempts: number;
  // The wait before each further attempt.
  waitsMs: number[];
};

export type EmbedOptions = {
  dataDir: string;
  client: ModelClient;
  settings: EmbedSettings;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

export type EmbedReport = {
  model: { repository: string; revision: string; servedAs: string };
  dimensions: number;
  recipe: string;
  instruction: string;
  chunkReportSha256: string;
  counts: { chunks: number; vectors: number; withoutVector: number };
  // Chunk ids the server refused as over-length, each alone.
  withoutVector: string[];
  tokens: number;
  // The vector files, relative to vectors/, in the order their bytes are hashed.
  files: string[];
  vectorFilesSha256: string;
};

export { EMBED_REPORT };

// The run could not start: the chunks could not be read, or the server could not be asked or does not serve the
// model. Nothing was written.
export class EmbedError extends Error {}

// A request failed after its attempts, or answered in a way the run cannot use. No report was written.
class RequestFailed extends Error {}

type Chunk = { id: string; setId: string; version: number; text: string; context?: string | null };

function describe(answer: Exclude<ModelAnswer<unknown>, { kind: 'ok' }>): string {
  if (answer.kind === 'timeout') return 'the embedding server did not answer in time';
  if (answer.kind === 'unreachable') return 'the embedding server could not be reached';
  if (answer.kind === 'status') return `the embedding server answered with status ${answer.status}`;
  if (answer.kind === 'over_length') return 'the embedding server refused an input as too long';
  return 'the embedding server answered in a form this stage does not expect';
}

const retried = (answer: ModelAnswer<unknown>): boolean =>
  answer.kind === 'timeout' || answer.kind === 'unreachable' || (answer.kind === 'status' && (answer.status === 408 || answer.status === 429 || answer.status >= 500));

export const vectorFile = (setId: string, version: number): string => `${setId}/${version}.jsonl`;

export async function runEmbed(options: EmbedOptions): Promise<{ exitCode: 0 | 1; report: EmbedReport | null }> {
  const { client, settings, log } = options;
  let chunkReport: Buffer;
  let chunks: Chunk[];
  try {
    const read = await readChunks(options.dataDir);
    chunkReport = read.report;
    chunks = read.chunks as Chunk[];
  } catch (error) {
    throw new EmbedError(error instanceof IndexingError ? error.message : 'the chunks could not be read');
  }
  for (const chunk of chunks) {
    if (typeof chunk.text !== 'string' || typeof chunk.setId !== 'string' || !Number.isInteger(chunk.version)) {
      throw new EmbedError(`chunk ${chunk.id} has no text, set id or version: run knowledge/chunk.sh`);
    }
  }

  const listed = await client.listModels();
  if (listed.kind !== 'ok') throw new EmbedError(`the embedding server's model list could not be read: ${describe(listed)}`);
  if (!listed.value.includes(settings.modelId)) throw new EmbedError(`the embedding server does not list the model ${settings.modelId}`);

  const ordered = [...chunks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  log(`chunks: ${ordered.length}; batches of ${settings.batchSize}`);

  async function ask(inputs: string[]): Promise<ModelAnswer<{ vectors: string[]; tokens: number }>> {
    let answer = await client.embed(settings.modelId, inputs);
    for (let attempt = 1; attempt < settings.attempts && retried(answer); attempt++) {
      await options.sleep(settings.waitsMs[attempt - 1] ?? settings.waitsMs[settings.waitsMs.length - 1] ?? 0);
      answer = await client.embed(settings.modelId, inputs);
    }
    return answer;
  }

  const vectors = new Map<string, string>();
  const without: string[] = [];
  let tokens = 0;
  const keep = (chunk: Chunk, vector: string): void => {
    if (decodeVector(vector).length !== settings.dimensions) {
      throw new RequestFailed(`the embedding server returned a vector of other than ${settings.dimensions} numbers for ${chunk.id}`);
    }
    vectors.set(chunk.id, vector);
  };

  try {
    for (let start = 0; start < ordered.length; start += settings.batchSize) {
      const batch = ordered.slice(start, start + settings.batchSize);
      const answer = await ask(batch.map(documentText));
      if (answer.kind === 'ok') {
        tokens += answer.value.tokens;
        batch.forEach((chunk, at) => keep(chunk, answer.value.vectors[at] ?? ''));
        continue;
      }
      if (answer.kind !== 'over_length') throw new RequestFailed(`batch from ${batch[0]?.id ?? ''}: ${describe(answer)}`);
      // Which passage, or passages, made the batch too long: each alone.
      for (const chunk of batch) {
        const alone = await ask([documentText(chunk)]);
        if (alone.kind === 'over_length') {
          without.push(chunk.id);
          continue;
        }
        if (alone.kind !== 'ok') throw new RequestFailed(`${chunk.id}: ${describe(alone)}`);
        tokens += alone.value.tokens;
        keep(chunk, alone.value.vectors[0] ?? '');
      }
    }
  } catch (error) {
    if (!(error instanceof RequestFailed)) throw error;
    await rm(join(options.dataDir, EMBED_REPORT), { force: true });
    log(`failed: ${error.message}; no embed report written`);
    return { exitCode: 1, report: null };
  }

  // One file per label, in label order, each line in chunk-id order.
  const byFile = new Map<string, string[]>();
  for (const chunk of ordered) {
    const vector = vectors.get(chunk.id);
    if (vector === undefined) continue;
    const file = vectorFile(chunk.setId, chunk.version);
    const lines = byFile.get(file) ?? [];
    lines.push(`${JSON.stringify({ id: chunk.id, vector })}\n`);
    byFile.set(file, lines);
  }
  const files = [...byFile.keys()].sort();
  const contents: Buffer[] = [];
  for (const file of files) {
    const content = (byFile.get(file) ?? []).join('');
    await writeIfChanged(join(options.dataDir, 'vectors', file), content);
    contents.push(Buffer.from(content, 'utf8'));
  }

  const report: EmbedReport = {
    model: { repository: settings.repository, revision: settings.revision, servedAs: settings.modelId },
    dimensions: settings.dimensions,
    recipe: DOCUMENT_RECIPE,
    instruction: QUERY_INSTRUCTION,
    chunkReportSha256: sha256(chunkReport),
    counts: { chunks: ordered.length, vectors: vectors.size, withoutVector: without.length },
    withoutVector: without,
    tokens,
    files,
    // Over the files' bytes, concatenated in the order of `files`.
    vectorFilesSha256: sha256(Buffer.concat(contents)),
  };
  await writeIfChanged(join(options.dataDir, EMBED_REPORT), `${JSON.stringify(report, null, 2)}\n`);
  log(`vectors: ${report.counts.vectors}; without a vector: ${report.counts.withoutVector}; tokens: ${tokens}`);
  for (const id of without) log(`  without a vector (over-length): ${id}`);
  return { exitCode: 0, report };
}
