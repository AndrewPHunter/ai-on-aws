// What the label expert's tests share: the real retrieval service in-process over the search stand-in from
// knowledge/test/support, real signed tokens from the stand-in issuer, a synthetic label set, and one test double
// of its own (labelled below) for the two answers the real retrieval service cannot be made to give.
// Every label name and passage here is invented.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { createAccessTokenCheck } from '../../shared/access-token.ts';
import type { AccessTokenCheck, Caller } from '../../shared/access-token.ts';
import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse, Step } from '../../shared/agent-contract.ts';
import { createRetrievalServer } from '../../knowledge/src/search/http.ts';
import { testEngine } from '../../knowledge/test/support/retrieval.ts';
import { hits, startSearchStandIn } from '../../knowledge/test/support/search-standin.ts';
import type { SearchReply, SearchRequest, SearchStandIn } from '../../knowledge/test/support/search-standin.ts';
import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { MintOptions, StandInIssuer } from '../../test-support/issuer.ts';
import type { Limits } from '../src/run/limits.ts';
import { EXPERT_SETTINGS } from '../src/expert/settings.ts';
import type { ExpertSettings } from '../src/expert/settings.ts';
import { handleQuestion } from '../src/expert/strands.ts';
import { AGENT_START, agentClock, deadUrl, listen, prop, stop } from './helpers.ts';
import type { AgentClock, ScriptedModel } from './helpers.ts';

// --- Tokens ----------------------------------------------------------------------------------------------
// One stand-in issuer, and the two checks made of its tokens: the agent's own (audience lab-agents) and the
// retrieval service's (audience lab-knowledge), each configured as the lab configures it.

export const EXPERT_TOKEN_ISSUER = 'http://localhost:8090/realms/lab';

export const EXPERT_TOKEN_CLAIMS = {
  aud: ['lab-agents', 'lab-knowledge'],
  client_id: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f03',
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
  roles: ['default-roles-lab'],
};

export type ExpertTokens = {
  issuer: StandInIssuer;
  agentCheck: AccessTokenCheck;
  knowledgeCheck: AccessTokenCheck;
  mint: (options?: Partial<MintOptions>) => Promise<string>;
  // A caller as the agent's server hands it to the handler, holding a token minted as asked.
  caller: (options?: Partial<MintOptions>) => Promise<Caller>;
};

export async function startExpertTokens(t: TestContext): Promise<ExpertTokens> {
  const now = (): Date => new Date(AGENT_START);
  const issuer = await startStandInIssuer({
    clientId: 'desk',
    clientSecret: 'stand-in-secret',
    redirectUri: 'http://localhost:3000/auth/callback',
    postLogoutRedirectUri: 'http://localhost:3000/',
    now,
    issuer: EXPERT_TOKEN_ISSUER,
  });
  t.after(() => issuer.close());
  const check = (audience: string, minRemainingSeconds: number): AccessTokenCheck =>
    createAccessTokenCheck(
      { discoveryUrl: issuer.discoveryUrl, issuer: EXPERT_TOKEN_ISSUER, audience, allowedClients: ['desk'], rolesClaim: 'roles', minRemainingSeconds },
      { now, keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
    );
  const mint = (options: Partial<MintOptions> = {}): Promise<string> =>
    issuer.mintAccessToken({ lifetimeSeconds: 600, ...options, claims: { ...EXPERT_TOKEN_CLAIMS, ...options.claims } });
  return {
    issuer,
    agentCheck: check('lab-agents', 150),
    knowledgeCheck: check('lab-knowledge', 0),
    mint,
    caller: async (options = {}) => ({
      subject: EXPERT_TOKEN_CLAIMS.sub,
      username: EXPERT_TOKEN_CLAIMS.preferred_username,
      name: EXPERT_TOKEN_CLAIMS.name,
      clientId: EXPERT_TOKEN_CLAIMS.client_id,
      roles: [...EXPERT_TOKEN_CLAIMS.roles],
      expiresAt: new Date(new Date(AGENT_START).getTime() + 600_000),
      token: await mint(options),
    }),
  };
}

// The retrieval service's check, configured as the lab configures it, with an identity provider that cannot be
// reached: every token is answered as not checkable, and the service answers 503.
export async function unreachableIdentityCheck(t: TestContext): Promise<AccessTokenCheck> {
  const dead = await deadUrl(t);
  return createAccessTokenCheck(
    {
      discoveryUrl: `${dead}/realms/lab/.well-known/openid-configuration`,
      issuer: EXPERT_TOKEN_ISSUER,
      audience: 'lab-knowledge',
      allowedClients: ['desk'],
      rolesClaim: 'roles',
      minRemainingSeconds: 0,
    },
    { now: () => new Date(AGENT_START), keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
  );
}

// --- A synthetic label set ----------------------------------------------------------------------------------

export type TestLabel = { setId: string; names: string[]; version: number; effectiveTime: string; source: string };

function label(setId: string, names: string[], version: number, effectiveTime: string): TestLabel {
  return { setId, names, version, effectiveTime, source: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}&version=${version}` };
}

export const EXAMPLAMAB = label('00000000-0000-4000-8000-0000000000a1', ['Examplamab'], 3, '20240102');
export const INVENTORIN = label('00000000-0000-4000-8000-0000000000b2', ['Inventorin', 'inventorin hydrochloride'], 7, '20231115');
export const LABELS: readonly TestLabel[] = [EXAMPLAMAB, INVENTORIN];

// A label as the index holds it, for find_labels.
function labelSource(found: TestLabel): Record<string, unknown> {
  return {
    setId: found.setId,
    version: found.version,
    effectiveTime: found.effectiveTime,
    kind: 'prescription',
    format: 'new',
    drug: found.names,
    source: found.source,
  };
}

export type ChunkOptions = { part?: 'body' | 'highlights'; path?: string[]; title?: string | null };

// A passage as the index holds it, with invented text.
export function chunk(of: TestLabel, n: number, text: string, options: ChunkOptions = {}): Record<string, unknown> {
  const part = options.part ?? 'body';
  const title = options.title === undefined ? `2.${n} Invented section ${n}` : options.title;
  return {
    id: `${of.setId}/${of.version}/sec-${n}/${part}/1`,
    text,
    part,
    type: 'text',
    section: { id: `sec-${n}`, code: '34068-7', number: `2.${n}`, title, path: options.path ?? ['2 DOSAGE AND ADMINISTRATION', `2.${n} Invented section ${n}`] },
    position: { ordinal: n },
    setId: of.setId,
    version: of.version,
    effectiveTime: of.effectiveTime,
    kind: 'prescription',
    source: of.source,
  };
}

// A text of exactly this many characters, starting with the words given.
export function sized(start: string, length: number): string {
  return `${start} ${'filler '.repeat(Math.ceil(length / 7))}`.slice(0, length);
}

// --- The real retrieval service, in-process ---------------------------------------------------------------

export type EngineScript = {
  // The answer to every find_labels request, in place of the label set's.
  find?: SearchReply;
  // The answer to each search_label request, in order. A list of passages is answered as hits, best first.
  searches?: Array<Record<string, unknown>[] | SearchReply>;
  // The answer to the count a search with no passages makes. One passage unless said.
  count?: SearchReply;
};

export type Retrieval = {
  mcpUrl: string;
  standIn: SearchStandIn;
  // Ends the engine client's deadline for the request in flight, so the service reads it as timed out.
  expire: () => void;
  // The authorization header of every request that reached the retrieval service, in order.
  authorizations: Array<string | undefined>;
  // The engine requests that were searches inside one label (not finds and not counts).
  searchRequests: () => SearchRequest[];
};

function isFind(request: SearchRequest): boolean {
  return prop(request.body, 'collapse') !== undefined;
}

function isCount(request: SearchRequest): boolean {
  return request.path.endsWith('/_count');
}

// find_labels as the index answers it: the exact-name query finds the labels with that name; the every-word
// query that follows when none did finds nothing.
function answerFind(request: SearchRequest): SearchReply {
  const filter = prop(prop(prop(request.body, 'query'), 'bool'), 'filter');
  const first: unknown = Array.isArray(filter) ? filter[0] : undefined;
  const exact = prop(prop(first, 'term'), 'drug.exact');
  if (typeof exact !== 'string') return hits([]);
  return hits(LABELS.filter((found) => found.names.some((name) => name.toLowerCase() === exact)).map(labelSource));
}

// The retrieval service checks tokens with the given check, or with tokens.knowledgeCheck.
export async function startRetrieval(
  t: TestContext,
  tokens: ExpertTokens,
  script: EngineScript = {},
  knowledgeCheck: AccessTokenCheck = tokens.knowledgeCheck,
): Promise<Retrieval> {
  const standIn = await startSearchStandIn(t);
  const { engine, expire } = testEngine(standIn.url);
  const searches = [...(script.searches ?? [])];
  standIn.answer((request) => {
    if (isCount(request)) return script.count ?? { status: 200, body: { count: 1 } };
    if (isFind(request)) return script.find ?? answerFind(request);
    const next = searches.shift();
    if (next === undefined) return { status: 500, body: { error: 'the test scripted no more searches' } };
    return Array.isArray(next) ? hits(next) : next;
  });
  const authorizations: Array<string | undefined> = [];
  const recording: AccessTokenCheck = (header) => {
    authorizations.push(header);
    return knowledgeCheck(header);
  };
  const server = createRetrievalServer(engine, 'labels', recording);
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return {
    mcpUrl: `${url}/mcp`,
    standIn,
    expire,
    authorizations,
    searchRequests: () => standIn.received.filter((request) => !isFind(request) && !isCount(request)),
  };
}

// --- Test double: a retrieval service that answers with what the test gives -----------------------------------
// STAND-IN for the retrieval service, for the E12 and E14 cases the real service cannot be made to give. NOT the
// retrieval service. The real service offers both tools, answers only with the error codes it defines, each as
// { error, detail }, and answers a success only in its own shape. This stand-in gives what the test asks for
// instead: an error code no list names, an error that is not of that shape, a success of another shape, or only
// some of the tools. Unless told otherwise, its find_labels returns EXAMPLAMAB as the real one would. It checks no
// token.

export type OddAnswers = {
  find?: CallToolResult;
  search?: CallToolResult;
  // The tools it offers. Both unless said.
  offer?: ReadonlyArray<'find_labels' | 'search_label'>;
};

const EXAMPLAMAB_FOUND: CallToolResult = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        labels: [
          {
            set_id: EXAMPLAMAB.setId,
            version: EXAMPLAMAB.version,
            effective_date: EXAMPLAMAB.effectiveTime,
            kind: 'prescription',
            format: 'new',
            names: EXAMPLAMAB.names,
            source: EXAMPLAMAB.source,
          },
        ],
        more_matched: false,
        matched_by: 'exact_name',
      }),
    },
  ],
  isError: false,
};

export async function startOddRetrieval(t: TestContext, answers: OddAnswers): Promise<string> {
  const offer = answers.offer ?? ['find_labels', 'search_label'];
  function build(): McpServer {
    const server = new McpServer({ name: 'knowledge-stand-in', version: '1' });
    if (offer.includes('find_labels')) {
      server.registerTool('find_labels', { description: 'Stand-in.', inputSchema: { drug: z.string() } }, () => answers.find ?? EXAMPLAMAB_FOUND);
    }
    if (offer.includes('search_label')) {
      server.registerTool(
        'search_label',
        {
          description: 'Stand-in.',
          inputSchema: { set_id: z.string(), query: z.string(), part: z.enum(['body', 'highlights']).optional(), max_results: z.number().optional() },
        },
        () => answers.search ?? { content: [{ type: 'text', text: '{"error":"not_scripted","detail":"Stand-in."}' }], isError: true },
      );
    }
    return server;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const part of request) if (Buffer.isBuffer(part)) chunks.push(part);
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const mcp = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.destroy();
    });
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return `${url}/mcp`;
}

// --- The agent under test --------------------------------------------------------------------------------

export const EXPERT_IDENTITY = { id: 'expert-test', implementation: 'Strands' };

// Shorter than the agent's own, so no test waits long; enough turns for find, search and three answers. These
// limits are kept in real time: a model request's 0.5 s by the OpenAI client, a tool call's 2 s by the MCP client,
// and the run's 5 s by a real timer as well as by the test's clock. The tool limit also bounds connecting to the
// retrieval service; at 0.3 s a first, cold connection under the full suite once ran out, so it is 2 s.
export const EXPERT_TEST_LIMITS: Limits = { maxTurns: 8, runMs: 5000, modelMs: 500, toolMs: 2000 };

export type ExpertRunOptions = {
  model: ScriptedModel;
  mcpUrl: string;
  caller: Caller;
  clock?: AgentClock;
  limits?: Partial<Limits>;
  settings?: { search?: Partial<ExpertSettings['search']>; answer?: Partial<ExpertSettings['answer']> };
};

// Handles one message and checks the response keeps to the agent contract.
export async function runExpert(options: ExpertRunOptions, inbound: InboundMessage): Promise<InvocationResponse> {
  const clock = options.clock ?? agentClock(AGENT_START);
  const response = await handleQuestion(
    {
      identity: EXPERT_IDENTITY,
      model: options.model.settings,
      knowledgeMcpUrl: options.mcpUrl,
      now: clock.now,
      limits: { ...EXPERT_TEST_LIMITS, ...options.limits },
      settings: {
        search: { ...EXPERT_SETTINGS.search, ...options.settings?.search },
        answer: { ...EXPERT_SETTINGS.answer, ...options.settings?.answer },
      },
    },
    inbound,
    options.caller,
  );
  return invocationResponseSchema.parse(response);
}

export type RetrievalStep = Extract<Step, { kind: 'retrieval' }>;

export function retrievalSteps(response: InvocationResponse): RetrievalStep[] {
  return response.steps.filter((step): step is RetrievalStep => step.kind === 'retrieval');
}
