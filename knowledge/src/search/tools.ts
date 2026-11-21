// The two retrieval tools, as plain functions over the engine. Each checks its input before anything is sent,
// builds the request in code (the user's words go only into a full-text match, never into a query language), and
// turns every way the engine can fail into an error result that says which. An empty list is only ever an answer.

import { z } from 'zod';

import type { Engine, EngineAnswer } from './engine.ts';
import { indexMissing } from './engine.ts';

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
    | 'search_unexpected_answer';
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
};

export type SearchLabelResult = { set_id: string; passages: Passage[] };

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

const hitsSchema = <S extends z.ZodTypeAny>(source: S) =>
  z.object({ hits: z.object({ hits: z.array(z.object({ _score: z.number().nullable().optional(), _source: source })) }) });

const labelSource = z.object({
  setId: z.string(),
  version: z.union([z.number(), z.string()]),
  effectiveTime: z.string(),
  kind: z.string(),
  format: z.string(),
  drug: z.array(z.string()),
  source: z.string(),
});

const passageSource = z.object({
  id: z.string(),
  text: z.string(),
  part: z.string(),
  type: z.string(),
  section: z.object({ number: z.string().nullable(), title: z.string().nullable(), path: z.array(z.string()) }),
  position: z.record(z.string(), z.number()),
  setId: z.string(),
  version: z.union([z.number(), z.string()]),
  effectiveTime: z.string(),
  kind: z.string(),
  source: z.string(),
});

const countSchema = z.object({ count: z.number().int().nonnegative() });

// ---------- find_labels ----------

export async function findLabels(engine: Engine, index: string, input: { drug?: unknown }): Promise<Outcome<FindLabelsResult>> {
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
    const answer = await engine.send('POST', `/${index}/_search`, request(match));
    if (answer.kind !== 'answer' || answer.status !== 200) return failure(answer as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index);
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
    _source: ['id', 'text', 'part', 'type', 'section', 'position', 'setId', 'version', 'effectiveTime', 'kind', 'source'],
  };
}

export async function searchLabel(engine: Engine, index: string, input: SearchLabelInput): Promise<Outcome<SearchLabelResult>> {
  const checked = checkSearchInput(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  const { setId, query, part, size } = checked;

  const answer = await engine.send('POST', `/${index}/_search`, searchRequest(setId, query, part, size));
  if (answer.kind !== 'answer' || answer.status !== 200) return failure(answer as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index);
  const parsed = hitsSchema(passageSource).safeParse(answer.body);
  if (!parsed.success) return fail('search_unexpected_answer', 'The search engine answered in a form this service does not expect.');
  const hits = parsed.data.hits.hits;
  if (hits.some((hit) => hit._source.setId !== setId)) {
    return fail('search_unexpected_answer', 'The search engine returned a passage from another label.');
  }

  if (hits.length === 0) {
    // No passage: is the label there at all? "No such label" must not read as "the label says nothing".
    const counted = await engine.send('POST', `/${index}/_count`, { query: { term: { setId } } });
    if (counted.kind !== 'answer' || counted.status !== 200) return failure(counted as Exclude<EngineAnswer, { kind: 'answer'; status: 200 }>, index);
    const count = countSchema.safeParse(counted.body);
    if (!count.success) return fail('search_unexpected_answer', 'The search engine answered in a form this service does not expect.');
    if (count.data.count === 0) return fail('label_not_found', `No label with set id ${setId} is in the index.`);
  }

  return {
    ok: true,
    value: {
      set_id: setId,
      passages: hits.map(({ _score, _source: chunk }) => ({
        chunk_id: chunk.id,
        text: chunk.text,
        score: _score ?? 0,
        part: chunk.part,
        type: chunk.type,
        section: { number: chunk.section.number, title: chunk.section.title, path: chunk.section.path },
        position: chunk.position,
        label: { set_id: chunk.setId, version: Number(chunk.version), effective_date: chunk.effectiveTime, kind: chunk.kind, source: chunk.source },
      })),
    },
  };
}
