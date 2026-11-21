// A client for the model server's chat API (the OpenAI-compatible one that vLLM serves), with tool
// calling. Written with fetch and nothing else, so every field sent and read is visible here.

import { z } from 'zod';

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
export type ChatResult = { ok: true; completion: Completion } | { ok: false; reason: string };

// `thinking` asks the model to reason before it answers, where the model has such a mode.
// Reasoning counts against the output allowance, so a turn can spend all of it and answer nothing.
export type ChatOptions = { timeoutMs: number; thinking: boolean };

export type ChatModel = {
  id: string;
  complete(messages: ChatMessage[], tools: ToolDefinition[], options: ChatOptions): Promise<ChatResult>;
};

export type ModelSettings = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  seed: number;
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

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export function createChatModel(settings: ModelSettings): ChatModel {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` };

  return {
    id: settings.modelId,
    async complete(messages, tools, { timeoutMs, thinking }) {
      let status: number;
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
        return {
          ok: false,
          reason: isTimeout(error)
            ? `The model did not answer within ${seconds(timeoutMs)}.`
            : 'The model could not be reached.',
        };
      }
      if (status !== 200) {
        return { ok: false, reason: `The model answered with status ${status}.` };
      }
      const parsed = completionSchema.safeParse(body);
      const choice = parsed.success ? parsed.data.choices[0] : undefined;
      if (!parsed.success || choice === undefined) {
        return { ok: false, reason: 'The model’s answer was not in the expected form.' };
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

// The model server serves one chat model. Ask it which, so the name is not configured in two places.
export async function servedModelId(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  let body: unknown;
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      return { ok: false, reason: `The model server answered its model list with status ${response.status}.` };
    }
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason: isTimeout(error) ? 'The model server did not answer in time.' : 'The model server could not be reached.',
    };
  }
  const parsed = modelListSchema.safeParse(body);
  const only = parsed.success && parsed.data.data.length === 1 ? parsed.data.data[0] : undefined;
  if (only === undefined) {
    return { ok: false, reason: 'The model server does not serve exactly one model, so the model must be named.' };
  }
  return { ok: true, id: only.id };
}
