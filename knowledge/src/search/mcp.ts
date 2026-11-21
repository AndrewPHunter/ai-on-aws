// The two tools an agent is given: find a drug's label, then search inside that one label. The input schemas
// tell a model the types; the tool functions check every input again themselves before anything is sent.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { Engine } from './engine.ts';
import { DEFAULT_RESULTS, MAX_RESULTS, findLabels, searchLabel } from './tools.ts';
import type { Outcome } from './tools.ts';

export const TOOL_NAMES = ['find_labels', 'search_label'] as const;

function reply<T>(outcome: Outcome<T>): CallToolResult {
  const payload = outcome.ok ? outcome.value : outcome.error;
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !outcome.ok };
}

export function buildMcpServer(engine: Engine, index: string): McpServer {
  const server = new McpServer({ name: 'knowledge', version: '1' });

  server.registerTool(
    'find_labels',
    {
      description:
        "Find the drug labels for a drug, by its name as a person would write it: a product name, a generic name or an " +
        'active ingredient. Exact names are matched first, ignoring case; if none match, labels whose names contain ' +
        'every word given. Returns at most 10 labels, newest first, with each one\'s set id for search_label, and says ' +
        'whether more matched. An empty list means no label in the index has that name.',
      inputSchema: { drug: z.string().describe("The drug's name.") },
    },
    async (args) => reply(await findLabels(engine, index, { drug: args.drug })),
  );

  server.registerTool(
    'search_label',
    {
      description:
        'Search the text of one drug label for passages about a question, best first. Give the set id from ' +
        'find_labels and the words to look for. Each passage carries its text, a score, the section it comes from ' +
        "(number, title and path) and the label's version, date and page at DailyMed, for citing. A set id that is not " +
        'in the index is an error, not an empty answer.',
      inputSchema: {
        set_id: z.string().describe("The label's set id, from find_labels."),
        query: z.string().describe('The words to search for, as plain words.'),
        part: z.enum(['body', 'highlights']).optional().describe('"body" for the full text, "highlights" for the Highlights summary; leave out for both.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .optional()
          .describe(`How many passages, from 1 to ${MAX_RESULTS}. Default ${DEFAULT_RESULTS}.`),
      },
    },
    async (args) => reply(await searchLabel(engine, index, args)),
  );

  return server;
}
