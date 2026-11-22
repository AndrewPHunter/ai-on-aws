// The two retrieval tools, as plain functions over the engine. Each checks its input before anything is sent,
// builds the request in code (the user's words go only into a full-text match or into the embedding server, never
// into a query language), and turns every way the engine or a model server can fail into an error result that says
// which. An empty list is only ever an answer.
//
// search_label ranks by the service's strategy (the Retriever it is given, never an argument):
//   keyword         BM25 over the chunk's text and context line, on the alias, as it always has.
//   vector          the query's vector (Instruct: <instruction>\nQuery:<query>), an exact cosine search over the
//                   documents that have a vector.
//   fused           the best 50 by each, reciprocal rank fusion with constant 60, ties by chunk id.
//   fused_reranked  the best 20 fused, ordered by the reranker's score, ties by fused rank.
// Every strategy searches under the same filters (the set id, and the part when given). A strategy that uses vectors
// first reads which index the alias points at and checks the embedding identity it records; both legs then search
// that index. No failure falls back to another strategy.

import { z } from 'zod';

import type { ModelAnswer, ModelClient } from '../vectors/model-client.ts';
import { decodeVector, documentText, identityDifferences, queryText } from '../vectors/recipe.ts';
import type { ConfiguredIdentity, EmbeddingIdentity } from '../vectors/recipe.ts';
import type { Engine, EngineAnswer } from './engine.ts';
import { indexMissing } from './engine.ts';
import { fuse, rerankOrder } from './fusion.ts';
import { DEFAULT_SEARCH_LIMIT, SearchBudget } from './limits.ts';
import type { SearchLimit } from './limits.ts';
import type { Strategy } from './settings.ts';

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PARTS = ['body', 'highlights'] as const;
export const MAX_RESULTS = 10;
export const DEFAULT_RESULTS = 5;
const MAX_QUERY_CHARACTERS = 1000;
const MAX_DRUG_CHARACTERS = 200;
const LABELS_LISTED = 10;

export type ToolError = {
  error:
    | 'invalid_input'
    | 'index_not_built'
    | 'label_not_found'
    | 'search_timed_out'
    | 'search_unreachable'
    | 'search_error'
    | 'search_unexpected_answer'
    | 'vectors_not_built'
    | 'vectors_do_not_match'
    | 'embedding_unreachable'
    | 'embedding_timed_out'
    | 'embedding_error'
    | 'rerank_unreachable'
    | 'rerank_timed_out'
    | 'rerank_error';
  detail: string;
};

export type LabelFound = {
  set_id: string;
  version: number;
  effective_date: string;
  kind: string;
  format: string;
  names: string[];
  source: string;
};

export type FindLabelsResult = { labels: LabelFound[]; more_matched: boolean; matched_by: 'exact_name' | 'every_word' | 'none' };

export type Passage = {
  chunk_id: string;
  text: string;
  score: number;
  part: string;
  type: string;
  section: { number: string | null; title: string | null; path: string[] };
  position: Record<string, number>;
  label: { set_id: string; version: number; effective_date: string; kind: string; source: string };
  // The passage's rank, from 1, in each list the strategy computed and that it is in; otherwise null.
  ranks: { keyword: number | null; vector: number | null; fused: number | null; reranked: number | null };
  // The keyword (BM25) score, the cosine similarity, the fused score and the reranker's score: null where not
  // computed. `score` is the one the returned order is by.
  scores: { keyword: number | null; vector: number | null; fused: number | null; reranked: number | null };
};

export type SearchLabelResult = { set_id: string; strategy: Strategy; passages: Passage[] };

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ToolError };

const fail = <T>(error: ToolError['error'], detail: string): Outcome<T> => ({ ok: false, error: { error, detail } });

// What an error answer from the engine means for a caller.
function failure<T>(answer: Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index: string): Outcome<T> {
  if (answer.kind === 'timeout') return fail('search_timed_out', 'The search engine did not answer in time.');
  if (answer.kind === 'unreachable') return fail('search_unreachable', 'The search engine could not be reached.');
  if (indexMissing(answer)) {
    return fail('index_not_built', `The index "${index}" does not exist: the chunks have not been indexed (run knowledge/index.sh).`);
  }
  return fail('search_error', `The search engine answered with status ${answer.status}.`);
}

// The answer when a whole search has used its time: the existing search_timed_out, saying which step it was on.
function outOfTime<T>(budget: SearchBudget, step: string): Outcome<T> {
  return fail('search_timed_out', `The search as a whole ran out of time (its limit is ${budget.limitMs / 1000} s) while ${step}.`);
}

// One engine request within what is left of the search: not sent when nothing is left, and ended when the time
// runs out. 'out_of_time' when it was the search's limit, not the request's own, that ended it.
async function engineSend(engine: Engine, budget: SearchBudget, method: 'GET' | 'POST', path: string, body?: unknown): Promise<EngineAnswer | 'out_of_time'> {
  if (budget.spent()) return 'out_of_time';
  const answer = await engine.send(method, path, body, undefined, budget.signal());
  return answer.kind === 'timeout' && budget.spent() ? 'out_of_time' : answer;
}

// An answer of status 200 can still say that it is not whole: the search ran out of time, or a shard failed. Such an
// answer is not read as a result, in a search or a count.
const completenessSchema = z.object({
  timed_out: z.boolean().optional(),
  _shards: z.object({ failed: z.number().optional() }).optional(),
});

function incomplete<T>(body: unknown): Outcome<T> | undefined {
  const flags = completenessSchema.safeParse(body);
  if (!flags.success) return undefined;
  if (flags.data.timed_out === true) return fail('search_timed_out', 'The search engine ran out of time and answered with part of a result.');
  if ((flags.data._shards?.failed ?? 0) > 0) return fail('search_error', 'The search engine answered with a result from which a shard failed.');
  return undefined;
}

const hitsSchema = <S extends z.ZodTypeAny>(source: S) =>
  z.object({ hits: z.object({ hits: z.array(z.object({ _score: z.number().nullable().optional(), _source: source })) }) });

// A label's version as the index holds it (a keyword, so it may come back as text): a whole number of 1 or more, or
// the document is not one this service can answer with.
const version = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().positive());

const labelSource = z.object({
  setId: z.string(),
  version,
  effectiveTime: z.string(),
  kind: z.string(),
  format: z.string(),
  drug: z.array(z.string()),
  source: z.string(),
});

// The fields a search returns of each chunk: the result's, and the context line the reranker reads.
export const PASSAGE_FIELDS = ['id', 'text', 'context', 'part', 'type', 'section', 'position', 'setId', 'version', 'effectiveTime', 'kind', 'source'];

const passageSource = z.object({
  id: z.string(),
  text: z.string(),
  part: z.string(),
  type: z.string(),
  section: z.object({ number: z.string().nullable(), title: z.string().nullable(), path: z.array(z.string()) }),
  position: z.record(z.string(), z.number()),
  setId: z.string(),
  version,
  effectiveTime: z.string(),
  kind: z.string(),
  source: z.string(),
  // The chunk's context line, sent to the reranker with its text; not part of a result.
  context: z.string().nullable().optional(),
});

const countSchema = z.object({ count: z.number().int().nonnegative() });

// ---------- find_labels ----------

export async function findLabels(
  engine: Engine,
  index: string,
  input: { drug?: unknown },
  limit: SearchLimit = DEFAULT_SEARCH_LIMIT,
): Promise<Outcome<FindLabelsResult>> {
  const budget = new SearchBudget(limit);
  if (typeof input.drug !== 'string' || input.drug.trim() === '') return fail('invalid_input', '"drug" must be a name, not empty.');
  const drug = input.drug.trim();
  if (drug.length > MAX_DRUG_CHARACTERS) return fail('invalid_input', `"drug" is longer than ${MAX_DRUG_CHARACTERS} characters.`);

  const request = (match: unknown) => ({
    size: LABELS_LISTED + 1,
    query: { bool: { filter: [match] } },
    collapse: { field: 'setId' },
    sort: [{ effectiveTime: 'desc' }, { setId: 'asc' }],
    _source: ['setId', 'version', 'effectiveTime', 'kind', 'format', 'drug', 'source'],
  });

  for (const [matchedBy, match] of [
    ['exact_name', { term: { 'drug.exact': drug.toLowerCase() } }],
    ['every_word', { match: { drug: { query: drug, operator: 'and' } } }],
  ] as const) {
    const answer = await engineSend(engine, budget, 'POST', `/${index}/_search`, request(match));
    if (answer === 'out_of_time') return outOfTime(budget, matchedBy === 'exact_name' ? 'looking for labels with that exact name' : 'looking for labels with every word of the name');
    if (answer.kind !== 'answer' || answer.status !== 200) return failure(answer as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index);
    const partial = incomplete<FindLabelsResult>(answer.body);
    if (partial !== undefined) return partial;
    const parsed = hitsSchema(labelSource).safeParse(answer.body);
    if (!parsed.success) return fail('search_unexpected_answer', 'The search engine answered in a form this service does not expect.');
    const hits = parsed.data.hits.hits;
    if (hits.length === 0) continue;
    return {
      ok: true,
      value: {
        labels: hits.slice(0, LABELS_LISTED).map(({ _source: label }) => ({
          set_id: label.setId,
          version: Number(label.version),
          effective_date: label.effectiveTime,
          kind: label.kind,
          format: label.format,
          names: label.drug,
          source: label.source,
        })),
        more_matched: hits.length > LABELS_LISTED,
        matched_by: matchedBy,
      },
    };
  }
  return { ok: true, value: { labels: [], more_matched: false, matched_by: 'none' } };
}

// ---------- search_label ----------

export type SearchLabelInput = { set_id?: unknown; query?: unknown; part?: unknown; max_results?: unknown };

export function checkSearchInput(
  input: SearchLabelInput,
): { ok: true; setId: string; query: string; part: (typeof PARTS)[number] | undefined; size: number } | { ok: false; error: ToolError } {
  const refuse = (detail: string) => ({ ok: false as const, error: { error: 'invalid_input' as const, detail } });
  if (typeof input.set_id !== 'string' || !GUID.test(input.set_id)) return refuse('"set_id" must be a label set id: a lowercase GUID.');
  if (typeof input.query !== 'string' || input.query.trim() === '') return refuse('"query" must be words to search for, not empty.');
  if (input.query.length > MAX_QUERY_CHARACTERS) return refuse(`"query" is longer than ${MAX_QUERY_CHARACTERS} characters.`);
  let part: (typeof PARTS)[number] | undefined;
  if (input.part !== undefined && input.part !== null) {
    const found = PARTS.find((candidate) => candidate === input.part);
    if (found === undefined) return refuse(`"part" must be one of ${PARTS.join(', ')}, or left out for both.`);
    part = found;
  }
  let size = DEFAULT_RESULTS;
  if (input.max_results !== undefined && input.max_results !== null) {
    if (typeof input.max_results !== 'number' || !Number.isInteger(input.max_results) || input.max_results < 1 || input.max_results > MAX_RESULTS) {
      return refuse(`"max_results" must be a whole number from 1 to ${MAX_RESULTS}.`);
    }
    size = input.max_results;
  }
  return { ok: true, setId: input.set_id, query: input.query.trim(), part, size };
}

// The request sent: the set id (and part) as exact filters set by code; the words as a full-text match, which
// the engine never reads as operators.
export function searchRequest(setId: string, query: string, part: string | undefined, size: number): unknown {
  const filter: unknown[] = [{ term: { setId } }];
  if (part !== undefined) filter.push({ term: { part } });
  return {
    size,
    query: { bool: { filter, must: [{ multi_match: { query, fields: ['text', 'context'], type: 'most_fields' } }] } },
    _source: PASSAGE_FIELDS,
  };
}

// ---------- how search_label ranks ----------

// What a strategy other than keyword needs: the embedding server, and for fused_reranked the reranker. Chosen by the
// service's setting, never by the caller.
export type Retriever = {
  strategy: Strategy;
  embedding: { client: ModelClient; modelId: string; identity: ConfiguredIdentity } | null;
  rerank: { client: ModelClient; modelId: string } | null;
  // The verdict on each concrete index's recorded embedding identity, by index name (never by alias): an index's
  // _meta does not change once it is built.
  verdicts: Map<string, ToolError | 'matches'>;
  // The time one whole search has, whatever its strategy.
  limit: SearchLimit;
};

export const KEYWORD: Retriever = { strategy: 'keyword', embedding: null, rerank: null, verdicts: new Map(), limit: DEFAULT_SEARCH_LIMIT };

// Passages fused, and passages sent to the reranker.
export const FUSION_DEPTH = 50;
export const RERANK_DEPTH = 20;
// The most tokens of each passage the reranker reads; a longer one is read in part.
export const RERANK_MAX_TOKENS_PER_DOC = 7000;

const NO_RANKS = { keyword: null, vector: null, fused: null, reranked: null };

type Hit = { score: number; chunk: z.infer<typeof passageSource> };

function toPassage(hit: Hit, score: number, ranks: Passage['ranks'], scores: Passage['scores']): Passage {
  const { chunk } = hit;
  return {
    chunk_id: chunk.id,
    text: chunk.text,
    score,
    part: chunk.part,
    type: chunk.type,
    section: { number: chunk.section.number, title: chunk.section.title, path: chunk.section.path },
    position: chunk.position,
    label: { set_id: chunk.setId, version: chunk.version, effective_date: chunk.effectiveTime, kind: chunk.kind, source: chunk.source },
    ranks,
    scores,
  };
}

// One engine search inside one label, read as a list of hits best first. `step` names it if the search's time runs
// out.
async function hitsOf(engine: Engine, budget: SearchBudget, step: string, index: string, setId: string, request: unknown): Promise<Outcome<Hit[]>> {
  const answer = await engineSend(engine, budget, 'POST', `/${index}/_search`, request);
  if (answer === 'out_of_time') return outOfTime(budget, step);
  if (answer.kind !== 'answer' || answer.status !== 200) return failure(answer as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index);
  const partial = incomplete<Hit[]>(answer.body);
  if (partial !== undefined) return partial;
  const parsed = hitsSchema(passageSource).safeParse(answer.body);
  if (!parsed.success) return fail('search_unexpected_answer', 'The search engine answered in a form this service does not expect.');
  const hits = parsed.data.hits.hits;
  if (hits.some((hit) => hit._source.setId !== setId)) {
    return fail('search_unexpected_answer', 'The search engine returned a passage from another label.');
  }
  return { ok: true, value: hits.map((hit) => ({ score: hit._score ?? 0, chunk: hit._source })) };
}

// No passage: is the label there at all? "No such label" must not read as "the label says nothing".
async function labelExists(engine: Engine, budget: SearchBudget, index: string, setId: string): Promise<Outcome<boolean>> {
  const counted = await engineSend(engine, budget, 'POST', `/${index}/_count`, { query: { term: { setId } } });
  if (counted === 'out_of_time') return outOfTime(budget, "counting the label's passages");
  if (counted.kind !== 'answer' || counted.status !== 200) return failure(counted as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index);
  const partialCount = incomplete<boolean>(counted.body);
  if (partialCount !== undefined) return partialCount;
  const count = countSchema.safeParse(counted.body);
  if (!count.success) return fail('search_unexpected_answer', 'The search engine answered in a form this service does not expect.');
  return { ok: true, value: count.data.count > 0 };
}

// The exact vector search, inside one label, over the documents that have a vector. The engine scores each by
// (1 + cosine) / 2.
export function vectorRequest(setId: string, part: string | undefined, vector: readonly number[], size: number): unknown {
  const filter: unknown[] = [{ term: { setId } }];
  if (part !== undefined) filter.push({ term: { part } });
  filter.push({ term: { hasVector: true } });
  return {
    size,
    query: {
      script_score: {
        query: { bool: { filter } },
        script: { lang: 'knn', source: 'knn_score', params: { field: 'embedding', query_value: vector, space_type: 'cosinesimil' } },
      },
    },
    _source: PASSAGE_FIELDS,
  };
}

const identitySchema = z.object({
  repository: z.string(),
  revision: z.string(),
  dimensions: z.number().int().positive(),
  recipe: z.string(),
  instruction: z.string(),
  vectorsSha256: z.string(),
});

// The concrete index the alias points at, and whether the vectors it holds were made the way this service makes a
// query's vector. Both legs of a search then run against that one index, so a move of the alias between them cannot
// mix two indexes.
async function vectorIndex(engine: Engine, budget: SearchBudget, alias: string, retriever: Retriever, configured: ConfiguredIdentity): Promise<Outcome<string>> {
  const answer = await engineSend(engine, budget, 'GET', `/${alias}/_mapping`);
  if (answer === 'out_of_time') return outOfTime(budget, 'reading which index the alias points at');
  if (answer.kind !== 'answer' || answer.status !== 200) return failure(answer as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, alias);
  const body = answer.body;
  const names = typeof body === 'object' && body !== null ? Object.keys(body) : [];
  const [index] = names;
  if (index === undefined || names.length !== 1) return fail('search_unexpected_answer', `The alias "${alias}" does not point at exactly one index.`);
  const known = retriever.verdicts.get(index);
  if (known !== undefined) return known === 'matches' ? { ok: true, value: index } : { ok: false, error: known };

  const recorded = field(field(field(field(body, index), 'mappings'), '_meta'), 'embedding');
  let verdict: ToolError | 'matches';
  if (recorded === null || recorded === undefined) {
    verdict = { error: 'vectors_not_built', detail: `The index ${index} holds no vectors: it was built without an embed report (knowledge/embed.sh, then knowledge/index.sh).` };
  } else {
    const identity = identitySchema.safeParse(recorded);
    const differences = identity.success ? identityDifferences(identity.data as EmbeddingIdentity, configured) : ['identity'];
    verdict =
      differences.length === 0
        ? 'matches'
        : { error: 'vectors_do_not_match', detail: `The vectors in ${index} were made with another ${differences.join(', ')} than this service makes a query's vector with.` };
  }
  retriever.verdicts.set(index, verdict);
  return verdict === 'matches' ? { ok: true, value: index } : { ok: false, error: verdict };
}

const MODEL_CODES = {
  embedding: { name: 'The embedding server', unreachable: 'embedding_unreachable', timeout: 'embedding_timed_out', error: 'embedding_error' },
  rerank: { name: 'The reranker', unreachable: 'rerank_unreachable', timeout: 'rerank_timed_out', error: 'rerank_error' },
} as const;

function modelFailure(server: 'embedding' | 'rerank', answer: Exclude<ModelAnswer<unknown>, { kind: 'ok' }>): ToolError {
  const codes = MODEL_CODES[server];
  if (answer.kind === 'unreachable') return { error: codes.unreachable, detail: `${codes.name} could not be reached.` };
  if (answer.kind === 'timeout') return { error: codes.timeout, detail: `${codes.name} did not answer in time.` };
  if (answer.kind === 'status') return { error: codes.error, detail: `${codes.name} answered with status ${answer.status}.` };
  if (answer.kind === 'over_length') return { error: codes.error, detail: `${codes.name} refused the query as too long.` };
  return { error: codes.error, detail: `${codes.name} answered in a form this service does not expect.` };
}

// A field of a JSON value this module does not otherwise type.
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

// The query's vector, from the embedding server, with the instruction in front.
async function queryVector(retriever: Retriever, budget: SearchBudget, query: string): Promise<Outcome<number[]>> {
  const embedding = retriever.embedding;
  if (embedding === null) return fail('embedding_error', 'This service has no embedding server configured.');
  const step = 'asking the embedding server for the query vector';
  if (budget.spent()) return outOfTime(budget, step);
  const answer = await embedding.client.embed(embedding.modelId, [queryText(query)], budget.signal());
  if (answer.kind === 'timeout' && budget.spent()) return outOfTime(budget, step);
  if (answer.kind !== 'ok') return { ok: false, error: modelFailure('embedding', answer) };
  let values: Float32Array;
  try {
    values = decodeVector(answer.value.vectors[0] ?? '');
  } catch {
    return fail('embedding_error', 'The embedding server answered with a vector this service cannot read.');
  }
  if (values.length !== embedding.identity.dimensions) {
    return fail('embedding_error', `The embedding server answered with a vector of other than ${embedding.identity.dimensions} numbers.`);
  }
  return { ok: true, value: Array.from(values) };
}

async function vectorHits(
  engine: Engine,
  budget: SearchBudget,
  index: string,
  retriever: Retriever,
  setId: string,
  query: string,
  part: string | undefined,
  size: number,
): Promise<Outcome<Hit[]>> {
  const vector = await queryVector(retriever, budget, query);
  if (!vector.ok) return vector;
  return hitsOf(engine, budget, 'running the vector search', index, setId, vectorRequest(setId, part, vector.value, size));
}

const cosine = (engineScore: number): number => 2 * engineScore - 1;

export async function searchLabel(engine: Engine, index: string, input: SearchLabelInput, retriever: Retriever = KEYWORD): Promise<Outcome<SearchLabelResult>> {
  const checked = checkSearchInput(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { setId, query, part, size } = checked;
  const { strategy } = retriever;
  // One time limit for the whole search; every request below gets what is left of it.
  const budget = new SearchBudget(retriever.limit);

  let passages: Passage[];
  // Keyword searches the alias itself, as it always has: no extra request.
  let searched = index;
  if (strategy === 'keyword') {
    const keyword = await hitsOf(engine, budget, 'running the keyword search', index, setId, searchRequest(setId, query, part, size));
    if (!keyword.ok) return keyword;
    passages = keyword.value.map((hit, at) => toPassage(hit, hit.score, { ...NO_RANKS, keyword: at + 1 }, { ...NO_RANKS, keyword: hit.score }));
  } else {
    const configured = retriever.embedding?.identity;
    if (configured === undefined) return fail('embedding_error', 'This service has no embedding server configured.');
    const concrete = await vectorIndex(engine, budget, index, retriever, configured);
    if (!concrete.ok) return concrete;
    searched = concrete.value;

    if (strategy === 'vector') {
      const vector = await vectorHits(engine, budget, searched, retriever, setId, query, part, size);
      if (!vector.ok) return vector;
      passages = vector.value.map((hit, at) => toPassage(hit, cosine(hit.score), { ...NO_RANKS, vector: at + 1 }, { ...NO_RANKS, vector: cosine(hit.score) }));
    } else {
      // Both legs at once, against the same index. A failure of either is the answer: never one leg alone.
      const [keyword, vector] = await Promise.all([
        hitsOf(engine, budget, 'running the keyword search', searched, setId, searchRequest(setId, query, part, FUSION_DEPTH)),
        vectorHits(engine, budget, searched, retriever, setId, query, part, FUSION_DEPTH),
      ]);
      if (!keyword.ok) return keyword;
      if (!vector.ok) return vector;
      const byId = new Map<string, { hit: Hit; keyword: number | null; vector: number | null }>();
      for (const hit of keyword.value) byId.set(hit.chunk.id, { hit, keyword: hit.score, vector: null });
      for (const hit of vector.value) {
        const known = byId.get(hit.chunk.id);
        if (known === undefined) byId.set(hit.chunk.id, { hit, keyword: null, vector: cosine(hit.score) });
        else known.vector = cosine(hit.score);
      }
      const fused = fuse(
        keyword.value.map((hit) => hit.chunk.id),
        vector.value.map((hit) => hit.chunk.id),
      );
      // Every fused id came from one of the two lists, so each has its hit.
      const ranked = fused.flatMap((entry) => {
        const found = byId.get(entry.id);
        return found === undefined ? [] : [{ entry, found }];
      });

      if (strategy === 'fused') {
        passages = ranked
          .slice(0, size)
          .map(({ entry, found }) =>
            toPassage(
              found.hit,
              entry.score,
              { keyword: entry.keywordRank, vector: entry.vectorRank, fused: entry.fusedRank, reranked: null },
              { keyword: found.keyword, vector: found.vector, fused: entry.score, reranked: null },
            ),
          );
      } else {
        const rerank = retriever.rerank;
        if (rerank === null) return fail('rerank_error', 'This service has no reranker configured.');
        const top = ranked.slice(0, RERANK_DEPTH);
        let order: { item: (typeof top)[number]; score: number; rerankedRank: number }[] = [];
        if (top.length > 0) {
          const step = 'asking the reranker';
          if (budget.spent()) return outOfTime(budget, step);
          // The reranker judges the same text the vectors were made from: the context line, a newline, the text.
          const answer = await rerank.client.rerank(
            rerank.modelId,
            query,
            top.map(({ found }) => documentText(found.hit.chunk)),
            RERANK_MAX_TOKENS_PER_DOC,
            budget.signal(),
          );
          if (answer.kind === 'timeout' && budget.spent()) return outOfTime(budget, step);
          if (answer.kind !== 'ok') return { ok: false, error: modelFailure('rerank', answer) };
          const scores: number[] = new Array<number>(top.length).fill(0);
          for (const result of answer.value) scores[result.index] = result.score;
          order = rerankOrder(top, scores);
        }
        passages = order
          .slice(0, size)
          .map(({ item: { entry, found }, score, rerankedRank }) =>
            toPassage(
              found.hit,
              score,
              { keyword: entry.keywordRank, vector: entry.vectorRank, fused: entry.fusedRank, reranked: rerankedRank },
              { keyword: found.keyword, vector: found.vector, fused: entry.score, reranked: score },
            ),
          );
      }
    }
  }

  if (passages.length === 0) {
    const exists = await labelExists(engine, budget, searched, setId);
    if (!exists.ok) return exists;
    if (!exists.value) return fail('label_not_found', `No label with set id ${setId} is in the index.`);
  }
  return { ok: true, value: { set_id: setId, strategy, passages } };
}
