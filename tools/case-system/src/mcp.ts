// The three tools a model can call, each offered only to a caller holding its scope. Approving or rejecting
// a case is deliberately not one of them. Each call a handler takes is one case.tool span, and each store write
// inside it one case.commit span (README.md, "Telemetry"). Spans carry identifiers and outcomes, never what a
// case or a request holds.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MAX_ATTRIBUTE_TEXT } from '../../../shared/telemetry-attributes.ts';
import type { Outcome, Telemetry, TraceParent } from '../../../shared/telemetry.ts';
import { offersTool } from './scopes.ts';
import type { CallContext, CaseFilter, CaseStore, CaseView, Elements } from './store.ts';

export const TOOL_NAMES = ['create_case', 'find_case', 'add_follow_up'] as const;

const elementFields = {
  patient: z
    .string()
    .optional()
    .describe('What identifies the patient, as given in the message: for example initials, age, sex. Omit if not given.'),
  reporter: z
    .string()
    .optional()
    .describe('Who reported the event and how to reach them: name, role, contact. Omit if not given.'),
  suspect_drug: z.string().optional().describe('The drug suspected of causing the event. Omit if not given.'),
  event: z.string().optional().describe('The adverse event, in the reporter\'s words. Omit if not given.'),
};

// What a tool that changes a case answers with: which case, where it stands, and what it still lacks.
// Never what the case holds, so a caller who may only write reads nothing back through the write.
export type Receipt = Pick<CaseView, 'case_id' | 'status' | 'version' | 'missing'>;

export function receiptOf(view: CaseView): Receipt {
  return { case_id: view.case_id, status: view.status, version: view.version, missing: view.missing };
}

// What the tool spans of one request need: the handle, the parent read from the request's traceparent (null: a new
// trace), and the client the access token was issued to.
export type ToolTrace = { telemetry: Telemetry; parent: TraceParent | null; agentId: string };

// A tool's answer, and how its call ended: executed, or refused with the case unchanged.
type Answer = { outcome: 'executed' | 'refused'; result: CallToolResult };

// The commit outcome for each store result that is a write committed or declined. A follow-up recorded is a
// version created. A result not listed (no such case, nothing to add) wrote nothing and has no commit outcome.
const COMMIT_OUTCOMES: Readonly<Record<string, Outcome>> = { created: 'created', recorded: 'created', replayed: 'replayed', conflict: 'conflict' };

// An identifier for a span, or undefined when it is too long for one: left off rather than refusing the call.
function identifier(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= MAX_ATTRIBUTE_TEXT ? value : undefined;
}

// Runs one tool call as a case.tool span: a child of the request's traceparent, ended with the call's outcome.
async function traced(trace: ToolTrace, tool: string, context: CallContext | undefined, handle: () => Answer | Promise<Answer>): Promise<CallToolResult> {
  const attributes = { 'gen_ai.tool.name': tool, 'gen_ai.agent.id': identifier(trace.agentId), 'lab.inquiry.id': identifier(context?.messageId) };
  return trace.telemetry.span('case.tool', { kind: 'server', parent: trace.parent, attributes }, async (span) => {
    const answer = await handle();
    span.set({ 'lab.outcome': answer.outcome });
    return answer.result;
  });
}

// Runs one store write as a case.commit span, a child of the tool's span. The store's call is one transaction, so
// the span ends when the transaction does, before the tool answers.
function committed<Result extends { outcome: string }>(trace: ToolTrace, context: CallContext, write: () => Result): Promise<Result> {
  return trace.telemetry.span('case.commit', { kind: 'internal', attributes: { 'lab.inquiry.id': identifier(context.messageId) } }, (span) => {
    const result = write();
    const outcome = Object.hasOwn(COMMIT_OUTCOMES, result.outcome) ? COMMIT_OUTCOMES[result.outcome] : undefined;
    if (outcome !== undefined) span.set({ 'lab.outcome': outcome });
    return result;
  });
}

function reply(payload: unknown, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

const executed = (payload: unknown): Answer => ({ outcome: 'executed', result: reply(payload, false) });
const refused = (payload: unknown): Answer => ({ outcome: 'refused', result: reply(payload, true) });

function contextMissing(): Answer {
  return refused(
    {
      error: 'call_context_missing',
      detail:
        'This tool records which inbound message a change came from. ' +
        'The calling agent\'s code did not send that with the request, so nothing was recorded.',
    },
  );
}

function elementsFrom(args: Elements): Elements {
  const elements: Elements = {};
  if (args.patient !== undefined) {
    elements.patient = args.patient;
  }
  if (args.reporter !== undefined) {
    elements.reporter = args.reporter;
  }
  if (args.suspect_drug !== undefined) {
    elements.suspect_drug = args.suspect_drug;
  }
  if (args.event !== undefined) {
    elements.event = args.event;
  }
  return elements;
}

// Builds the MCP server for one request, with only the tools the caller's scopes reach. The context comes
// from the request's headers and its access token, so the model cannot choose which message or agent a
// change is recorded against. The trace says where the request's spans go.
export function buildMcpServer(store: CaseStore, context: CallContext | undefined, scopes: readonly string[], trace: ToolTrace): McpServer {
  const server = new McpServer({ name: 'case-system', version: '1' });

  if (offersTool('create_case', scopes)) server.registerTool(
    'create_case',
    {
      description:
        'Open an adverse event case from the message being handled. Pass whichever of the four elements ' +
        'the message gives; a case missing any of them is recorded as incomplete. One case is opened per ' +
        'message: calling again for the same message answers for the case already opened and creates nothing. ' +
        'The answer is a receipt: the case\'s id, its status, its version and the elements it still lacks.',
      inputSchema: elementFields,
    },
    (args) => traced(trace, 'create_case', context, async () => {
      if (context === undefined) {
        return contextMissing();
      }
      const result = await committed(trace, context, () => store.createCase(context, elementsFrom(args)));
      if (result.outcome === 'conflict') {
        return refused(
          {
            error: 'case_already_opened_for_this_message',
            detail:
              'A case was already opened for this message with different content. Nothing was changed. ' +
              'The case\'s id, status, version and the elements it still lacks are returned.',
            case: receiptOf(result.case),
          },
        );
      }
      return executed({ outcome: result.outcome, case: receiptOf(result.case) });
    }),
  );

  if (offersTool('find_case', scopes)) server.registerTool(
    'find_case',
    {
      description:
        'Look up existing cases that the sender of this message has reported on. Cases from other senders ' +
        'are never returned. Use from_this_message to check whether a case was already opened for the ' +
        'message being handled, for example after a create_case call that did not return. Use suspect_drug ' +
        'and patient to find an earlier case that a new message may be a follow-up to. At least one filter is ' +
        'required. Newest cases come first; truncated is true when more matched than are listed.',
      inputSchema: {
        case_id: z.string().optional().describe('An exact case identifier, such as AE-000012.'),
        suspect_drug: z.string().optional().describe('Part of the drug name. Case is ignored.'),
        patient: z.string().optional().describe('Part of the patient description. Case is ignored.'),
        from_this_message: z
          .boolean()
          .optional()
          .describe('True to return only cases opened or updated from the message being handled.'),
      },
    },
    (args) => traced(trace, 'find_case', context, () => {
      // A lookup is always on behalf of a sender, so it needs the call context.
      if (context === undefined) {
        return contextMissing();
      }
      const filter: CaseFilter = {};
      if (args.case_id !== undefined) {
        filter.caseId = args.case_id;
      }
      if (args.suspect_drug !== undefined) {
        filter.suspectDrug = args.suspect_drug;
      }
      if (args.patient !== undefined) {
        filter.patient = args.patient;
      }
      if (args.from_this_message === true) {
        filter.messageId = context.messageId;
      }
      if (Object.keys(filter).length === 0) {
        return refused({ error: 'filter_required', detail: 'Give at least one filter.' });
      }
      // Set by code, not by the model: only cases this message's sender has reported on.
      filter.sender = context.sender;
      return executed(store.find(filter));
    }),
  );

  if (offersTool('add_follow_up', scopes)) server.registerTool(
    'add_follow_up',
    {
      description:
        'Add information to an existing case, for example when a later message supplies something that was ' +
        'missing. The earlier content stays on record as a previous version. The case then goes back to a ' +
        'reviewer. Only a case the sender of this message has already reported on can be added to. This ' +
        'cannot approve, reject or close a case. The answer is a receipt: the case\'s id, its status, its ' +
        'version and the elements it still lacks.',
      inputSchema: {
        case_id: z.string().describe('The case to add to, such as AE-000012.'),
        ...elementFields,
        note: z.string().optional().describe('Anything else worth recording that is not one of the four elements.'),
      },
    },
    (args) => traced(trace, 'add_follow_up', context, async () => {
      if (context === undefined) {
        return contextMissing();
      }
      const result = await committed(trace, context, () => store.addFollowUp(context, args.case_id, elementsFrom(args), args.note));
      switch (result.outcome) {
        case 'recorded':
        case 'replayed':
          return executed({ outcome: result.outcome, case: receiptOf(result.case) });
        case 'conflict':
          return refused(
            {
              error: 'follow_up_already_recorded_for_this_message',
              detail:
                'A different follow-up was already recorded on this case for this message. Nothing was changed. ' +
                'The case\'s id, status, version and the elements it still lacks are returned.',
              case: receiptOf(result.case),
            },
          );
        case 'not_found':
          return refused({ error: 'case_not_found', detail: `There is no case ${args.case_id}.` });
        case 'nothing_to_add':
          return refused({ error: 'nothing_to_add', detail: 'Give at least one element or a note.' });
      }
    }),
  );

  return server;
}
