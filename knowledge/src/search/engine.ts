// The search engine's REST API, spoken with fetch and nothing else, so every request sent and every field read is
// visible here. The transport and the deadline of each request are passed in.

export type EngineOptions = {
  baseUrl: string;
  fetch: typeof fetch;
  // A fresh signal for each request; it aborts when the request has had its time.
  deadline: () => AbortSignal;
};

export type EngineAnswer =
  | { kind: 'answer'; status: number; body: unknown }
  // The engine did not answer within the deadline.
  | { kind: 'timeout' }
  // No connection, or the connection closed before an answer.
  | { kind: 'unreachable' };

export type Engine = {
  // limit: an extra signal that ends the request early (what is left of a whole search).
  send(method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, contentType?: string, limit?: AbortSignal): Promise<EngineAnswer>;
};

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

export function createEngine(options: EngineOptions): Engine {
  return {
    async send(method, path, body, contentType = 'application/json', limit) {
      // The request's own deadline, and the caller's (what is left of a whole search) when it gives one.
      const own = options.deadline();
      const init: RequestInit = { method, signal: limit === undefined ? own : AbortSignal.any([own, limit]), headers: { accept: 'application/json' } };
      if (body !== undefined) {
        init.headers = { accept: 'application/json', 'content-type': contentType };
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      let response: Response;
      try {
        response = await options.fetch(`${options.baseUrl}${path}`, init);
      } catch (error) {
        return isAbort(error) ? { kind: 'timeout' } : { kind: 'unreachable' };
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return isAbort(error) ? { kind: 'timeout' } : { kind: 'unreachable' };
      }
      let parsed: unknown = undefined;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      return { kind: 'answer', status: response.status, body: parsed };
    },
  };
}

// Whether an error answer says the index or alias does not exist.
export function indexMissing(answer: EngineAnswer): boolean {
  if (answer.kind !== 'answer' || answer.status !== 404) return false;
  const body = answer.body;
  if (typeof body !== 'object' || body === null) return false;
  const error: unknown = Reflect.get(body, 'error');
  if (typeof error !== 'object' || error === null) return false;
  return Reflect.get(error, 'type') === 'index_not_found_exception';
}
