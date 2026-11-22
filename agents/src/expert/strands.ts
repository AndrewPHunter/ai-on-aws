// The label expert, on Strands.
//
// It answers a question about a medicine only from the text of that medicine's label, as the retrieval service
// returns it. Strands owns the loop: it sends the conversation and four tools to the model, runs the tools one at
// a time and stops. This file's code owns everything a reply is made of:
//
//   - find_labels and search_label call the retrieval service with the token the agent got for it by exchanging
//     the caller's, once, before connecting (../tools/tool-token.ts). A search is not made on a label find_labels
//     did not return in this run, or after the run's searches are used up. Each passage is given a short handle
//     (P1, P2, ...), and passages are shown whole while they fit the reading allowance.
//   - answer and cannot_answer are checked in code (checks.ts). An accepted one ends the run through a cancel
//     signal this file owns, so the model is not asked again. A refused one is told to the model, up to the
//     number of corrections allowed; one more ends the run.
//   - A search that could not be made ends the run. It is never told to the model, which would read it as
//     "nothing found", and it is never repeated.
//   - A turn that used up its output allowance is asked again once, with thinking off, by setting retry in the
//     AfterModelCall hook, whatever it had written.
//   - The turn limit is Strands' own (limits.turns). The time limit is the same cancel signal.
//
// The reply is written by code: each accepted statement and its citation, or a sentence for each way of not
// answering. Text the model writes outside an accepted statement stays in its model step.
//
// Strands settings as the intake agent's, for the same reasons: tools one at a time (two calls in one turn must
// see each other's effect, such as a search on a label found in the same turn), nothing printed (a message can
// carry patient details), no trimming of history, and a new Agent and MCP client for every message.

import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  Agent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  MaxTokensError,
  McpClient,
  NullConversationManager,
  TextBlock,
  Tool,
  ToolResultBlock,
} from '@strands-agents/sdk';
import type { AgentResult, Message, ToolContext, ToolSpec, ToolStreamGenerator } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { z } from 'zod';

import type { Caller } from '../../../shared/access-token.ts';
import type { Citation, InboundMessage, InvocationResponse, LabelAnswer } from '../../../shared/agent-contract.ts';
import type { TokenExchange } from '../../../shared/token-exchange.ts';
import type { AgentIdentity } from '../contract/server.ts';
import { MODEL_UNREACHABLE, modelAnsweredWithStatus, modelDidNotAnswerWithin } from '../model/served.ts';
import type { ModelSettings } from '../model/served.ts';
import { completed, failed, stopped, stoppedAtTimeLimit, stoppedAtTurnLimit } from '../run/endings.ts';
import type { EndableRun } from '../run/endings.ts';
import type { Limits } from '../run/limits.ts';
import { startRunState } from '../run/state.ts';
import { recordError, recordNotCalled } from '../run/steps.ts';
import { KNOWLEDGE, toolToken } from '../tools/tool-token.ts';
import { ANSWER_CORRECTION_CLOSING, checkAnswer, checkCannotAnswer, replyFor } from './checks.ts';
import type { CheckedStatement, ShownPassage } from './checks.ts';
import { SYSTEM_PROMPT, userTurn } from './prompt.ts';
import {
  RETRIEVAL_LACKS_TOOLS,
  connectionFailure,
  findLabelsSchema,
  payloadOf,
  readAnswer,
  retrievalDidNotAnswerWithin,
  searchLabelSchema,
  sectionName,
} from './retrieval.ts';
import type { LabelFound, Passage, Reading } from './retrieval.ts';
import { EXCERPT_CHARACTERS } from './settings.ts';
import type { ExpertSettings } from './settings.ts';

export type ExpertDeps = {
  identity: AgentIdentity;
  model: ModelSettings;
  knowledgeMcpUrl: string;
  // Exchanges the caller's token for one meant for the retrieval service.
  exchange: TokenExchange;
  now: () => Date;
  limits: Limits;
  settings: ExpertSettings;
};

type ListedTool = Awaited<ReturnType<McpClient['listTools']>>[number];


export function answerNotPassed(corrections: number): string {
  return `The answer did not pass the checks after ${corrections} corrections, and was not returned.`;
}

export function endedWithoutFinalTool(finishReason: string): string {
  return `The model ended its turn (${finishReason}) without calling answer or cannot_answer, and what it wrote was not returned.`;
}

export const CUT_OFF_AGAIN =
  'The model reached its output allowance again after being asked once more with thinking off, and nothing it wrote was returned.';

// A passage the run has seen: its handle, what a citation of it carries, and whether the model was shown it.
type SeenPassage = { passage: ShownPassage; part: string; type: string; shown: boolean };

type ExpertRun = EndableRun & {
  settings: ExpertSettings;
  // Each label find_labels returned in this run, by set id.
  labels: Map<string, LabelFound>;
  // Each find_labels call the service answered, with how many labels came back.
  finds: Array<{ labels: number }>;
  // Calls sent to search_label, whatever came back.
  searchesSent: number;
  // Each label a search was answered for, once, in the order first searched.
  searched: string[];
  // Handles by passage id, and passages by handle.
  handles: Map<string, string>;
  seen: Map<string, SeenPassage>;
  allowanceLeft: number;
  refusedAnswers: number;
  // Set when a tool found the run's time used up before it called anything.
  timeUp: boolean;
  // How the run ends, once code has decided it: an accepted final tool, a failed search, or an answer that did
  // not pass after the corrections allowed.
  ending?: InvocationResponse;
};

function startRun(deps: ExpertDeps): ExpertRun {
  return {
    ...startRunState(deps.identity, deps.now, deps.limits),
    citations: [],
    caseActions: [],
    settings: deps.settings,
    labels: new Map(),
    finds: [],
    searchesSent: 0,
    searched: [],
    handles: new Map(),
    seen: new Map(),
    allowanceLeft: deps.settings.search.readingAllowance,
    refusedAnswers: 0,
    timeUp: false,
  };
}

// ---------- Endings this agent adds ----------

function answeredWith(run: ExpertRun, reply: string, labelAnswer: LabelAnswer, citations: Citation[]): InvocationResponse {
  run.citations = citations;
  return { ...completed(run, reply), label_answer: labelAnswer };
}

// ---------- Helpers ----------

async function within<Value>(ms: number, work: () => Promise<Value>): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('time limit'));
    }, ms);
  });
  try {
    return await Promise.race([work(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

// A sentence for a person about why the model call failed, as the intake agent on Strands writes it. Never the
// error's own text, which can carry the server's address.
function modelFailure(error: Error, modelMs: number): string {
  if (error.message === 'unable to parse tool input JSON') {
    return 'The model wrote tool arguments that are not JSON, and Strands stops the run when that happens.';
  }
  const chain = [error, error.cause].filter((link): link is Error => link instanceof Error);
  if (chain.some((link) => /timed? ?out/i.test(`${link.name} ${link.message}`))) {
    return modelDidNotAnswerWithin(modelMs);
  }
  for (const link of chain) {
    const status: unknown = Reflect.get(link, 'status');
    if (typeof status === 'number') {
      return modelAnsweredWithStatus(status);
    }
  }
  return MODEL_UNREACHABLE;
}

function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'textBlock')
    .map((block) => block.text)
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function characters(count: number): string {
  return `${count.toLocaleString('en-US')} characters`;
}

// ---------- The tools ----------

// What a tool hands back to Strands: what the model is told, and whether it is an error.
type Told = { text: string; error: boolean };

// What every tool here shares: the run it belongs to, and how it stops the run.
type Session = {
  run: ExpertRun;
  mcp: McpClient;
  listed: Map<string, ListedTool>;
  stopper: AbortController;
};

abstract class ExpertTool extends Tool {
  protected readonly session: Session;

  constructor(session: Session) {
    super();
    this.session = session;
  }

  protected abstract handle(input: unknown, context: ToolContext): Promise<Told>;

  async *stream(context: ToolContext): ToolStreamGenerator {
    const { run, stopper } = this.session;
    // A call with no time left is not made, so it cannot be mistaken for a service that did not answer.
    let told: Told;
    if (run.deadline.expired()) {
      run.timeUp = true;
      stopper.abort();
      told = { text: 'The run has ended.', error: true };
    } else {
      told = await this.handle(context.toolUse.input, context);
    }
    return new ToolResultBlock({
      toolUseId: context.toolUse.toolUseId,
      status: told.error ? 'error' : 'success',
      content: [new TextBlock(told.text)],
    });
  }

  // A call the agent's code will not make: recorded, and told to the model.
  protected refuse(input: unknown, error: string, detail: string): Told {
    const refusal = { error, detail };
    recordNotCalled(this.session.run, this.name, input, refusal);
    return { text: JSON.stringify(refusal), error: true };
  }

  // Ends the run in code. Nothing more is asked of the model.
  protected end(response: InvocationResponse): Told {
    this.session.run.ending = response;
    this.session.stopper.abort();
    return { text: 'The run has ended.', error: true };
  }

  // Calls one of the retrieval service's tools within the tool limit, and reads its answer as a closed list.
  protected async callService<T>(
    tool: string,
    args: Record<string, string | number>,
    context: ToolContext,
    success: z.ZodType<T>,
  ): Promise<{ reading: Reading<T>; payload: unknown; startedAt: Date; durationMs: number }> {
    const { run, mcp, listed } = this.session;
    const started = run.now();
    const timeoutMs = run.deadline.within(run.limits.toolMs);
    const service = listed.get(tool);
    let reading: Reading<T>;
    let payload: unknown;
    if (service === undefined) {
      reading = { kind: 'fails', reason: RETRIEVAL_LACKS_TOOLS };
      payload = { error: 'not_offered', detail: RETRIEVAL_LACKS_TOOLS };
    } else {
      try {
        const result = await mcp.callTool(service, args, { signal: context.cancelSignal, timeoutMs });
        const isError = isRecord(result) && result['isError'] === true;
        payload = payloadOf(result);
        reading = readAnswer(tool, isError, payload, success);
      } catch {
        const reason = retrievalDidNotAnswerWithin(timeoutMs);
        reading = { kind: 'fails', reason };
        payload = { error: 'no_answer', detail: reason };
      }
    }
    return { reading, payload, startedAt: started, durationMs: Math.max(0, run.now().getTime() - started.getTime()) };
  }

  protected recordCall(input: unknown, result: unknown, isError: boolean, startedAt: Date, durationMs: number): void {
    this.session.run.steps.push({
      kind: 'tool',
      started_at: startedAt.toISOString(),
      duration_ms: durationMs,
      tool: this.name,
      requested_by: 'model',
      arguments: input,
      result,
      is_error: isError,
    });
  }

  // A search or find that could not be made: recorded, and the run ends failed. The model is not told.
  protected failRun(reason: string): Told {
    recordError(this.session.run, reason);
    return this.end(failed(this.session.run, reason));
  }

  // A final answer that was not accepted. Recorded; told to the model while corrections remain. One more than
  // that ends the run stopped, with nothing returned. A refused answer and a refused cannot_answer count alike.
  // The closing line says what to do next: for answer, send the whole answer again; for cannot_answer, choose again.
  protected refuseFinal(input: unknown, problems: readonly string[], closing: string): Told {
    const { run } = this.session;
    run.refusedAnswers++;
    recordNotCalled(run, this.name, input, { error: 'answer_not_accepted', problems });
    const { maxCorrections } = run.settings.answer;
    if (run.refusedAnswers > maxCorrections) {
      return this.end(stopped(run, answerNotPassed(maxCorrections)));
    }
    const list = problems.map((problem) => `- ${problem}`).join('\n');
    return { text: `Not accepted:\n${list}\n${closing}`, error: true };
  }
}

class FindLabelsTool extends ExpertTool {
  name = 'find_labels';
  description =
    'Find the approved labels for a drug by its name: a product name, a generic name or an active ingredient. ' +
    "Returns each label's set id (for search_label), names, kind and date, newest first, and whether more matched. " +
    'An empty list means no label in the label set has that name.';
  toolSpec: ToolSpec = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object',
      properties: { drug: { type: 'string', description: "The drug's name, as the message writes it." } },
      required: ['drug'],
    },
  };

  protected async handle(input: unknown, context: ToolContext): Promise<Told> {
    const drug = isRecord(input) ? input['drug'] : undefined;
    if (typeof drug !== 'string' || drug.trim() === '') {
      return this.refuse(input, 'invalid_input', '"drug" must be a name, not empty.');
    }
    const { reading, payload, startedAt, durationMs } = await this.callService('find_labels', { drug }, context, findLabelsSchema);
    this.recordCall(input, payload, reading.kind !== 'ok', startedAt, durationMs);
    if (reading.kind === 'fails') return this.failRun(reading.reason);
    if (reading.kind === 'told') return { text: JSON.stringify(reading.error), error: true };

    const { run } = this.session;
    run.finds.push({ labels: reading.value.labels.length });
    for (const label of reading.value.labels) run.labels.set(label.set_id, label);
    return {
      text: JSON.stringify({
        labels: reading.value.labels.map((label) => ({
          set_id: label.set_id,
          names: label.names,
          kind: label.kind,
          effective_date: label.effective_date,
        })),
        more_matched: reading.value.more_matched,
      }),
      error: false,
    };
  }
}

class SearchLabelTool extends ExpertTool {
  name = 'search_label';
  description: string;
  toolSpec: ToolSpec;

  constructor(session: Session) {
    super(session);
    const { maxSearches } = session.run.settings.search;
    this.description =
      'Search the text of one label for passages about the question, best first. Give a set id that find_labels ' +
      'returned and plain words to look for. Each passage is shown with a handle, such as P1, for answer to cite. ' +
      `At most ${maxSearches} searches in a run.`;
    this.toolSpec = {
      name: this.name,
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          set_id: { type: 'string', description: "The label's set id, from find_labels." },
          query: { type: 'string', description: 'The words to search for, as plain words.' },
          part: {
            type: 'string',
            enum: ['body', 'highlights'],
            description: '"body" for the full text, "highlights" for the Highlights summary; leave out for both.',
          },
        },
        required: ['set_id', 'query'],
      },
    };
  }

  protected async handle(input: unknown, context: ToolContext): Promise<Told> {
    const { run } = this.session;
    const { maxSearches, resultsPerSearch } = run.settings.search;
    const setId = isRecord(input) ? input['set_id'] : undefined;
    const query = isRecord(input) ? input['query'] : undefined;
    const part = isRecord(input) ? input['part'] : undefined;
    if (typeof setId !== 'string' || typeof query !== 'string' || query.trim() === '') {
      return this.refuse(input, 'invalid_input', '"set_id" must be a set id from find_labels and "query" must be words, not empty.');
    }
    if (part !== undefined && part !== 'body' && part !== 'highlights') {
      return this.refuse(input, 'invalid_input', '"part" must be "body" or "highlights", or left out for both.');
    }
    if (!run.labels.has(setId)) {
      return this.refuse(input, 'label_not_returned', `${setId} is not a set id find_labels returned in this run. Call find_labels first.`);
    }
    if (run.searchesSent >= maxSearches) {
      return this.refuse(input, 'search_limit_reached', `This run has made its ${maxSearches} searches. Answer from the passages shown, or call cannot_answer.`);
    }

    run.searchesSent++;
    const args: Record<string, string | number> = { set_id: setId, query, max_results: resultsPerSearch };
    if (part !== undefined) args['part'] = part;
    const { reading, payload, startedAt, durationMs } = await this.callService('search_label', args, context, searchLabelSchema);
    if (reading.kind === 'ok' && reading.value.passages.some((passage) => passage.label.set_id !== setId)) {
      this.recordCall(input, payload, true, startedAt, durationMs);
      return this.failRun('The retrieval service returned a passage from another label than the one searched.');
    }
    if (reading.kind !== 'ok') {
      this.recordCall(input, payload, true, startedAt, durationMs);
      if (reading.kind === 'fails') return this.failRun(reading.reason);
      return { text: JSON.stringify(reading.error), error: true };
    }

    if (!run.searched.includes(setId)) run.searched.push(setId);
    const told = this.show(setId, reading.value.passages);
    run.steps.push({
      kind: 'retrieval',
      started_at: startedAt.toISOString(),
      duration_ms: durationMs,
      query,
      // What the service reports it ran: its strategy is the service's setting, not this agent's.
      strategy: reading.value.strategy,
      hits: reading.value.passages.map((passage) => {
        const handle = run.handles.get(passage.chunk_id) ?? '';
        const seen = run.seen.get(handle);
        return {
          drug: seen?.passage.names.join(', ') ?? '',
          section: sectionName(passage),
          score: passage.score,
          excerpt: passage.text.slice(0, EXCERPT_CHARACTERS),
          passage: passage.chunk_id,
          handle,
          shown: seen?.shown ?? false,
        };
      }),
    });
    const left = maxSearches - run.searchesSent;
    return { text: `${told}\n\nSearches left in this run: ${left}.`, error: false };
  }

  // Gives each passage its handle and decides, best first, which are shown: a passage already shown is named as
  // above and costs nothing; one that fits in what is left of the reading allowance is shown whole; one that does
  // not fit is named as not shown. Each passage is judged on its own, so a smaller one after it can still be shown.
  private show(setId: string, passages: readonly Passage[]): string {
    const { run } = this.session;
    const names = run.labels.get(setId)?.names ?? [];
    if (passages.length === 0) {
      return 'The search found no passages in this label for these words.';
    }
    const parts: string[] = [`${passages.length} passage${passages.length === 1 ? '' : 's'}, best first.`];
    for (const passage of passages) {
      let handle = run.handles.get(passage.chunk_id);
      if (handle === undefined) {
        handle = `P${run.handles.size + 1}`;
        run.handles.set(passage.chunk_id, handle);
        run.seen.set(handle, {
          passage: {
            handle,
            passageId: passage.chunk_id,
            text: passage.text,
            names,
            section: sectionName(passage),
            setId: passage.label.set_id,
            version: passage.label.version,
            effectiveDate: passage.label.effective_date,
            source: passage.label.source,
          },
          part: passage.part,
          type: passage.type,
          shown: false,
        });
      }
      const seen = run.seen.get(handle);
      if (seen === undefined) continue;
      if (seen.shown) {
        parts.push(`${handle} is shown above.`);
        continue;
      }
      const size = passage.text.length;
      if (size > run.allowanceLeft) {
        parts.push(
          `Not shown: a passage from ${seen.passage.section} (${seen.part}, ${seen.type}), ${characters(size)}, ` +
            `does not fit in the ${characters(run.allowanceLeft)} left of this run's reading allowance.`,
        );
        continue;
      }
      run.allowanceLeft -= size;
      seen.shown = true;
      parts.push(`${handle} | ${names.join(', ')} | ${seen.passage.section} | ${seen.part}, ${seen.type}\n${passage.text}`);
    }
    return parts.join('\n\n');
  }
}

class AnswerTool extends ExpertTool {
  name = 'answer';
  description: string;
  toolSpec: ToolSpec;

  constructor(session: Session) {
    super(session);
    const { maxStatements, quoteMinCharacters, quoteMaxCharacters } = session.run.settings.answer;
    this.description =
      'Answer the question from the passages shown. Each statement cites the handles of the passages that support ' +
      `it and carries a quote of ${quoteMinCharacters} to ${quoteMaxCharacters} characters copied word for word from ` +
      `one of them. At most ${maxStatements} statements. The answer is checked against the passages before it is returned.`;
    this.toolSpec = {
      name: this.name,
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          statements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'One statement of the answer.' },
                passages: { type: 'array', items: { type: 'string' }, description: 'The handles of the passages it relies on, such as P1.' },
                quote: { type: 'string', description: 'One continuous span copied word for word from one cited passage.' },
              },
              required: ['text', 'passages', 'quote'],
            },
          },
        },
        required: ['statements'],
      },
    };
  }

  protected handle(input: unknown): Promise<Told> {
    const { run } = this.session;
    const shown = new Map<string, ShownPassage>();
    for (const [handle, seen] of run.seen) if (seen.shown) shown.set(handle, seen.passage);
    const verdict = checkAnswer(input, shown, run.settings.answer);
    if (!verdict.accepted) {
      return Promise.resolve(this.refuseFinal(input, verdict.problems, ANSWER_CORRECTION_CLOSING));
    }
    const citations = verdict.statements.map(citationOf);
    return Promise.resolve(this.end(answeredWith(run, replyFor(verdict.statements), 'answered', citations)));
  }
}

class CannotAnswerTool extends ExpertTool {
  name = 'cannot_answer';
  description =
    'Say that the question is not answered from a label, and why: "no_label" when find_labels returned no label, ' +
    '"label_does_not_answer" when the label was searched and does not answer it, "not_a_label_question" when the ' +
    'message does not ask what a drug label says.';
  toolSpec: ToolSpec = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['no_label', 'label_does_not_answer', 'not_a_label_question'] } },
      required: ['reason'],
    },
  };

  protected handle(input: unknown): Promise<Told> {
    const { run } = this.session;
    const verdict = checkCannotAnswer(input, {
      finds: run.finds,
      searched: run.searched.flatMap((setId) => {
        const label = run.labels.get(setId);
        return label === undefined ? [] : [{ names: label.names, version: label.version, effectiveDate: label.effective_date }];
      }),
    });
    if (!verdict.accepted) {
      return Promise.resolve(this.refuseFinal(input, [verdict.problem], 'Call answer or cannot_answer again.'));
    }
    return Promise.resolve(this.end(answeredWith(run, verdict.reply, verdict.reason, [])));
  }
}

function citationOf(statement: CheckedStatement): Citation {
  const { foundIn } = statement;
  return {
    drug: foundIn.names.join(', '),
    section: foundIn.section,
    quote: statement.quote,
    set_id: foundIn.setId,
    version: foundIn.version,
    effective_date: foundIn.effectiveDate,
    source: foundIn.source,
    passage: foundIn.passageId,
  };
}

// ---------- One message ----------

export async function handleQuestion(deps: ExpertDeps, message: InboundMessage, caller: Caller): Promise<InvocationResponse> {
  const run = startRun(deps);
  // The caller's token is exchanged, once, for one meant for the retrieval service, before anything is connected.
  const got = await toolToken(deps.exchange, KNOWLEDGE, caller.token, run.deadline.within(deps.limits.toolMs));
  if (!got.ok) {
    recordError(run, got.reason);
    return failed(run, got.reason);
  }
  const mcp = new McpClient({
    url: deps.knowledgeMcpUrl,
    // The token for the retrieval service, on every request this client makes.
    headers: { authorization: `Bearer ${got.token}` },
    applicationName: deps.identity.id,
  });

  try {
    let listed: ListedTool[];
    try {
      listed = await within(run.deadline.within(deps.limits.toolMs), async () => {
        await mcp.connect();
        return mcp.listTools();
      });
    } catch (error) {
      const reason = connectionFailure(error);
      recordError(run, reason);
      return failed(run, reason);
    }
    const offered = new Map(listed.map((tool) => [tool.name, tool]));
    if (!offered.has('find_labels') || !offered.has('search_label')) {
      recordError(run, RETRIEVAL_LACKS_TOOLS);
      return failed(run, RETRIEVAL_LACKS_TOOLS);
    }
    return await converse(run, deps, { run, mcp, listed: offered, stopper: new AbortController() }, message);
  } finally {
    await mcp.disconnect().catch(() => undefined);
  }
}

async function converse(run: ExpertRun, deps: ExpertDeps, session: Session, message: InboundMessage): Promise<InvocationResponse> {
  const { limits } = run;
  const { stopper } = session;
  const params = { seed: deps.model.seed };

  const model = new OpenAIModel({
    modelId: deps.model.modelId,
    apiKey: deps.model.apiKey,
    clientConfig: { baseURL: deps.model.baseUrl, timeout: limits.modelMs },
    temperature: deps.model.temperature,
    maxTokens: deps.model.maxTokens,
    params,
  });

  const agent = new Agent({
    model,
    tools: [new FindLabelsTool(session), new SearchLabelTool(session), new AnswerTool(session), new CannotAnswerTool(session)],
    systemPrompt: SYSTEM_PROMPT,
    toolExecutor: 'sequential',
    conversationManager: new NullConversationManager(),
    printer: false,
  });

  const timer = AbortSignal.timeout(Math.max(1, run.deadline.remainingMs()));
  let timeLimitReached = false;
  let modelFailed: string | undefined;
  let ranOutOfOutput = false;
  let thinking = true;
  let turnStarted = run.now();
  let turnAllowanceMs = limits.modelMs;

  agent.addHook(BeforeModelCallEvent, () => {
    if (run.deadline.expired()) {
      timeLimitReached = true;
      stopper.abort();
    } else {
      modelFailed = undefined;
    }
    turnStarted = run.now();
    turnAllowanceMs = run.deadline.within(limits.modelMs);
  });

  agent.addHook(AfterModelCallEvent, (event) => {
    const startedAt = turnStarted.toISOString();
    const durationMs = Math.max(0, run.now().getTime() - turnStarted.getTime());

    if (event.error !== undefined) {
      if (stopper.signal.aborted) {
        return;
      }
      if (timer.aborted) {
        modelFailed = modelDidNotAnswerWithin(turnAllowanceMs);
        recordError(run, modelFailed, startedAt, durationMs);
        return;
      }
      if (event.error instanceof MaxTokensError) {
        // A turn cut off at the output allowance, in text or part way through a tool call's arguments.
        const written = textOf(event.error.partialMessage);
        run.steps.push({
          kind: 'model',
          started_at: startedAt,
          duration_ms: durationMs,
          model: deps.model.modelId,
          finish_reason: 'maxTokens',
          text: written === '' ? null : written,
          tool_calls: [],
          input_tokens: null,
          output_tokens: null,
        });
        if (thinking) {
          // Asked again once, whatever was written, with thinking off for the rest of the run.
          thinking = false;
          model.updateConfig({ params: { ...params, reasoning: { effort: 'none' } } });
          event.retry = true;
          return;
        }
        ranOutOfOutput = true;
        return;
      }
      modelFailed = modelFailure(event.error, limits.modelMs);
      recordError(run, modelFailed, startedAt, durationMs);
      return;
    }

    if (event.stopData === undefined) {
      return;
    }
    const { message: said, stopReason } = event.stopData;
    const text = textOf(said);
    run.steps.push({
      kind: 'model',
      started_at: startedAt,
      duration_ms: durationMs,
      model: deps.model.modelId,
      finish_reason: stopReason,
      text: text === '' ? null : text,
      tool_calls: said.content.filter((block) => block.type === 'toolUseBlock').map((block) => ({ name: block.name, arguments: block.input })),
      input_tokens: said.metadata?.usage?.inputTokens ?? null,
      output_tokens: said.metadata?.usage?.outputTokens ?? null,
    });
  });

  agent.addHook(BeforeToolCallEvent, (event) => {
    if (stopper.signal.aborted) {
      // The run has ended. Nothing more is called.
      event.cancel = true;
    }
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    if (event.tool === undefined && !stopper.signal.aborted) {
      // Strands found no such tool and told the model so in its own words.
      const { name, input } = event.toolUse;
      const told = event.result.content.find((block) => block.type === 'textBlock');
      recordNotCalled(run, name, input, { error: 'unknown_tool', detail: told?.text ?? '' });
    }
  });

  let result: AgentResult | undefined;
  let threw: unknown;
  try {
    result = await agent.invoke(userTurn(message), {
      cancelSignal: AbortSignal.any([stopper.signal, timer]),
      limits: { turns: limits.maxTurns },
    });
  } catch (error) {
    threw = error;
  }

  if (run.ending !== undefined) {
    return run.ending;
  }
  if (modelFailed !== undefined) {
    return failed(run, modelFailed);
  }
  if (timeLimitReached || run.timeUp || timer.aborted) {
    return stoppedAtTimeLimit(run);
  }
  if (ranOutOfOutput) {
    return stopped(run, CUT_OFF_AGAIN);
  }
  if (result === undefined) {
    const reason = `Strands stopped the run with ${threw instanceof Error ? threw.name : 'an error'}.`;
    recordError(run, reason);
    return failed(run, reason);
  }
  if (result.stopReason === 'limitTurns') {
    return stoppedAtTurnLimit(run);
  }
  return stopped(run, endedWithoutFinalTool(result.stopReason));
}
