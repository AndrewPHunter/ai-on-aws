// The knowledge gate's calls to the retrieval service. A call that throws (the service down, a refused token, the
// network) is "could not run": it is never turned into a result a statement could read as the service's own
// answer. A refusal counts only when it is the service's own invalid_input result.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { CouldNotRun } from './data.ts';

export type Reply = { isError: boolean; payload: Record<string, unknown> };

export type ToolCaller = Pick<Client, 'callTool'>;

// Calls one tool. Adds the call's time in milliseconds to `timings` when given.
export async function call(client: ToolCaller, name: string, args: Record<string, unknown>, timings?: number[]): Promise<Reply> {
  const started = process.hrtime.bigint();
  let result: Awaited<ReturnType<Client['callTool']>>;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    throw new CouldNotRun(`${name} could not be called (${error instanceof Error ? error.name : 'unknown error'}): is the retrieval service answering?`);
  }
  timings?.push(Number(process.hrtime.bigint() - started) / 1e6);
  const content: unknown = result.content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined;
  let payload: Record<string, unknown> = { unparsed: true };
  if (typeof text === 'string') {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) payload = value as Record<string, unknown>;
    } catch {
      payload = { unparsed: true };
    }
  }
  return { isError: result.isError === true, payload };
}

// The error code of a reply that is an error, as the gate reports it; a payload with no code is "unreadable".
export function errorCode(reply: Reply): string {
  const code = reply.payload.error;
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : 'unreadable';
}

// What failed among counted calls: each error code with its count and the first call it happened on, by position
// (from 1), never by the question's text. Empty when nothing failed.
export function errorSummary(errors: readonly { position: number; code: string }[]): string {
  const byCode = new Map<string, { count: number; first: number }>();
  for (const { position, code } of errors) {
    const known = byCode.get(code);
    if (known === undefined) byCode.set(code, { count: 1, first: position });
    else known.count++;
  }
  return [...byCode]
    .sort(([a, x], [b, y]) => x.first - y.first || (a < b ? -1 : 1))
    .map(([code, { count, first }]) => `${code}: ${count} (first at search ${first})`)
    .join('; ');
}

// Whether a reply is the service's own refusal of the input.
export function refusedByService(reply: Reply): boolean {
  return reply.isError && reply.payload.error === 'invalid_input';
}
