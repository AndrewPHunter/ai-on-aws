// The contract between whatever sends an inquiry (the client, the evaluation harness) and an agent.
// An agent serves it at POST /invocations, and answers GET /ping with { "status": "Healthy" }.
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
export const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('model'),
    ...timing,
    model: z.string(),
    finish_reason: z.string(),
    text: z.string().nullable(),
    tool_calls: z.array(z.object({ name: z.string(), arguments: z.unknown() })),
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
  }),
  z.object({
    kind: z.literal('tool'),
    ...timing,
    tool: z.string(),
    arguments: z.unknown(),
    result: z.unknown(),
    is_error: z.boolean(),
  }),
  z.object({
    kind: z.literal('retrieval'),
    ...timing,
    query: z.string(),
    strategy: z.string(),
    hits: z.array(z.object({ drug: z.string(), section: z.string(), score: z.number(), excerpt: z.string() })),
  }),
  z.object({
    kind: z.literal('handoff'),
    ...timing,
    to_agent: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('error'),
    ...timing,
    message: z.string(),
  }),
]);

// A passage of an approved label that the reply relies on.
export const citationSchema = z.object({
  drug: z.string(),
  section: z.string(),
  quote: z.string(),
});

// Something the agent did to a case while handling the message.
export const caseActionSchema = z.object({
  kind: z.enum(['case_opened', 'case_already_open', 'follow_up_recorded']),
  case_id: z.string(),
  status: z.string(),
});

export const invocationResponseSchema = z.object({
  agent: z.object({ id: z.string(), implementation: z.string() }),
  // completed: the agent finished. stopped: it gave up at a limit, such as a turn limit. failed: it could not run.
  outcome: z.enum(['completed', 'stopped', 'failed']),
  stop_reason: z.string().nullable(),
  reply: z.string(),
  citations: z.array(citationSchema),
  case_actions: z.array(caseActionSchema),
  steps: z.array(stepSchema),
});

export type InboundMessage = z.infer<typeof inboundMessageSchema>;
export type InvocationRequest = z.infer<typeof invocationRequestSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type CaseAction = z.infer<typeof caseActionSchema>;
export type InvocationResponse = z.infer<typeof invocationResponseSchema>;
