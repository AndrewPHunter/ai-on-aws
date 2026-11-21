// What both implementations need to know about the model server before either asks it anything:
// which model it serves, and the settings every request to it carries.

import { z } from 'zod';

export type ModelSettings = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  seed: number;
};

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

// Why a call to the model failed, as a sentence for a person. Both implementations use these, and
// none carries the server's address or the key.
export const MODEL_UNREACHABLE = 'The model could not be reached.';

export function modelDidNotAnswerWithin(timeoutMs: number): string {
  return `The model did not answer within ${Math.round(timeoutMs / 1000)} s.`;
}

export function modelAnsweredWithStatus(status: number): string {
  return `The model answered with status ${status}.`;
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
