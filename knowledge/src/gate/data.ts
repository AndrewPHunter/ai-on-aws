// What the knowledge gate reads from the data the index was built from: the chunk report, the chunk files, the
// manifest and the benchmark's questions. A file that is missing or not JSON stops the gate as "could not run",
// naming the file (and the line, for a file of lines). The JSON parser's own message is never passed on: it quotes
// the input, which is label text.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The gate could not run. Its message names files, lines, statuses and identifiers only.
export class CouldNotRun extends Error {}

function readText(path: string, shown: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new CouldNotRun(`${shown} could not be read`);
  }
}

function parsed(text: string, where: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new CouldNotRun(`${where} is not JSON`);
  }
}

export function readJsonFile(path: string, shown: string): unknown {
  return parsed(readText(path, shown), shown);
}

// Each line of a file of JSON lines, parsed; empty lines are skipped.
export function readJsonLines(path: string, shown: string): unknown[] {
  const values: unknown[] = [];
  for (const [at, line] of readText(path, shown).split('\n').entries()) {
    if (line !== '') values.push(parsed(line, `${shown} line ${at + 1}`));
  }
  return values;
}

export type Chunk = { id: string; setId: string; drug: string[]; text: string };

export type GateData = {
  totalChunks: number;
  indexed: Set<string>;
  firstSetId: string;
  manifestOrder: string[];
  chunksBySetId: Map<string, Chunk[]>;
};

export function readData(dataDir: string, corpusDir: string): GateData {
  const report = readJsonFile(join(dataDir, 'chunk-report.json'), 'chunk-report.json') as {
    chunks: { total: number };
    labels: { setId: string; version: number; status: string }[];
  };
  const manifest = readJsonFile(join(corpusDir, 'manifest.json'), 'manifest.json') as { labels: { setId: string }[] };
  const chunksBySetId = new Map<string, Chunk[]>();
  for (const label of report.labels) {
    if (label.status !== 'chunked') continue;
    const shown = `chunks/${label.setId}/${label.version}.jsonl`;
    chunksBySetId.set(label.setId, readJsonLines(join(dataDir, 'chunks', label.setId, `${label.version}.jsonl`), shown) as Chunk[]);
  }
  const firstSetId = manifest.labels.find((label) => (chunksBySetId.get(label.setId)?.[0]?.drug.length ?? 0) > 0)?.setId;
  if (firstSetId === undefined) throw new CouldNotRun('no label in the manifest has chunks with a drug name');
  const manifestOrder = manifest.labels.map((label) => label.setId).filter((id) => chunksBySetId.has(id));
  return { totalChunks: report.chunks.total, indexed: new Set(chunksBySetId.keys()), firstSetId, manifestOrder, chunksBySetId };
}

export type Question = { qid: string | number; set_id: string; question: string; references: unknown };

export function readQuestions(dataDir: string): Question[] {
  return readJsonLines(join(dataDir, 'benchmark', 'qa.jsonl'), 'benchmark/qa.jsonl') as Question[];
}
