// A client for the model server's chat API (the OpenAI-compatible one that vLLM serves), with tool
// calling. Written with fetch and nothing else, so every field sent and read is visible here.

import { z } from 'zod';

import { MODEL_UNREACHABLE, isTimeout, modelAnsweredWithStatus, modelDidNotAnswerWithin } from './served.ts';
import type { ModelSettings } from './served.ts';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

export type Completion = {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

// A failure carries a sentence for a person. It never carries the server's address or the key.
// `retryable` says whether the same request is worth sending again: the connection failed, or the
// server said the fault was momentary or its own (408, 429, 5xx). A request the server rejected,
// or an answer in the wrong form, would be the same again. A request that ran out of time is not
// worth it either: it has already had all the time one request is allowed. This client never
// sends twice itself; that is the caller's to do. `lost` says that no answer came back: the request ran out of
// time or the connection failed, so whether the server worked on it is not known. A status or an answer in the
// wrong form is an answer.
export type ChatResult = { ok: true; completion: Completion } | { ok: false; reason: string; retryable: boolean; lost: boolean };

// `thinking` asks the model to reason before it answers, where the model has such a mode.
// Reasoning counts against the output allowance, so a turn can spend all of it and answer nothing.
export type ChatOptions = { timeoutMs: number; thinking: boolean };

export type ChatModel = {
  id: string;
  complete(messages: ChatMessage[], tools: ToolDefinition[], options: ChatOptions): Promise<ChatResult>;
};

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .nullable()
    .optional(),
});

export function createChatModel(settings: ModelSettings): ChatModel {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` };

  return {
    id: settings.modelId,
    async complete(messages, tools, { timeoutMs, thinking }) {
      let status: number | undefined;
      let body: unknown;
      try {
        const response = await fetch(`${settings.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model: settings.modelId,
            messages,
            tools,
            temperature: settings.temperature,
            max_tokens: settings.maxTokens,
            seed: settings.seed,
            // vLLM passes this to the model's chat template. Qwen reads it; a model without the mode ignores it.
            ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
          }),
        });
        status = response.status;
        body = status === 200 ? await response.json() : null;
      } catch (error) {
        // An answer whose status was read and whose body then failed arrived: it is not lost.
        const lost = status === undefined;
        return {
          ok: false,
          ...(isTimeout(error)
            ? { reason: modelDidNotAnswerWithin(timeoutMs), retryable: false, lost }
            : { reason: MODEL_UNREACHABLE, retryable: true, lost }),
        };
      }
      if (status !== 200) {
        return { ok: false, reason: modelAnsweredWithStatus(status), retryable: status === 408 || status === 429 || status >= 500, lost: false };
      }
      const parsed = completionSchema.safeParse(body);
      const choice = parsed.success ? parsed.data.choices[0] : undefined;
      if (!parsed.success || choice === undefined) {
        return { ok: false, reason: 'The model’s answer was not in the expected form.', retryable: false, lost: false };
      }
      return {
        ok: true,
        completion: {
          content: choice.message.content ?? null,
          toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
            id: call.id,
            type: 'function',
            function: call.function,
          })),
          finishReason: choice.finish_reason ?? 'unknown',
          inputTokens: parsed.data.usage?.prompt_tokens ?? null,
          outputTokens: parsed.data.usage?.completion_tokens ?? null,
        },
      };
    },
  };
}
