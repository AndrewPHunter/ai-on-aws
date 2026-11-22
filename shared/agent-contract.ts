// The contract between whatever sends an inquiry (the client, the evaluation harness) and an agent.
// An agent serves it at POST /invocations, and answers GET /ping with a body whose status is "Healthy"; an agent on
// AWS's SDK server adds time_of_last_update (docs/architecture/agent-runtime.md).
// The schemas are the contract: senders validate what an agent returns against them.

import { z } from 'zod';

// One inbound message. The identifier and receipt time are fixed when the message is first received,
// before any agent sees it, and stay the same however many times it is sent to an agent.
export const inboundMessageSchema = z.object({
  id: z.string().min(1),
  received_at: z.iso.datetime(),
  sender: z.string().min(1),
  text: z.string().min(1),
});

export const invocationRequestSchema = z.object({ message: inboundMessageSchema });

const timing = {
  started_at: z.iso.datetime(),
  duration_ms: z.number().nonnegative(),
};

// What an agent did, in order. Each kind carries what a reader needs to judge that step.
const modelStepSchema = z.object({
  kind: z.literal('model'),
  ...timing,
  model: z.string(),
  finish_reason: z.string(),
  text: z.string().nullable(),
  tool_calls: z.array(z.object({ name: z.string(), arguments: z.unknown() })),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
});

const toolStepSchema = z.object({
  kind: z.literal('tool'),
  ...timing,
  tool: z.string(),
  // Who decided to make the call: the model, or the agent's own code (for example repeating a call
  // whose reply was lost).
  requested_by: z.enum(['model', 'agent']),
  arguments: z.unknown(),
  result: z.unknown(),
  is_error: z.boolean(),
});

const retrievalStepSchema = z.object({
  kind: z.literal('retrieval'),
  ...timing,
  query: z.string(),
  strategy: z.string(),
  hits: z.array(
    z.object({
      drug: z.string(),
      section: z.string(),
      score: z.number(),
      excerpt: z.string(),
      // The passage's id in the index.
      passage: z.string(),
      // The short name the model was shown for this passage, such as P3, which its reply cites.
      handle: z.string(),
      // False when the passage matched but was not given to the model.
      shown: z.boolean(),
    }),
  ),
});

const errorStepSchema = z.object({
  kind: z.literal('error'),
  ...timing,
  message: z.string(),
});

// The steps of an agent that calls no other agent. A delegated response holds only these, so the schema
// never refers to itself.
export const subAgentStepSchema = z.discriminatedUnion('kind', [
  modelStepSchema,
  toolStepSchema,
  retrievalStepSchema,
  errorStepSchema,
]);

// A passage of an approved label that the reply relies on, with what a reviewer needs to check it: which
// label, which version of it, and where that version can be read.
export const citationSchema = z.object({
  // The label's names.
  drug: z.string(),
  section: z.string(),
  quote: z.string(),
  set_id: z.string(),
  version: z.number().int().min(1),
  // As the label carries it: YYYYMMDD.
  effective_date: z.string().regex(/^\d{8}$/),
  // The label's page.
  source: z.string().startsWith('https://'),
  // The passage's id in the index.
  passage: z.string(),
});

// Whether a question about a drug label was answered, and if not, why.
export const LABEL_ANSWERS = ['answered', 'no_label', 'label_does_not_answer', 'not_a_label_question'] as const;
export const labelAnswerSchema = z.enum(LABEL_ANSWERS);

// Something the agent did to a case while handling the message.
export const caseActionSchema = z.object({
  kind: z.enum(['case_opened', 'case_already_open', 'follow_up_recorded']),
  case_id: z.string(),
  status: z.string(),
});

// A response of the contract, over the step kinds given.
function responseSchemaOver<S extends z.ZodType>(step: S) {
  return z.object({
    agent: z.object({ id: z.string(), implementation: z.string() }),
    // completed: the agent finished. stopped: it gave up at a limit, such as a turn limit. failed: it could not run.
    outcome: z.enum(['completed', 'stopped', 'failed']),
    stop_reason: z.string().nullable(),
    reply: z.string(),
    citations: z.array(citationSchema),
    // Set on every completed run by an agent that answers from drug labels; absent from every other agent and
    // from a run that did not complete. Optional, and not nullable, because responses stored before it existed
    // must still parse.
    label_answer: labelAnswerSchema.optional(),
    case_actions: z.array(caseActionSchema),
    steps: z.array(step),
  });
}

// The whole response of an agent that another agent called. Its steps hold no delegation.
export const delegatedResponseSchema = responseSchemaOver(subAgentStepSchema);

// One call to another agent, with what was sent and the whole response, or why there is none.
export const delegationStepSchema = z.object({
  kind: z.literal('delegation'),
  ...timing,
  // Names this call within the run, such as screening or q1.
  id: z.string(),
  // The id of the agent called.
  to_agent: z.string(),
  // Who decided to make the call: the agent's own code, or the model.
  requested_by: z.enum(['agent', 'model']),
  message: z.object({ id: z.string(), text: z.string() }),
  // The id of an earlier call in the run that this one replaces, or null.
  replaces: z.string().nullable(),
  // Why there is no response, or null.
  failure: z.string().nullable(),
  response: delegatedResponseSchema.nullable(),
});

export const stepSchema = z.discriminatedUnion('kind', [
  modelStepSchema,
  toolStepSchema,
  retrievalStepSchema,
  errorStepSchema,
  delegationStepSchema,
]);

export const invocationResponseSchema = responseSchemaOver(stepSchema);

export type InboundMessage = z.infer<typeof inboundMessageSchema>;
export type InvocationRequest = z.infer<typeof invocationRequestSchema>;
export type Step = z.infer<typeof stepSchema>;
export type SubAgentStep = z.infer<typeof subAgentStepSchema>;
export type DelegationStep = z.infer<typeof delegationStepSchema>;
export type DelegatedResponse = z.infer<typeof delegatedResponseSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type LabelAnswer = z.infer<typeof labelAnswerSchema>;
export type CaseAction = z.infer<typeof caseActionSchema>;
export type InvocationResponse = z.infer<typeof invocationResponseSchema>;
