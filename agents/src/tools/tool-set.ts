// What any set of tools looks like to an agent's loop, whichever system the tools belong to:
// descriptions to show the model, a way to make a call, and what can come back.

import type { ToolDefinition } from '../model/chat.ts';

// What came back from a tool call.
//   answered:  the tool's system replied. isError is its own verdict (a refusal is still an answer).
//   no_answer: nothing came back in time, or the connection failed. For a call that changes
//              something, this means the outcome is unknown: the change may have happened.
export type ToolOutcome =
  | { kind: 'answered'; isError: boolean; payload: unknown }
  | { kind: 'no_answer'; reason: string };

export type ToolSet = {
  // What the model is shown: each tool's name, purpose and the shape of its arguments.
  definitions: ToolDefinition[];
  // Makes the call. Only the agent's code does this; the model can only ask for it.
  call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolOutcome>;
  close(): Promise<void>;
};

export type Connected = { ok: true; tools: ToolSet } | { ok: false; reason: string };
