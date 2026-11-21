// A small engine with state, behind the search stand-in, for the indexing tests (S4, S14): indexes and their
// documents, and the alias. Like the stand-in it ranks nothing; it keeps just enough state to show what the index
// command sends and what it does with each answer. Each kind of misbehaviour is switched on by the test.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SET_ID, indexedChunk } from './retrieval.ts';
import type { SearchReply, SearchRequest } from './search-standin.ts';

export function fakeEngine() {
  const indexes = new Map<string, Set<string>>();
  let alias: string[] = [];
  const short = new Set<string>();
  // The number of bulk items to answer with an error (the documents are still stored, so the count matches).
  let refuseItems = 0;
  // Answers the test puts in place of the engine's own, each for the requests it matches, until it is used up.
  const overrides: { matches: (request: SearchRequest) => boolean; reply: SearchReply; times: number }[] = [];
  const handle = (request: SearchRequest): SearchReply => {
    const override = overrides.find((candidate) => candidate.times > 0 && candidate.matches(request));
    if (override !== undefined) {
      override.times--;
      return override.reply;
    }
    const path = request.path.split('?')[0] ?? '';
    const name = path.slice(1).split('/')[0] ?? '';
    if (request.method === 'GET' && path === '/_alias/labels') {
      return alias.length === 0
        ? { status: 404, body: { error: 'alias [labels] missing' } }
        : { status: 200, body: Object.fromEntries(alias.map((index) => [index, { aliases: { labels: {} } }])) };
    }
    if (request.method === 'GET' && path.startsWith('/_cat/indices')) return { status: 200, body: [...indexes.keys()].map((index) => ({ index })) };
    if (request.method === 'POST' && path === '/_aliases') {
      const actions = (request.body as { actions: Record<string, { index: string }>[] }).actions;
      for (const action of actions) {
        if (action.remove) alias = alias.filter((index) => index !== action.remove?.index);
        if (action.add) alias.push(action.add.index);
      }
      return { status: 200, body: { acknowledged: true } };
    }
    if (request.method === 'POST' && path === '/_bulk') {
      const lines = request.raw.split('\n').filter((line) => line !== '');
      const items: unknown[] = [];
      for (let i = 0; i < lines.length; i += 2) {
        const action = JSON.parse(lines[i] ?? '{}') as { index: { _index: string; _id: string } };
        indexes.get(action.index._index)?.add(action.index._id);
        if (refuseItems > 0) {
          refuseItems--;
          items.push({ index: { _id: action.index._id, status: 400, error: { type: 'mapper_parsing_exception', reason: 'failed to parse field [text]' } } });
        } else {
          items.push({ index: { _id: action.index._id, status: 201 } });
        }
      }
      return { status: 200, body: { errors: items.some((item) => JSON.stringify(item).includes('"error"')), items } };
    }
    if (request.method === 'HEAD') return { status: indexes.has(name) ? 200 : 404 };
    if (request.method === 'PUT') {
      indexes.set(name, new Set());
      return { status: 200, body: { acknowledged: true } };
    }
    if (request.method === 'DELETE') {
      indexes.delete(name);
      return { status: 200, body: { acknowledged: true } };
    }
    if (path.endsWith('/_refresh')) return { status: 200, body: {} };
    if (path.endsWith('/_count')) {
      const held = indexes.get(name)?.size ?? 0;
      return { status: 200, body: { count: short.has(name) ? held - 1 : held } };
    }
    return { status: 400, body: { error: 'not expected' } };
  };
  return {
    handle,
    indexes,
    alias: () => alias,
    shortCount: (index: string) => short.add(index),
    refuse: (items: number) => {
      refuseItems = items;
    },
    // Points the alias at these indexes, as a state to start from.
    point: (...to: string[]) => {
      alias = [...to];
    },
    // Answers the next `times` requests that match with the reply given, in place of the engine's own.
    override: (matches: (request: SearchRequest) => boolean, reply: SearchReply, times = 1) => {
      overrides.push({ matches, reply, times });
    },
  };
}

export type ChunkFileOptions = {
  // The text of chunk i (from 1); invented text unless given.
  text?: (i: number) => string;
  // Whether the report records each chunk file's sha256, as the chunk command does. A report written before it did
  // has none.
  hashes?: boolean;
};

// A chunk report and one label's chunk file of n invented chunks. Returns the chunk ids.
export async function writeChunks(dataDir: string, n: number, options: ChunkFileOptions = {}): Promise<string[]> {
  const chunks = Array.from({ length: n }, (_, i) =>
    indexedChunk(i + 1, { id: `${SET_ID}/3/sec-${i + 1}/body/1`, ...(options.text === undefined ? {} : { text: options.text(i + 1) }) }),
  );
  const bytes = chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join('');
  await mkdir(join(dataDir, 'chunks', SET_ID), { recursive: true });
  await writeFile(join(dataDir, 'chunks', SET_ID, '3.jsonl'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const label = { setId: SET_ID, version: 3, status: 'chunked', chunks: n, ...(options.hashes === false ? {} : { sha256 }) };
  await writeFile(join(dataDir, 'chunk-report.json'), `${JSON.stringify({ chunks: { total: n }, labels: [label] }, null, 2)}\n`);
  return chunks.map((chunk) => String(chunk.id));
}
