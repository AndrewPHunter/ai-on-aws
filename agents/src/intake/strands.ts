// The intake agent on Strands.
//
// The same agent as handwritten.ts: the same prompt, the same rules (run.ts), the same record and the
// same contract. What differs is who owns the loop. Here Strands sends the conversation and the tools
// to the model, runs the tools and stops; this file's code takes part only where Strands calls it:
//
//   - A tool call is refused in the BeforeToolCall hook, by cancelling it with what the model is told.
//   - A write whose reply is lost is repeated once by setting retry in the AfterToolCall hook.
//   - A write that is still unsettled stops the run through a cancel signal this file owns.
//   - A turn that used up its output allowance is asked again, once, with thinking off, by setting
//     retry in the AfterModelCall hook.
//   - The turn limit is Strands' own (limits.turns). The time limit is the same cancel signal.
//
// Strands is used the way it comes: its OpenAI model on its default API (the Responses API), its own
// loop, its own MCP client. The model server is the local stand-in for Bedrock, which is Strands'
// default model and takes this place on AWS.
//
// What Strands does differently from the hand-written loop, each seen in a test:
//
//   - Its MCP tool makes the call with no time limit, so a lost reply would wait until the run's
//     time limit. CaseTool below makes the same call through Strands' MCP client with the limit.
//   - Tool arguments that are not JSON stop the run with an error. The hand-written loop tells the
//     model and carries on. Nothing is called in either.
//   - A turn that ends at the output allowance is an error whatever was written, so no partial
//     reply is ever returned. The hand-written loop returns a cut-off reply if there is any text.
//   - It answers an unknown tool itself, in its own words.
//   - A tool result that is an error reaches the model with "[ERROR] " in front of it.
//
// A failed request to the model is retried by two layers, both left as they come. The OpenAI client
// inside Strands' model asks up to three times when there is no response in time, or the status is
// 408, 409, 429 or 5xx. None of that reaches this file's hooks. On this model Strands' own retry
// covers throttling only (status 429, once the client has given up): up to six attempts with a
// growing, random wait. The run's time limit stops either.
//
// Settings that are not Strands' defaults, each for a reason of this agent's own:
//
//   - Tools run one at a time. The default runs the calls of one turn at once, and two create_case
//     calls in one turn would then both pass the one-case rule.
//   - Nothing is printed to the log. The conversation holds patient details.
//   - No trimming of history. A run is one message and a few turns.
//   - A new Agent and a new MCP client are made for every message. A Strands Agent keeps its
//     conversation between calls, and the context headers belong to one message.

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

import type { Caller } from '../../../shared/access-token.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import type { TokenExchange } from '../../../shared/token-exchange.ts';
import type { AgentIdentity } from '../contract/server.ts';
import { MODEL_UNREACHABLE, modelAnsweredWithStatus, modelDidNotAnswerWithin } from '../model/served.ts';
import type { ModelSettings } from '../model/served.ts';
import { caseSystemHeaders, connectionFailure, isCaseTool, missingCaseTools, noAnswerWithin, payloadOf } from '../tools/case-system.ts';
import type { ToolOutcome } from '../tools/tool-set.ts';
import { CASE_SYSTEM, toolToken } from '../tools/tool-token.ts';
import { completed, failed, stoppedAtTimeLimit, stoppedAtTurnLimit, stoppedCutOff, stoppedWithoutReply } from '../run/endings.ts';
import type { Limits } from '../run/limits.ts';
import { recordError, recordNotCalled, recordToolCall, toldAbout } from '../run/steps.ts';
import type { Refusal } from '../run/steps.ts';
import { askAgainWithoutThinking } from '../run/turns.ts';
import { SYSTEM_PROMPT, userTurn } from './prompt.ts';
import { afterCall, refusalBeforeCall, startRun, unsettledWithoutRepeat } from './run.ts';
import type { IntakeRun } from './run.ts';

export type StrandsDeps = {
  identity: AgentIdentity;
  model: ModelSettings;
  caseMcpUrl: string;
  // Exchanges the caller's token for one meant for the case system.
  exchange: TokenExchange;
  now: () => Date;
  limits: Limits;
};

type ListedTool = Awaited<ReturnType<McpClient['listTools']>>[number];

// One of the case system's tools, as Strands is given it. The call goes through Strands' MCP client
// with the run's time limit, and what came back is kept in the shared form (answered, or no answer)
// for the AfterToolCall hook, which applies the shared rules to it.
class CaseTool extends Tool {
  name: string;
  description: string;
  toolSpec: ToolSpec;
  private readonly listed: ListedTool;
  private readonly mcp: McpClient;
  private readonly run: IntakeRun;
  private readonly outcomes: Map<string, ToolOutcome>;

  constructor(listed: ListedTool, mcp: McpClient, run: IntakeRun, outcomes: Map<string, ToolOutcome>) {
    super();
    this.name = listed.name;
    this.description = listed.description;
    this.toolSpec = listed.toolSpec;
    this.listed = listed;
    this.mcp = mcp;
    this.run = run;
    this.outcomes = outcomes;
  }

  async *stream(context: ToolContext): ToolStreamGenerator {
    const { toolUseId, input } = context.toolUse;
    const timeoutMs = this.run.deadline.within(this.run.limits.toolMs);
    let outcome: ToolOutcome;
    try {
      const result = await this.mcp.callTool(this.listed, input, { signal: context.cancelSignal, timeoutMs });
      const isError = typeof result === 'object' && result !== null && Reflect.get(result, 'isError') === true;
      outcome = { kind: 'answered', isError, payload: payloadOf(result) };
    } catch {
      outcome = { kind: 'no_answer', reason: noAnswerWithin(timeoutMs) };
    }
    this.outcomes.set(toolUseId, outcome);
    return new ToolResultBlock({
      toolUseId,
      status: outcome.kind === 'answered' && !outcome.isError ? 'success' : 'error',
      content: [new TextBlock(toldAbout(outcome))],
    });
  }
}

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

// A sentence for a person about why the model call failed. Never the error's own text, which can
// carry the server's address.
function modelFailure(error: Error, modelMs: number): string {
  // Strands reports arguments it could not parse only by this message.
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

// The text of a message, without the model's reasoning or its tool calls.
function textOf(message: Message): string {
  return message.content
    .filter((block) => block.type === 'textBlock')
    .map((block) => block.text)
    .join('');
}

export async function handleInquiry(deps: StrandsDeps, message: InboundMessage, caller: Caller): Promise<InvocationResponse> {
  const run = startRun(deps.identity, deps.now, deps.limits);
  // The caller's token is exchanged, once, for one meant for the case system, before anything is connected.
  const got = await toolToken(deps.exchange, CASE_SYSTEM, caller.token, run.deadline.within(deps.limits.toolMs));
  if (!got.ok) {
    recordError(run, got.reason);
    return failed(run, got.reason);
  }
  const mcp = new McpClient({
    url: deps.caseMcpUrl,
    // The context headers and the token for the case system, on every request this client makes.
    headers: caseSystemHeaders(message, got.token),
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
    const short = missingCaseTools(listed.map((tool) => tool.name));
    if (short !== undefined) {
      recordError(run, short);
      return failed(run, short);
    }
    return await converse(run, deps, mcp, listed, message);
  } finally {
    await mcp.disconnect().catch(() => undefined);
  }
}

async function converse(
  run: IntakeRun,
  deps: StrandsDeps,
  mcp: McpClient,
  listed: ListedTool[],
  message: InboundMessage,
): Promise<InvocationResponse> {
  const { limits } = run;
  const outcomes = new Map<string, ToolOutcome>();
  const params = { seed: deps.model.seed };

  // Strands' OpenAI model on its default API, the Responses API.
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
    // The run's two tools and nothing else the case system offers.
    tools: listed.filter((tool) => isCaseTool(tool.name)).map((tool) => new CaseTool(tool, mcp, run, outcomes)),
    systemPrompt: SYSTEM_PROMPT,
    toolExecutor: 'sequential',
    conversationManager: new NullConversationManager(),
    printer: false,
  });

  // What this run knows that Strands does not. The run's ending is decided from these and from
  // run.ts's state, with Strands' own stop reason consulted last.
  const stopper = new AbortController();
  // The run's time limit in real time, for a request that is still in flight when it is reached.
  const timer = AbortSignal.timeout(Math.max(1, run.deadline.remainingMs()));
  let timeLimitReached = false;
  let modelFailed: string | undefined;
  let ranOutOfOutput = false;
  let cutOff = false;
  let thinking = true;
  let turnStarted = run.now();
  let turnAllowanceMs = limits.modelMs;
  let lastReply = '';
  const refused = new Map<string, Refusal>();
  const attempts = new Map<string, number>();
  const callStarted = new Map<string, Date>();

  agent.addHook(BeforeModelCallEvent, () => {
    // The time limit is checked before each turn, after the tools the last turn asked for have run.
    if (run.deadline.expired()) {
      timeLimitReached = true;
      stopper.abort();
    } else {
      // Strands calls this before every attempt. A failure it is now retrying is not how the run
      // ended; its error step stays in the record.
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
        // Stopped by this file, at the time limit or on an unsettled write. Not a model failure.
        return;
      }
      if (timer.aborted) {
        // The run's time ran out while the model was still being asked. The hand-written loop
        // gives a model request only the time the run has left, and reports it the same way.
        modelFailed = modelDidNotAnswerWithin(turnAllowanceMs);
        recordError(run, modelFailed, startedAt, durationMs);
        return;
      }
      if (event.error instanceof MaxTokensError) {
        // Strands hands over what the model had written when its output allowance ran out.
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
        if (askAgainWithoutThinking({ wroteNothing: written.trim() === '', ranOutOfOutput: true, thinking })) {
          thinking = false;
          // The Responses API's own setting for how much the model reasons before it answers.
          model.updateConfig({ params: { ...params, reasoning: { effort: 'none' } } });
          event.retry = true;
          return;
        }
        ranOutOfOutput = true;
        cutOff = written.trim() !== '';
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
      tool_calls: said.content
        .filter((block) => block.type === 'toolUseBlock')
        .map((block) => ({ name: block.name, arguments: block.input })),
      input_tokens: said.metadata?.usage?.inputTokens ?? null,
      output_tokens: said.metadata?.usage?.outputTokens ?? null,
    });
    lastReply = text.trim();
  });

  agent.addHook(BeforeToolCallEvent, (event) => {
    const { name, toolUseId, input } = event.toolUse;
    if (stopper.signal.aborted) {
      // The run is being stopped. Nothing more is called.
      event.cancel = true;
      return;
    }
    if (event.tool === undefined || attempts.has(toolUseId)) {
      // An unknown tool is Strands' to answer. A repeat by this code was already allowed once.
      callStarted.set(toolUseId, run.now());
      return;
    }
    const refusal = refusalBeforeCall(run, name, input);
    if (refusal !== undefined) {
      refused.set(toolUseId, refusal);
      event.cancel = JSON.stringify(refusal);
      return;
    }
    callStarted.set(toolUseId, run.now());
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    const { name, toolUseId, input } = event.toolUse;

    const refusal = refused.get(toolUseId);
    if (refusal !== undefined) {
      recordNotCalled(run, name, input, refusal);
      return;
    }
    if (stopper.signal.aborted && !outcomes.has(toolUseId)) {
      // Cancelled above because the run is being stopped.
      return;
    }
    if (event.tool === undefined) {
      // Strands found no such tool and told the model so in its own words.
      const told = event.result.content.find((block) => block.type === 'textBlock');
      recordNotCalled(run, name, input, { error: 'unknown_tool', detail: told?.text ?? '' });
      return;
    }
    const outcome = outcomes.get(toolUseId);
    if (outcome === undefined) {
      // The tool never ran: the run was stopped first.
      return;
    }
    outcomes.delete(toolUseId);

    const attempt = (attempts.get(toolUseId) ?? 0) + 1;
    attempts.set(toolUseId, attempt);
    const started = callStarted.get(toolUseId) ?? run.now();
    recordToolCall(run, {
      tool: name,
      requestedBy: attempt === 1 ? 'model' : 'agent',
      args: input,
      outcome,
      startedAt: started.toISOString(),
      durationMs: Math.max(0, run.now().getTime() - started.getTime()),
    });

    const next = afterCall(run, name, outcome, attempt);
    if (next === 'repeat' && (timer.aborted || stopper.signal.aborted)) {
      // Strands is already stopping the run, so the repeat will not be made.
      unsettledWithoutRepeat(run, name);
      return;
    }
    if (next === 'repeat') {
      event.retry = true;
    }
    if (next === 'unsettled') {
      stopper.abort();
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

  if (run.unsettled !== undefined) {
    return failed(run, run.unsettled);
  }
  if (modelFailed !== undefined) {
    return failed(run, modelFailed);
  }
  if (timeLimitReached || timer.aborted) {
    return stoppedAtTimeLimit(run);
  }
  if (ranOutOfOutput) {
    return cutOff ? stoppedCutOff(run) : stoppedWithoutReply(run, 'maxTokens');
  }
  if (result === undefined) {
    const reason = `Strands stopped the run with ${threw instanceof Error ? threw.name : 'an error'}.`;
    recordError(run, reason);
    return failed(run, reason);
  }
  if (result.stopReason === 'limitTurns') {
    return stoppedAtTurnLimit(run);
  }
  if (result.stopReason === 'endTurn' && lastReply !== '') {
    return completed(run, lastReply);
  }
  return stoppedWithoutReply(run, result.stopReason);
}
