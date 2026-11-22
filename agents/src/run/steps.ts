// Recording the steps of a run that every agent records the same way: a tool call, a call asked for and not
// made, a refusal, an error. And what the model is told about a call.

import type { ToolOutcome } from '../tools/tool-set.ts';
import type { RunState } from './state.ts';

// A call the agent's code will not make, and what the model is told instead.
export type Refusal = { error: string; detail: string };

export function toldAbout(outcome: ToolOutcome): string {
  return JSON.stringify(outcome.kind === 'answered' ? outcome.payload : { error: 'no_answer', detail: outcome.reason });
}

export function recordToolCall(
  run: RunState,
  call: {
    tool: string;
    requestedBy: 'model' | 'agent';
    args: unknown;
    outcome: ToolOutcome;
    startedAt: string;
    durationMs: number;
  },
): void {
  const { outcome } = call;
  run.steps.push({
    kind: 'tool',
    started_at: call.startedAt,
    duration_ms: call.durationMs,
    tool: call.tool,
    requested_by: call.requestedBy,
    arguments: call.args,
    result: outcome.kind === 'answered' ? outcome.payload : { error: 'no_answer', detail: outcome.reason },
    is_error: outcome.kind === 'no_answer' || outcome.isError,
  });
}

// A call that was asked for and not made, with what the model was told instead.
export function recordNotCalled(run: RunState, tool: string, args: unknown, told: unknown): void {
  run.steps.push({
    kind: 'tool',
    started_at: run.now().toISOString(),
    duration_ms: 0,
    tool,
    requested_by: 'model',
    arguments: args,
    result: told,
    is_error: true,
  });
}

// Records a refusal and returns it as the text the model is told.
export function recordRefusal(run: RunState, tool: string, args: unknown, refusal: Refusal): string {
  recordNotCalled(run, tool, args, refusal);
  return JSON.stringify(refusal);
}

export function recordError(run: RunState, message: string, startedAt?: string, durationMs = 0): void {
  run.steps.push({ kind: 'error', started_at: startedAt ?? run.now().toISOString(), duration_ms: durationMs, message });
}
