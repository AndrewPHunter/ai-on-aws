// Reading what an MCP service answered, for any service an agent calls: why connecting to it failed, and the
// payload of a tool result. Each sentence names the service it is about, so a run's record never says one
// service when it means another.

export type ServiceSentences = {
  unreachable: string;
  refusedToken: string;
  couldNotCheck: string;
  notText: string;
};

// The sentences for a service, by the name a person knows it by, such as "case system".
export function serviceSentences(name: string): ServiceSentences {
  return {
    unreachable: `The ${name} could not be reached.`,
    refusedToken: `The ${name} refused the caller's token.`,
    couldNotCheck: `The ${name} could not check the caller's token.`,
    notText: `The ${name} answered with something that is not text.`,
  };
}

// Every error in a chain: each one, its cause, and the errors an aggregate holds.
function errorsIn(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (error === null || error === undefined || seen.has(error)) return [];
  seen.add(error);
  const found: unknown[] = [error];
  if (error instanceof Error) {
    found.push(...errorsIn(error.cause, seen));
  }
  if (error instanceof AggregateError) {
    for (const inner of error.errors) found.push(...errorsIn(inner, seen));
  }
  return found;
}

// The text an error carries about the answer it came from: its message, and the answer's body where the
// MCP client keeps it apart (@modelcontextprotocol/client puts it in data.text).
function textsOf(error: unknown): string[] {
  const texts = [error instanceof Error ? error.message : String(error)];
  const data: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'data') : undefined;
  const body: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'text') : undefined;
  if (typeof body === 'string') texts.push(body);
  return texts;
}

// Why connecting to a service failed, as a run's reason. The lab's services answer a refused token with 401
// and {"error":"unauthorized"}, and a token they cannot check with 503 and {"error":"identity_unavailable"}.
// The hand-written agent's MCP client puts that body in its error's message; the one inside Strands keeps it
// in the error's data. Anything else is a service not reached.
export function connectionFailure(error: unknown, sentences: ServiceSentences): string {
  const messages = errorsIn(error).flatMap(textsOf);
  if (messages.some((message) => message.includes('"error":"unauthorized"'))) {
    return sentences.refusedToken;
  }
  if (messages.some((message) => message.includes('"error":"identity_unavailable"'))) {
    return sentences.couldNotCheck;
  }
  return sentences.unreachable;
}

// What a service's answer to a tool call carries: one piece of text, which is JSON. Text that is not JSON is
// returned as it is.
export function payloadOf(result: unknown, sentences: ServiceSentences): unknown {
  const content: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'content') : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined;
  if (typeof text !== 'string') {
    return { error: 'unreadable_result', detail: sentences.notText };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}
