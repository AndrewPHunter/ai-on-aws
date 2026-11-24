// The spans of the calls a run makes, as the hand-written intake agent exports them: model.call for each request
// sent to the model, tool.call for each tool call made or refused. Each span covers exactly one call and ends when
// the call ends, so it is exported whatever the run does next. The run's own span, agent.run, is made by the front
// door (../contract/server.ts), and these are its children through the handle's current span.
//
// Metadata only: the model's name, how the call ended, token counts, the tool's name, who asked, which operation and
// which attempt. Never a message, an argument, a result or a reply. A value from outside the code (the model
// server's finish reason and counts, a message's id) that the telemetry module would refuse is left out here, so a
// span never stops the call it records.

import { MAX_ATTRIBUTE_TEXT } from '../../../shared/telemetry-attributes.ts';
import type { Outcome, Requester, SpanAttributes, Telemetry } from '../../../shared/telemetry.ts';
import type { ChatResult } from '../model/chat.ts';
import type { ToolOutcome } from '../tools/tool-set.ts';

// The text, or undefined (left out) when it is not 1 to 256 characters.
export function attributeText(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && value.length > 0 && value.length <= MAX_ATTRIBUTE_TEXT ? value : undefined;
}

// The count, or null (unknown, left out) when it is not a whole number of 0 or more.
function tokenCount(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// One intended operation and which try at it this is. The operation stays the same when it is tried again.
export type Attempt = { operation: string; attempt: number };

export const turnOperation = (turn: number): string => `model:turn-${turn}`;
export const REPORT_CHECK_OPERATION = 'model:report-check';
// The `index`-th (from 1) tool call the model asked for in turn `turn`.
export const toolOperation = (turn: number, index: number): string => `tool:turn-${turn}:${index}`;

function modelOutcome(result: ChatResult): Outcome {
  if (result.ok) return 'executed';
  return result.lost ? 'response_lost' : 'failed';
}

// Sends one request to the model inside its own model.call span. A send that throws ends the span failed and is
// thrown again.
export function modelCallSpan(telemetry: Telemetry, model: string, at: Attempt, send: () => Promise<ChatResult>): Promise<ChatResult> {
  return telemetry.span(
    'model.call',
    { kind: 'client', attributes: { 'gen_ai.request.model': attributeText(model), 'lab.operation.id': at.operation, 'lab.attempt': at.attempt } },
    async (span) => {
      const result = await send();
      span.set(
        result.ok
          ? {
              'lab.outcome': 'executed',
              'lab.finish_reason': attributeText(result.completion.finishReason),
              'gen_ai.usage.input_tokens': tokenCount(result.completion.inputTokens),
              'gen_ai.usage.output_tokens': tokenCount(result.completion.outputTokens),
            }
          : { 'lab.outcome': modelOutcome(result) },
      );
      return result;
    },
  );
}

// A call the tool's system answered with a refusal did nothing, as one the agent's rules refused.
function toolOutcome(outcome: ToolOutcome): Outcome {
  if (outcome.kind === 'no_answer') return 'response_lost';
  return outcome.isError ? 'refused' : 'executed';
}

// `tool` is the tool's name when it is one the model was shown, and undefined for a name the model made up, which is
// model output and is not recorded.
export type ToolCallSpan = Attempt & { tool: string | undefined; requestedBy: Requester };

function toolAttributes(call: ToolCallSpan): SpanAttributes {
  return { 'gen_ai.tool.name': call.tool, 'lab.requested_by': call.requestedBy, 'lab.operation.id': call.operation, 'lab.attempt': call.attempt };
}

// Makes one tool call inside its own tool.call span. A request the call sends to the tool's system carries this
// span as its traceparent (connectCaseTools in ../tools/case-system.ts).
export function toolCallSpan(telemetry: Telemetry, call: ToolCallSpan, make: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  return telemetry.span('tool.call', { kind: 'client', attributes: toolAttributes(call) }, async (span) => {
    const outcome = await make();
    span.set({ 'lab.outcome': toolOutcome(outcome) });
    return outcome;
  });
}

// A tool call the agent's rules refuse before anything is sent: a tool.call span with outcome refused around
// recording the refusal.
export function refusedToolCallSpan<T>(telemetry: Telemetry, call: ToolCallSpan, record: () => T): Promise<T> {
  return telemetry.span('tool.call', { kind: 'client', attributes: { ...toolAttributes(call), 'lab.outcome': 'refused' } }, record);
}
