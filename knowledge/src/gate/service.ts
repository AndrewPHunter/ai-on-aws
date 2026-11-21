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

// Whether a reply is the service's own refusal of the input.
export function refusedByService(reply: Reply): boolean {
  return reply.isError && reply.payload.error === 'invalid_input';
}
