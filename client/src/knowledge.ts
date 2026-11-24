// The lab explorer's view of knowledge: what the label index holds, read from the search engine as the knowledge
// gate reads it (the alias, its count, its mapping), and a label search made through the retrieval service the way
// the label expert makes one: find_labels with the medicine, then search_label on the label found with the question.
//
// The engine and the retrieval service are reached through two small interfaces, so the server is given them as
// values. The ones below that talk to the real services are engineAt and retrievalAt. Every way a call can fail comes
// back as a code and a sentence; nothing is retried, and no answer is read until it has the shape expected. Nothing
// here logs: the medicine, the question and the passages are label text.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { FoundLabel, FoundPassage, KnowledgeCall, KnowledgeSearchResponse, KnowledgeTool, LabelIndex } from '../shared/api.ts';
import { isTimeout, seconds } from './agents.ts';

// The alias the retrieval service searches (SEARCH_INDEX in knowledge/compose.yaml), and the one the knowledge gate
// reads.
export const LABEL_ALIAS = 'labels';
// The scope a token for the retrieval service must hold.
export const LABELS_SCOPE = 'labels:search';
// The retrieval service's own limits on find_labels's drug and search_label's query.
export const MAX_MEDICINE_LENGTH = 200;
export const MAX_QUESTION_LENGTH = 1000;

export const ENGINE_TIMEOUT_MS = 5_000;
// A whole search has 8 s at the service (knowledge/src/search/limits.ts); connecting comes on top.
export const RETRIEVAL_TIMEOUT_MS = 15_000;

// What the engine answered to a GET, or why it did not. The reason never holds the engine's address.
export type EngineAnswer = { outcome: 'answered'; status: number; body: unknown } | { outcome: 'down'; reason: string };
export type SearchEngine = { get: (path: string) => Promise<EngineAnswer> };

// What the retrieval service answered to one tool call (its payload, the JSON its one piece of text holds), or why
// there was no answer: the code and the sentence the explorer shows.
export type ToolAnswer = { outcome: 'answered'; isError: boolean; payload: unknown } | { outcome: 'down'; code: string; reason: string };
export type RetrievalService = { call: (token: string, tool: KnowledgeTool, args: Record<string, string>) => Promise<ToolAnswer> };

// Null where the setting that names it (SEARCH_URL, RETRIEVAL_URL) is not set.
export type KnowledgeServices = { engine: SearchEngine | null; retrieval: RetrievalService | null };

// ---------- what the index holds ----------

export type IndexRead = { ok: true; index: LabelIndex } | { ok: false; code: string; detail: string };

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

const embeddingSchema = z.object({ repository: z.string(), revision: z.string(), dimensions: z.number().int().positive(), recipe: z.string() });

function engineFailed(path: string, answer: EngineAnswer): IndexRead {
  if (answer.outcome === 'down') return { ok: false, code: 'search_unreachable', detail: `The search engine did not answer GET ${path}: ${answer.reason}` };
  return { ok: false, code: 'search_error', detail: `The search engine answered GET ${path} with status ${answer.status}.` };
}

const unexpected = (detail: string): IndexRead => ({ ok: false, code: 'search_unexpected_answer', detail });

// The alias, the one index it points at, that index's count of documents, and the embedding identity its mapping
// records: null for an index that records none, which the retrieval service too reads as an index without vectors.
// An alias that does not exist is an index not built.
export async function readLabelIndex(engine: SearchEngine): Promise<IndexRead> {
  const aliasPath = `/_alias/${LABEL_ALIAS}`;
  const alias = await engine.get(aliasPath);
  if (alias.outcome === 'answered' && alias.status === 404) {
    return {
      ok: true,
      index: {
        state: 'not_built',
        alias: LABEL_ALIAS,
        detail: `The alias "${LABEL_ALIAS}" does not exist: the label index has not been built. Build it with knowledge/index.sh <compose-project> (knowledge/README.md).`,
      },
    };
  }
  if (alias.outcome === 'down' || alias.status !== 200) return engineFailed(aliasPath, alias);
  const targets = typeof alias.body === 'object' && alias.body !== null ? Object.keys(alias.body) : [];
  const [index] = targets;
  if (index === undefined || targets.length !== 1) return unexpected(`The alias "${LABEL_ALIAS}" points at ${targets.length} indexes, not one.`);

  const countPath = `/${LABEL_ALIAS}/_count`;
  const counted = await engine.get(countPath);
  if (counted.outcome === 'down' || counted.status !== 200) return engineFailed(countPath, counted);
  const passages = field(counted.body, 'count');
  if (typeof passages !== 'number' || !Number.isInteger(passages) || passages < 0) return unexpected(`The search engine's answer to GET ${countPath} has no count.`);

  const mappingPath = `/${LABEL_ALIAS}/_mapping`;
  const mapping = await engine.get(mappingPath);
  if (mapping.outcome === 'down' || mapping.status !== 200) return engineFailed(mappingPath, mapping);
  const recorded = field(field(field(field(mapping.body, index), 'mappings'), '_meta'), 'embedding');
  if (recorded === null || recorded === undefined) return { ok: true, index: { state: 'built', alias: LABEL_ALIAS, index, passages, embedding: null } };
  const embedding = embeddingSchema.safeParse(recorded);
  if (!embedding.success) return unexpected(`The mapping of ${index} records no embedding identity this server can read.`);
  return { ok: true, index: { state: 'built', alias: LABEL_ALIAS, index, passages, embedding: embedding.data } };
}

// ---------- a label search ----------

const errorSchema = z.object({ error: z.string().min(1), detail: z.string() });

const labelSchema = z.object({
  set_id: z.string(),
  version: z.number().int(),
  effective_date: z.string(),
  kind: z.string(),
  names: z.array(z.string()),
  source: z.string(),
});

const findSchema = z.object({ labels: z.array(labelSchema) });

const rank = z.number().int().positive().nullable();
const passageSchema = z.object({
  chunk_id: z.string(),
  text: z.string(),
  score: z.number(),
  part: z.string(),
  section: z.object({ number: z.string().nullable(), title: z.string().nullable(), path: z.array(z.string()) }),
  label: z.object({ set_id: z.string(), version: z.number().int(), effective_date: z.string(), source: z.string() }),
  ranks: z.object({ keyword: rank, vector: rank, fused: rank, reranked: rank }).optional(),
});

const searchSchema = z.object({ strategy: z.string().min(1), passages: z.array(passageSchema) });

export type SearchResult = { status: 200 | 502; body: KnowledgeSearchResponse };

const failedWith = (calls: KnowledgeCall[], error: string, detail: string): SearchResult => ({ status: 502, body: { outcome: 'failed', calls, error, detail } });

// A tool's answer read against its schema: the value, or the failure the explorer is answered with. An error result
// is the service's own code and sentence.
function readTool<T>(tool: KnowledgeTool, answer: ToolAnswer, schema: z.ZodType<T>, calls: KnowledgeCall[]): { ok: true; value: T } | { ok: false; failure: SearchResult } {
  if (answer.outcome === 'down') return { ok: false, failure: failedWith(calls, answer.code, answer.reason) };
  if (answer.isError) {
    const error = errorSchema.safeParse(answer.payload);
    return {
      ok: false,
      failure: error.success
        ? failedWith(calls, error.data.error, error.data.detail)
        : failedWith(calls, 'retrieval_unexpected_answer', `The retrieval service answered ${tool} with an error this server could not read.`),
    };
  }
  const parsed = schema.safeParse(answer.payload);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, failure: failedWith(calls, 'retrieval_unexpected_answer', `The retrieval service answered ${tool} in a form this server does not read.`) };
}

// find_labels with the medicine, then, when a label is found, search_label on the first one listed (the newest) with
// the question; each call timed by `now`. The service decides the number of passages and the strategy.
export async function labelSearch(retrieval: RetrievalService, token: string, medicine: string, question: string, now: () => Date): Promise<SearchResult> {
  const calls: KnowledgeCall[] = [];
  const timed = async (tool: KnowledgeTool, sent: Record<string, string>): Promise<ToolAnswer> => {
    const started = now().getTime();
    const answer = await retrieval.call(token, tool, sent);
    calls.push({ tool, sent, duration_ms: now().getTime() - started });
    return answer;
  };

  const foundAnswer = await timed('find_labels', { drug: medicine });
  const found = readTool('find_labels', foundAnswer, findSchema, calls);
  if (!found.ok) return found.failure;
  const labels: FoundLabel[] = found.value.labels;
  const [first] = labels;
  if (first === undefined) {
    return { status: 200, body: { outcome: 'no_label', calls, answer: foundAnswer.outcome === 'answered' ? foundAnswer.payload : null } };
  }

  const searched = readTool('search_label', await timed('search_label', { set_id: first.set_id, query: question }), searchSchema, calls);
  if (!searched.ok) return searched.failure;
  const passages: FoundPassage[] = searched.value.passages.map((passage, at) => ({
    rank: at + 1,
    chunk_id: passage.chunk_id,
    text: passage.text,
    score: passage.score,
    part: passage.part,
    section: passage.section,
    label: passage.label,
    ranks: passage.ranks ?? null,
  }));
  return { status: 200, body: { outcome: 'found', calls, labels, searched: first, strategy: searched.value.strategy, passages } };
}

// ---------- the real services ----------

// The search engine's REST API at its base URL. A failed connection keeps only its error code: fetch names the
// address in the cause.
export function engineAt(baseUrl: string, timeoutMs: number = ENGINE_TIMEOUT_MS): SearchEngine {
  return {
    async get(path) {
      try {
        const response = await fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        const text = await response.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        return { outcome: 'answered', status: response.status, body };
      } catch (error) {
        if (isTimeout(error)) return { outcome: 'down', reason: `It did not answer within ${seconds(timeoutMs)}.` };
        const cause: unknown = error instanceof Error ? error.cause : undefined;
        const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
        return { outcome: 'down', reason: code === undefined ? 'Could not reach it.' : `Could not reach it (${code}).` };
      }
    },
  };
}

// The texts an error and its causes carry. The MCP client puts the body of a refused request in its message.
function textsOf(error: unknown, seen = new Set<unknown>()): string[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  return error instanceof Error ? [error.message, ...textsOf(error.cause, seen)] : [String(error)];
}

// Why connecting to the retrieval service failed. It answers a refused token with 401 {"error":"unauthorized"} or
// 403 {"error":"forbidden"}, and a token it cannot check with 503 {"error":"identity_unavailable"}.
function connectionFailure(error: unknown, timeoutMs: number): ToolAnswer {
  const texts = textsOf(error);
  if (texts.some((text) => text.includes('"error":"unauthorized"') || text.includes('"error":"forbidden"'))) {
    return { outcome: 'down', code: 'retrieval_refused_token', reason: "The retrieval service refused the lab explorer's token." };
  }
  if (texts.some((text) => text.includes('"error":"identity_unavailable"'))) {
    return { outcome: 'down', code: 'retrieval_could_not_check', reason: "The retrieval service could not check the lab explorer's token." };
  }
  return { outcome: 'down', code: 'retrieval_unreachable', reason: `The retrieval service could not be reached, or did not answer within ${seconds(timeoutMs)}.` };
}

// The retrieval service's MCP endpoint at its base URL. Each call is made on a new connection carrying the token, and
// the connection is closed after it.
export function retrievalAt(baseUrl: string, timeoutMs: number = RETRIEVAL_TIMEOUT_MS): RetrievalService {
  return {
    async call(token, tool, args) {
      const client = new Client({ name: 'lab-explorer', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
      try {
        try {
          await client.connect(transport, { timeout: timeoutMs });
        } catch (error) {
          return connectionFailure(error, timeoutMs);
        }
        let result: Awaited<ReturnType<Client['callTool']>>;
        try {
          result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
        } catch (error) {
          return connectionFailure(error, timeoutMs);
        }
        const content: unknown = result.content;
        const text = field(Array.isArray(content) ? content[0] : undefined, 'text');
        let payload: unknown = null;
        if (typeof text === 'string') {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }
        return { outcome: 'answered', isError: result.isError === true, payload };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}
