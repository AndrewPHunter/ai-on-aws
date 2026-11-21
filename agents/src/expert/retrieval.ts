// What is particular to the retrieval service, for the label expert: the sentences that say why a run could not
// use it, and how its answers are read. Its answers are read as a closed list: a success of the expected shape,
// or one of the two errors that are the model's own mistakes (told to the model). Every other answer, including
// an error code this agent has never seen and an error that is not of the expected shape, ends the run. A search
// that could not be made must never be read as a search that found nothing.

import { z } from 'zod';

import { connectionFailure as readConnectionFailure, payloadOf as readPayload, serviceSentences } from '../tools/mcp-answers.ts';

// Read with the shared reader in ../tools/mcp-answers.ts, in the retrieval service's name.
const SENTENCES = serviceSentences('retrieval service');

export const RETRIEVAL_UNREACHABLE = SENTENCES.unreachable;
export const RETRIEVAL_REFUSED_TOKEN = SENTENCES.refusedToken;
export const RETRIEVAL_COULD_NOT_CHECK = SENTENCES.couldNotCheck;
export const RETRIEVAL_LACKS_TOOLS = 'The retrieval service does not offer the find_labels and search_label tools.';

// Why connecting to the retrieval service failed, as a run's reason.
export function connectionFailure(error: unknown): string {
  return readConnectionFailure(error, SENTENCES);
}

// What the retrieval service's answer to a tool call carries: one piece of text, which is JSON.
export function payloadOf(result: unknown): unknown {
  return readPayload(result, SENTENCES);
}

export function retrievalDidNotAnswerWithin(timeoutMs: number): string {
  return `The retrieval service did not answer within ${Math.round(timeoutMs / 100) / 10} s, or the connection failed.`;
}

// The two errors that are the model's own mistakes. Told to the model; the run goes on.
export const TOLD_TO_MODEL = ['label_not_found', 'invalid_input'] as const;

// The errors the brief names that end the run, each with its own sentence.
export const SEARCH_FAILURES: Readonly<Record<string, string>> = {
  index_not_built: 'The label index has not been built, so no label could be searched.',
  search_timed_out: 'The search engine behind the retrieval service did not answer in time.',
  search_unreachable: 'The search engine behind the retrieval service could not be reached.',
  search_error: 'The search engine behind the retrieval service answered with an error.',
  search_unexpected_answer: 'The search engine behind the retrieval service answered in a form the service does not expect.',
};

export const UNREADABLE_ERROR = 'The label search answered with an error this agent could not read.';

export function unknownError(code: string): string {
  return `The label search answered with an error this agent does not know: ${code.slice(0, 100)}.`;
}

export function unexpectedAnswer(tool: string): string {
  return `The retrieval service answered ${tool} in a form this agent does not expect.`;
}

const errorSchema = z.object({ error: z.string(), detail: z.string() });

// The parts of an answer that reach a citation must keep to the contract, or the answer is not read.
const labelFoundSchema = z.object({
  set_id: z.string(),
  version: z.number().int().min(1),
  effective_date: z.string().regex(/^\d{8}$/),
  kind: z.string(),
  names: z.array(z.string()),
  source: z.string(),
});

export const findLabelsSchema = z.object({ labels: z.array(labelFoundSchema), more_matched: z.boolean() });

const passageSchema = z.object({
  chunk_id: z.string(),
  text: z.string(),
  score: z.number(),
  part: z.string(),
  type: z.string(),
  section: z.object({ number: z.string().nullable(), title: z.string().nullable(), path: z.array(z.string()) }),
  label: z.object({
    set_id: z.string(),
    version: z.number().int().min(1),
    effective_date: z.string().regex(/^\d{8}$/),
    source: z.string().startsWith('https://'),
  }),
});

export const searchLabelSchema = z.object({ set_id: z.string(), passages: z.array(passageSchema) });

export type LabelFound = z.infer<typeof labelFoundSchema>;
export type FoundLabels = z.infer<typeof findLabelsSchema>;
export type Passage = z.infer<typeof passageSchema>;
export type SearchAnswer = z.infer<typeof searchLabelSchema>;

// How one answer of the service is read.
//   ok:    a success of the expected shape.
//   told:  label_not_found or invalid_input, told to the model.
//   fails: anything else; the run ends with this reason.
export type Reading<T> = { kind: 'ok'; value: T } | { kind: 'told'; error: { error: string; detail: string } } | { kind: 'fails'; reason: string };

export function readAnswer<T>(tool: string, isError: boolean, payload: unknown, success: z.ZodType<T>): Reading<T> {
  if (!isError) {
    const parsed = success.safeParse(payload);
    return parsed.success ? { kind: 'ok', value: parsed.data } : { kind: 'fails', reason: unexpectedAnswer(tool) };
  }
  const error = errorSchema.safeParse(payload);
  if (!error.success) return { kind: 'fails', reason: UNREADABLE_ERROR };
  const code = error.data.error;
  if (TOLD_TO_MODEL.some((told) => told === code)) return { kind: 'told', error: error.data };
  const named = Object.hasOwn(SEARCH_FAILURES, code) ? SEARCH_FAILURES[code] : undefined;
  return { kind: 'fails', reason: named ?? unknownError(code) };
}

// How a passage's section is named in a citation and to the model: its path, or its title, or "Untitled section",
// with "Highlights" in front when it is from the Highlights.
export function sectionName(passage: Passage): string {
  const { path, title } = passage.section;
  const named = path.length > 0 ? path.join(' > ') : title !== null && title.trim() !== '' ? title : 'Untitled section';
  return passage.part === 'highlights' ? `Highlights > ${named}` : named;
}
