// What the knowledge tests share. Every label, drug name and passage here is invented. No server is started here:
// DailyMed, the benchmark's host, the search engine and the model servers are in-memory functions and objects,
// given to the production code where it takes them as values.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import type { AccessTokenCheck } from '../../shared/access-token.ts';
import { runCommand } from '../src/cli.ts';
import { historyUrl, zipUrl } from '../src/dailymed.ts';
import { fetchCorpus } from '../src/fetch.ts';
import { sha256 } from '../src/files.ts';
import { PoliteClient } from '../src/http.ts';
import type { HttpSettings } from '../src/http.ts';
import { runChunk } from '../src/chunk/run.ts';
import type { ParsedDocument } from '../src/parse/model.ts';
import { parseDocument } from '../src/parse/parser.ts';
import { runParse } from '../src/parse/run.ts';
import { serialiseBenchmarkPin, serialiseManifest } from '../src/schema.ts';
import type { BenchmarkPin, PinnedLabel } from '../src/schema.ts';
import type { Engine, EngineAnswer } from '../src/search/engine.ts';
import { runEmbed } from '../src/vectors/embed.ts';
import type { ModelAnswer, ModelClient } from '../src/vectors/model-client.ts';
import { encodeVector } from '../src/vectors/recipe.ts';

export const guid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const documentGuid = (n: number): string => `11111111-2222-4333-8444-${n.toString(16).padStart(12, '0')}`;

export type Folders = { root: string; corpusDir: string; dataDir: string };

export async function folders(t: TestContext): Promise<Folders> {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const where = { root, corpusDir: join(root, 'corpus'), dataDir: join(root, 'data') };
  await mkdir(where.corpusDir);
  await mkdir(where.dataDir);
  return where;
}

// Every file under a folder, as sorted paths relative to it.
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((found) => found.isFile()).map((found) => relative(dir, join(found.parentPath, found.name))).sort();
}

// ---------- requests: an in-memory fetch that records what it is sent ----------

export type Sent = { url: string; method: string; headers: Record<string, string>; body: string };
export type Answer = (sent: Sent, signal: AbortSignal | undefined) => Response | Promise<Response>;

export function recorder(answer: Answer): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const recording = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? init.body : '',
    };
    sent.push(request);
    return answer(request, init.signal ?? undefined);
  };
  return { fetch: recording as typeof fetch, sent };
}

export const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const noResponse = (): never => {
  throw new TypeError('fetch failed');
};
export const noNetwork: typeof fetch = () => Promise.reject(new Error('this test sends no request'));

// ---------- labels, zips and the corpus ----------

export function spl(setId: string, version: number, body: string, options: { documentId?: string; typeCode?: string; prolog?: string } = {}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>${options.prolog ?? ''}<document xmlns="urn:hl7-org:v3">` +
    `<id root="${options.documentId ?? documentGuid(1)}"/><code code="${options.typeCode ?? '34391-3'}"/><title>Invented label</title>` +
    `<effectiveTime value="20240102"/><setId root="${setId}"/><versionNumber value="${version}"/>` +
    `<component><structuredBody>${body}</structuredBody></component></document>`
  );
}

export const section = (title: string, text: string, options: { id?: string; code?: string; inner?: string } = {}): string =>
  `<component><section>${options.id === undefined ? '' : `<id root="${options.id}"/>`}<code code="${options.code ?? '34067-9'}"/>` +
  `<title>${title}</title><text>${text}</text>${options.inner ?? ''}</section></component>`;

export const parsed = (xml: string): ParsedDocument => {
  const document = parseDocument(Buffer.from(xml)).document;
  if (document === null) throw new Error('the fixture did not parse');
  return document;
};

// A zip, byte by byte, so a member can declare a size it does not have. Not a general zip writer.
export function zip(members: readonly { name: string; data: string | Buffer; declaredSize?: number }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name);
    const raw = Buffer.from(member.data);
    const body = deflateRawSync(raw);
    const header = (size: number, signature: number): Buffer => {
      const out = Buffer.alloc(size);
      out.writeUInt32LE(signature, 0);
      return out;
    };
    const local = header(30, 0x04034b50);
    const entry = header(46, 0x02014b50);
    for (const [buffer, at] of [
      [local, 0],
      [entry, 2],
    ] as const) {
      buffer.writeUInt16LE(20, 4 + at);
      buffer.writeUInt16LE(8, 8 + at);
      buffer.writeUInt32LE(crc32(raw), 14 + at);
      buffer.writeUInt32LE(body.length, 18 + at);
      buffer.writeUInt32LE(member.declaredSize ?? raw.length, 22 + at);
      buffer.writeUInt16LE(name.length, 26 + at);
    }
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(entry, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export const PLAIN = section('1 USES', '<paragraph>Invented words for a synthetic label.</paragraph>');

export type Label = { setId: string; version: number; documentId: string; xml: Buffer; zip: Buffer };

export function label(n: number, body = PLAIN, options: { version?: number; member?: string; typeCode?: string } = {}): Label {
  const version = options.version ?? 1;
  const setId = guid(n);
  const documentId = documentGuid(n);
  const xml = Buffer.from(spl(setId, version, body, { documentId, ...(options.typeCode === undefined ? {} : { typeCode: options.typeCode }) }));
  return { setId, version, documentId, xml, zip: zip([{ name: options.member ?? `${documentId}.xml`, data: xml }]) };
}

export const entry = (of: Label): PinnedLabel => ({
  setId: of.setId,
  version: of.version,
  documentId: of.documentId,
  effectiveTime: '20240102',
  publishedDate: '2024-01-02',
  documentTypeCode: '34391-3',
  zipSha256: sha256(of.zip),
  xmlSha256: sha256(of.xml),
  xmlBytes: of.xml.length,
});

export const jsonl = (rows: readonly unknown[]): Buffer => Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
export type Bench = { labels: Buffer; qa: Buffer };
export const BENCH: Bench = { labels: jsonl([{ set_id: guid(1), drug_name: 'Examplamab', drug_id: 'd1', chunks: [] }]), qa: jsonl([]) };
export const REPOSITORY = 'https://github.com/example-owner/example-bench';
export const REVISION = 'a'.repeat(40);
export const DAILYMED = 'https://dailymed.test';
export const RAW = 'https://raw.test';
const PATHS = { labels: 'data/labels.jsonl', qa: 'data/qa.jsonl' };
const rawUrl = (path: string): string => `${RAW}/example-owner/example-bench/${REVISION}/${path}`;

export const pinOf = (files: Bench): BenchmarkPin => ({
  repository: REPOSITORY,
  revision: REVISION,
  licence: 'Apache-2.0',
  files: {
    labels: { path: PATHS.labels, sha256: sha256(files.labels), bytes: files.labels.length },
    qa: { path: PATHS.qa, sha256: sha256(files.qa), bytes: files.qa.length },
  },
});

export async function writeCorpus(corpusDir: string, labels: readonly Label[], files = BENCH): Promise<void> {
  await writeFile(join(corpusDir, 'benchmark.json'), serialiseBenchmarkPin(pinOf(files)));
  await writeFile(join(corpusDir, 'manifest.json'), serialiseManifest({ labels: labels.map(entry), notPinned: [] }));
}

// A label's XML put in the data folder as the fetch leaves it, with its download record.
export async function place(dataDir: string, of: Label, xml = of.xml): Promise<void> {
  await mkdir(join(dataDir, 'labels', of.setId), { recursive: true });
  await writeFile(join(dataDir, 'labels', of.setId, `${of.version}.xml`), xml);
  await writeFile(join(dataDir, 'labels', of.setId, `${of.version}.download.json`), `${JSON.stringify({ zipSha256: sha256(of.zip), xmlSha256: sha256(of.xml) })}\n`);
}

// DailyMed and the benchmark's host, as one answer function: each label's history and zip, and the two files.
export function hosts(labels: readonly Label[], files = BENCH): Answer {
  const routes = new Map<string, () => Response>([
    [rawUrl(PATHS.labels), () => new Response(files.labels)],
    [rawUrl(PATHS.qa), () => new Response(files.qa)],
  ]);
  for (const of of labels) {
    routes.set(historyUrl(DAILYMED, of.setId, 1), () => json({ data: { history: [{ spl_version: of.version, published_date: 'Jan 2, 2024' }] }, metadata: { total_pages: 1, current_page: 1 } }));
    routes.set(zipUrl(DAILYMED, of.setId, of.version), () => new Response(of.zip));
  }
  return (sent) => routes.get(sent.url)?.() ?? new Response('not here', { status: 404 });
}

export function client(fetch: typeof globalThis.fetch, settings: Partial<HttpSettings> = {}): PoliteClient {
  return new PoliteClient({ fetch, userAgent: 'test-agent/1', maxConcurrent: 2, attempts: 3, waitsMs: [10, 20], timeoutMs: 30_000, sleep: async () => {}, ...settings });
}

export const CAPS = { zipBytes: 64 * 1024, xmlBytes: 16 * 1024 };

export function fetchRun(where: Folders, fetch: typeof globalThis.fetch) {
  return fetchCorpus({ ...where, rawBase: RAW, dailymedBase: DAILYMED, caps: CAPS, benchmarkMaxBytes: 1 << 20, dailymed: client(fetch), github: client(fetch), workers: 2, log: () => {}, warn: () => {} });
}

// The labels parsed and chunked into the data folder, as parse.sh and chunk.sh leave them.
export async function chunked(where: Folders, labels: readonly Label[]): Promise<void> {
  await writeCorpus(where.corpusDir, labels);
  for (const of of labels) await place(where.dataDir, of);
  await runParse({ ...where, log: () => {} });
  await runChunk({ ...where, settings: { textLimit: 300, tableLimit: 300 }, log: () => {} });
}

// A vector for every chunk, as embed.sh leaves them.
export const embedded = (where: Folders) =>
  runEmbed({
    dataDir: where.dataDir,
    client: scriptedModels().models,
    settings: { modelId: 'embed-model', repository: 'example/embed', revision: 'r1', dimensions: DIMENSIONS, batchSize: 32, attempts: 1, waitsMs: [] },
    sleep: async () => {},
    log: () => {},
  });

// ---------- the command line ----------

export type Run = { code: number; out: string[]; err: string[] };

export async function cli(argv: string[], fetch: typeof globalThis.fetch = noNetwork, env: Readonly<Record<string, string | undefined>> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, { fetch, sleep: async () => {}, log: (line) => out.push(line), warn: (line) => err.push(line), env });
  return { code, out, err };
}

export const clientFlags = (concurrency = '2', workers = '2'): string[] => [
  '--raw-base', RAW, '--dailymed-base', DAILYMED, '--user-agent', 'test-agent/1', '--dailymed-concurrency', concurrency,
  '--github-concurrency', '1', '--workers', workers, '--attempts', '3', '--waits-ms', '10,20', '--timeout-ms', '30000',
  '--zip-max-bytes', String(CAPS.zipBytes), '--xml-max-bytes', String(CAPS.xmlBytes), '--benchmark-max-bytes', String(1 << 20),
];

export const pinFlags = (where: Folders): string[] => [
  '--corpus', where.corpusDir, '--data', where.dataDir, '--repository', REPOSITORY, '--revision', REVISION, '--licence', 'Apache-2.0',
  '--labels-path', PATHS.labels, '--qa-path', PATHS.qa,
];

// ---------- the search engine ----------

export type EngineRequest = { method: string; path: string; body: unknown };

// An engine that answers as the test says and records every request. It interprets nothing: tests that rely on a
// query assert the request that was sent.
export function scriptedEngine(answer: (request: EngineRequest) => EngineAnswer): { engine: Engine; sent: EngineRequest[] } {
  const sent: EngineRequest[] = [];
  return {
    sent,
    engine: {
      send(method, path, body) {
        const request = { method, path, body };
        sent.push(request);
        return Promise.resolve(answer(request));
      },
    },
  };
}

export const ok = (body: unknown, status = 200): EngineAnswer => ({ kind: 'answer', status, body });

// A chunk as the index holds it, of one label.
export const indexed = (setId: string, n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `${setId}/1/sec-${n}/body/1`,
  text: `Invented passage ${n}.`,
  context: `Examplamab: Section ${n}`,
  part: 'body',
  type: 'text',
  section: { number: `${n}`, title: `Section ${n}`, path: [`Section ${n}`] },
  position: { ordinal: n },
  setId,
  version: '1',
  effectiveTime: '20240102',
  kind: 'prescription',
  source: `https://labels.test/${setId}`,
  ...extra,
});

export const hitsBody = (...sources: Record<string, unknown>[]): unknown => ({
  timed_out: false,
  _shards: { failed: 0 },
  hits: { hits: sources.map((source, at) => ({ _score: 0.9 - at / 10, _source: source })) },
});
export const hits = (...sources: Record<string, unknown>[]): EngineAnswer => ok(hitsBody(...sources));

// An engine that holds indexes and an alias as OpenSearch does, for the index command. `on` sees each request with
// the function that applies it, and may apply it or not, and answer otherwise.
export type Held = { indexes: Map<string, Map<string, Record<string, unknown>>>; aliases: Map<string, string[]> };

export function memoryEngine(on: (request: EngineRequest, apply: () => EngineAnswer) => EngineAnswer = (_request, apply) => apply()): { engine: Engine; held: Held; sent: EngineRequest[] } {
  const held: Held = { indexes: new Map(), aliases: new Map() };
  const sent: EngineRequest[] = [];
  const apply = ({ method, path, body }: EngineRequest): EngineAnswer => {
    const [, first = '', second = ''] = path.split('?')[0]?.split('/') ?? [];
    const docs = held.indexes.get(first);
    if (method === 'GET' && first === '_alias') {
      const targets = held.aliases.get(second) ?? [];
      return targets.length === 0 ? ok({}, 404) : ok(Object.fromEntries(targets.map((index) => [index, { aliases: { [second]: {} } }])));
    }
    if (method === 'GET' && first === '_cat') return ok([...held.indexes.keys()].map((index) => ({ index })));
    if (method === 'POST' && first === '_aliases') {
      for (const action of (body as { actions: Record<string, { index: string; alias: string }>[] }).actions) {
        const [[verb, { index, alias }] = ['', { index: '', alias: '' }]] = Object.entries(action);
        const targets = (held.aliases.get(alias) ?? []).filter((target) => target !== index);
        held.aliases.set(alias, verb === 'add' ? [...targets, index] : targets);
      }
      return ok({ acknowledged: true });
    }
    if (method === 'POST' && first === '_bulk') {
      const lines = String(body).split('\n').filter((line) => line !== '');
      const items = [];
      for (let at = 0; at < lines.length; at += 2) {
        const action = JSON.parse(lines[at] ?? '{}') as { index: { _index: string; _id: string } };
        held.indexes.get(action.index._index)?.set(action.index._id, JSON.parse(lines[at + 1] ?? '{}') as Record<string, unknown>);
        items.push({ index: { status: 201 } });
      }
      return ok({ errors: false, items });
    }
    if (method === 'HEAD') return ok(undefined, docs === undefined ? 404 : 200);
    if (method === 'PUT') {
      if (docs !== undefined) return ok({ error: { type: 'resource_already_exists_exception' } }, 400);
      held.indexes.set(first, new Map());
      return ok({ acknowledged: true });
    }
    if (docs === undefined) return ok({ error: { type: 'index_not_found_exception' } }, 404);
    if (method === 'DELETE') {
      held.indexes.delete(first);
      for (const [alias, targets] of held.aliases) held.aliases.set(alias, targets.filter((target) => target !== first));
      return ok({ acknowledged: true });
    }
    if (second === '_refresh') return ok({});
    if (second === '_count') {
      const all = [...docs.values()];
      return ok({ count: method === 'POST' ? all.filter((doc) => doc.hasVector === true).length : all.length });
    }
    return ok({ error: { type: 'not_handled_by_this_engine' } }, 400);
  };
  return {
    held,
    sent,
    engine: {
      send(method, path, body) {
        const request = { method, path, body };
        sent.push(request);
        return Promise.resolve(on(request, () => apply(request)));
      },
    },
  };
}

// ---------- the model servers ----------

export const DIMENSIONS = 4;

// A model client that answers as the test says; by default every input gets a vector and every passage a score.
export function scriptedModels(answers: { embed?: () => ModelAnswer<{ vectors: string[]; tokens: number }>; rerank?: (documents: readonly string[]) => ModelAnswer<{ index: number; score: number }[]> } = {}) {
  const calls: { kind: 'embed' | 'rerank'; inputs: readonly string[] }[] = [];
  const models: ModelClient = {
    listModels: () => Promise.resolve({ kind: 'ok', value: ['embed-model'] }),
    embed(_model, inputs) {
      calls.push({ kind: 'embed', inputs });
      return Promise.resolve(answers.embed?.() ?? { kind: 'ok', value: { vectors: inputs.map((_, at) => encodeVector([1, at, 0, 0])), tokens: inputs.length } });
    },
    rerank(_model, _query, documents) {
      calls.push({ kind: 'rerank', inputs: documents });
      return Promise.resolve(answers.rerank?.(documents) ?? { kind: 'ok', value: documents.map((_, index) => ({ index, score: index })) });
    },
  };
  return { models, calls };
}

// ---------- the retrieval service's token check, as a function ----------

export const GOOD_TOKEN = 'token-of-the-test-caller';

export const tokenCheck: AccessTokenCheck = (authorization) =>
  Promise.resolve(
    authorization === `Bearer ${GOOD_TOKEN}`
      ? { kind: 'caller', caller: { subject: 's', username: 'dana.desk', name: 'Dana Desk', clientId: 'desk', roles: [], expiresAt: new Date(0), token: GOOD_TOKEN } }
      : { kind: 'refused', reason: authorization === undefined ? 'missing' : 'bad_signature', detail: 'The token is not valid.' },
  );
