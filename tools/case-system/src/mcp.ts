// The three tools a model can call. Approving or rejecting a case is deliberately not one of them.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { CallContext, CaseFilter, CaseStore, Elements } from './store.ts';

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

function reply(payload: unknown, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

function contextMissing(): CallToolResult {
  return reply(
    {
      error: 'call_context_missing',
      detail:
        'This tool records which inbound message and which agent a change came from. ' +
        'The calling agent\'s code did not send that with the request, so nothing was recorded.',
    },
    true,
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

// Builds the MCP server for one request. The context comes from the request's headers,
// so the model cannot choose which message or agent a change is recorded against.
export function buildMcpServer(store: CaseStore, context: CallContext | undefined): McpServer {
  const server = new McpServer({ name: 'case-system', version: '1' });

  server.registerTool(
    'create_case',
    {
      description:
        'Open an adverse event case from the message being handled. Pass whichever of the four elements ' +
        'the message gives; a case missing any of them is recorded as incomplete. One case is opened per ' +
        'message: calling again for the same message returns the case already opened and creates nothing.',
      inputSchema: elementFields,
    },
    (args) => {
      if (context === undefined) {
        return contextMissing();
      }
      const result = store.createCase(context, elementsFrom(args));
      if (result.outcome === 'conflict') {
        return reply(
          {
            error: 'case_already_opened_for_this_message',
            detail:
              'A case was already opened for this message with different content. Nothing was changed. ' +
              'The case as it stands is returned.',
            case: result.case,
          },
          true,
        );
      }
      return reply(result, false);
    },
  );

  server.registerTool(
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
    (args) => {
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
        return reply({ error: 'filter_required', detail: 'Give at least one filter.' }, true);
      }
      // Set by code, not by the model: only cases this message's sender has reported on.
      filter.sender = context.sender;
      return reply(store.find(filter), false);
    },
  );

  server.registerTool(
    'add_follow_up',
    {
      description:
        'Add information to an existing case, for example when a later message supplies something that was ' +
        'missing. The earlier content stays on record as a previous version. The case then goes back to a ' +
        'reviewer. Only a case the sender of this message has already reported on can be added to. This ' +
        'cannot approve, reject or close a case.',
      inputSchema: {
        case_id: z.string().describe('The case to add to, such as AE-000012.'),
        ...elementFields,
        note: z.string().optional().describe('Anything else worth recording that is not one of the four elements.'),
      },
    },
    (args) => {
      if (context === undefined) {
        return contextMissing();
      }
      const result = store.addFollowUp(context, args.case_id, elementsFrom(args), args.note);
      switch (result.outcome) {
        case 'recorded':
        case 'replayed':
          return reply(result, false);
        case 'conflict':
          return reply(
            {
              error: 'follow_up_already_recorded_for_this_message',
              detail: 'A different follow-up was already recorded on this case for this message. Nothing was changed.',
              case: result.case,
            },
            true,
          );
        case 'not_found':
          return reply({ error: 'case_not_found', detail: `There is no case ${args.case_id}.` }, true);
        case 'nothing_to_add':
          return reply({ error: 'nothing_to_add', detail: 'Give at least one element or a note.' }, true);
      }
    },
  );

  return server;
}
