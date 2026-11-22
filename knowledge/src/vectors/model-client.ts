// The two model servers' APIs, spoken with fetch and nothing else: the embedding server's /models and /embeddings,
// and the reranker's /rerank. The transport and each request's deadline are passed in. The key is sent in the
// Authorization header of these requests and nowhere else; no answer or error here carries it.

import { z } from 'zod';

export type ModelAnswer<T> =
  | { kind: 'ok'; value: T }
  // The server refused the request because an input is longer than the model takes (embedding server only).
  | { kind: 'over_length' }
  | { kind: 'status'; status: number }
  | { kind: 'timeout' }
  // No connection, or the connection closed before an answer.
  | { kind: 'unreachable' }
  // Status 200 with a body that is not the expected shape.
  | { kind: 'unexpected' };

export type ModelClientOptions = {
  // Ends in /v1.
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  // A fresh signal for each request; it aborts when the request has had its time.
  deadline: () => AbortSignal;
};

// Whether a 400 is the embedding server refusing an input as longer than the model takes. The one place this is
// judged. vLLM answers such a request with an OpenAI-style error whose message says the model's "maximum context
// length"; any other 400 is not an over-length refusal.
export function isOverLength(status: number, body: unknown): boolean {
  if (status !== 400) return false;
  const error: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
  const fromError: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined;
  const fromTop: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'message') : undefined;
  const message = typeof fromError === 'string' ? fromError : typeof fromTop === 'string' ? fromTop : '';
  return /maximum context length/i.test(message);
}

const isAbort = (error: unknown): boolean => error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const embeddingsSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.string() })),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), total_tokens: z.number().int().nonnegative().optional() }).optional(),
});
const rerankSchema = z.object({ results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number() })) });

export type Embedded = { vectors: string[]; tokens: number };
export type Reranked = { index: number; score: number }[];

export type ModelClient = {
  listModels(): Promise<ModelAnswer<string[]>>;
  // One base64 vector per input, in the inputs' order.
  embed(model: string, inputs: readonly string[], limit?: AbortSignal): Promise<ModelAnswer<Embedded>>;
  // One score per document; every index given exactly once, or the answer is unexpected.
  rerank(model: string, query: string, documents: readonly string[], maxTokensPerDoc: number, limit?: AbortSignal): Promise<ModelAnswer<Reranked>>;
};

export function createModelClient(options: ModelClientOptions): ModelClient {
  async function send(method: 'GET' | 'POST', path: string, body?: unknown, limit?: AbortSignal): Promise<{ kind: 'answer'; status: number; body: unknown } | { kind: 'timeout' } | { kind: 'unreachable' }> {
    const init: RequestInit = {
      method,
      signal: limit === undefined ? options.deadline() : AbortSignal.any([options.deadline(), limit]),
      headers: { accept: 'application/json', authorization: `Bearer ${options.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    let text: string;
    try {
      response = await options.fetch(`${options.baseUrl}${path}`, init);
      text = await response.text();
    } catch (error) {
      return isAbort(error) ? { kind: 'timeout' } : { kind: 'unreachable' };
    }
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { kind: 'answer', status: response.status, body: parsed };
  }

  return {
    async listModels() {
      const answer = await send('GET', '/models');
      if (answer.kind !== 'answer') return answer;
      if (answer.status !== 200) return { kind: 'status', status: answer.status };
      const parsed = modelsSchema.safeParse(answer.body);
      return parsed.success ? { kind: 'ok', value: parsed.data.data.map((model) => model.id) } : { kind: 'unexpected' };
    },

    async embed(model, inputs, limit) {
      const answer = await send('POST', '/embeddings', { model, input: inputs, encoding_format: 'base64' }, limit);
      if (answer.kind !== 'answer') return answer;
      if (isOverLength(answer.status, answer.body)) return { kind: 'over_length' };
      if (answer.status !== 200) return { kind: 'status', status: answer.status };
      const parsed = embeddingsSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.data.length !== inputs.length) return { kind: 'unexpected' };
      const vectors: string[] = new Array<string>(inputs.length);
      for (const item of parsed.data.data) {
        if (item.index >= inputs.length || vectors[item.index] !== undefined) return { kind: 'unexpected' };
        vectors[item.index] = item.embedding;
      }
      const usage = parsed.data.usage;
      return { kind: 'ok', value: { vectors, tokens: usage?.total_tokens ?? usage?.prompt_tokens ?? 0 } };
    },

    async rerank(model, query, documents, maxTokensPerDoc, limit) {
      const answer = await send('POST', '/rerank', { model, query, documents, max_tokens_per_doc: maxTokensPerDoc }, limit);
      if (answer.kind !== 'answer') return answer;
      if (answer.status !== 200) return { kind: 'status', status: answer.status };
      const parsed = rerankSchema.safeParse(answer.body);
      if (!parsed.success || parsed.data.results.length !== documents.length) return { kind: 'unexpected' };
      const seen = new Set<number>();
      for (const result of parsed.data.results) {
        if (result.index >= documents.length || seen.has(result.index)) return { kind: 'unexpected' };
        seen.add(result.index);
      }
      return { kind: 'ok', value: parsed.data.results.map((result) => ({ index: result.index, score: result.relevance_score })) };
    },
  };
}
