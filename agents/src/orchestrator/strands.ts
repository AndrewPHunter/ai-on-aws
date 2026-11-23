// The orchestrator, on Strands.
//
// It takes any inquiry and gets both halves of it done by the agents that each do one. Code sends the message,
// unchanged, to the intake agent on Strands at the start of every run, beside the model's loop and whatever the
// model does. Strands owns the loop: it sends the message's text and one tool, ask_label_expert, to the model,
// runs the calls of one turn together (its default) and stops. This file's code owns everything else:
//
//   - Each call the model makes in a turn is given its id (q1, q2, ...) and decided, in the order of the turn's
//     calls, in the AfterModelCall hook, before any runs (decisions.ts). A question put is one call to the label
//     expert, made when Strands runs the tool, never made again. A question not put is told to the model.
//   - The model reads back, for each question, only what toldToModel gives.
//   - The reply, its citations and its case actions are written by code from the sub-agents' responses
//     (decisions.ts). What the model writes stays in its model steps.
//   - A turn that used up its output allowance having written nothing is asked again, once, with thinking off for
//     the rest of the run, by setting retry in the AfterModelCall hook, as in the intake agent on Strands (the same
//     rule, ../run/turns.ts). Strands does not count that request as a turn: three turns means three turns, each of
//     which may be asked again once this way, all inside the run's time. A turn cut off again ends the loop.
//   - The turn limit is Strands' own (limits.turns). The time limit is a cancel signal this file owns, checked
//     before each model turn; each call to a sub-agent carries its own limit.
//
// Nothing is printed, no history is trimmed, and a new Agent is made for every message, as in the other agents on
// Strands.

import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  Agent,
  BeforeModelCallEvent,
  MaxTokensError,
  NullConversationManager,
  TextBlock,
  Tool,
  ToolResultBlock,
} from '@strands-agents/sdk';
import type { AgentResult, Message, ToolContext, ToolSpec, ToolStreamGenerator } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';

import type { Caller } from '../../../shared/access-token.ts';
import type { DelegationStep, InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import type { TokenExchange } from '../../../shared/token-exchange.ts';
import type { AgentIdentity } from '../contract/server.ts';
import { MODEL_UNREACHABLE, modelAnsweredWithStatus, modelDidNotAnswerWithin } from '../model/served.ts';
import type { ModelSettings } from '../model/served.ts';
import type { Limits } from '../run/limits.ts';
import { startRunState } from '../run/state.ts';
import type { RunState } from '../run/state.ts';
import { recordError, recordNotCalled } from '../run/steps.ts';
import { askAgainWithoutThinking } from '../run/turns.ts';
import { howItEnds, replyWithCitations, toldToModel, whetherPut } from './decisions.ts';
import type { LoopEnd, Question } from './decisions.ts';
import { SYSTEM_PROMPT, userTurn } from './prompt.ts';
import type { OrchestratorSettings } from './settings.ts';
import { EXPERT, INTAKE, callWithToken } from './sub-agents.ts';
import type { CallSubAgent, SubAgent } from './sub-agents.ts';

export type OrchestratorDeps = {
  identity: AgentIdentity;
  // The model's settings, or why the model's name could not be learnt: then no question is asked, and screening
  // still runs.
  model: ModelSettings | { unavailable: string };
  // Exchanges the caller's token for one meant for a sub-agent.
  exchange: TokenExchange;
  callSubAgent: CallSubAgent;
  now: () => Date;
  limits: Limits;
  settings: OrchestratorSettings;
};

const TOOL = 'ask_label_expert';

type OrchestratorRun = RunState & {
  questions: Question[];
  // Each call of the model's to the tool, by its toolUseId, as decided when its turn ended.
  decided: Map<string, Question>;
  // The model's turns that asked a question.
  round: number;
};

// ---------- A call to a sub-agent ----------

async function delegate(
  run: OrchestratorRun,
  deps: OrchestratorDeps,
  callerToken: string,
  call: { to: SubAgent; id: string; requestedBy: 'agent' | 'model'; message: InboundMessage; replaces: string | null },
): Promise<DelegationStep> {
  const started = run.now();
  const answer = await callWithToken(deps, call.to, { message: call.message }, callerToken, run.deadline.within(run.limits.toolMs));
  return {
    kind: 'delegation',
    started_at: started.toISOString(),
    duration_ms: Math.max(0, run.now().getTime() - started.getTime()),
    id: call.id,
    to_agent: call.to.id,
    requested_by: call.requestedBy,
    message: { id: call.message.id, text: call.message.text },
    replaces: call.replaces,
    failure: answer.ok ? null : answer.failure,
    response: answer.ok ? answer.response : null,
  };
}

// ---------- The tool ----------

class AskLabelExpert extends Tool {
  name = TOOL;
  description =
    'Put one question about one medicine to the label expert, which answers it from that medicine\'s approved label. ' +
    "Returns the question's id and the expert's label answer, stop reason and reply, or why the question was not put.";
  toolSpec: ToolSpec = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: "The medicine's name, as the message writes it." },
        question: { type: 'string', description: 'The question about that medicine, in plain words.' },
        replaces: { type: 'string', description: 'The id of an earlier question this one replaces, such as q1. Leave out for a new question.' },
      },
      required: ['drug', 'question'],
    },
  };

  private readonly run: OrchestratorRun;
  private readonly deps: OrchestratorDeps;
  private readonly message: InboundMessage;
  private readonly callerToken: string;

  constructor(run: OrchestratorRun, deps: OrchestratorDeps, message: InboundMessage, callerToken: string) {
    super();
    this.run = run;
    this.deps = deps;
    this.message = message;
    this.callerToken = callerToken;
  }

  async *stream(context: ToolContext): ToolStreamGenerator {
    const { toolUseId, input } = context.toolUse;
    const { run, message } = this;
    const question = run.decided.get(toolUseId);
    if (question === undefined || !question.put) {
      const told = question === undefined ? { error: 'not_taken_up', detail: 'This call was not taken up.' } : toldToModel(question);
      recordNotCalled(run, this.name, input, told);
      return new ToolResultBlock({ toolUseId, status: 'error', content: [new TextBlock(JSON.stringify(told))] });
    }
    const started = run.now();
    const step = await delegate(run, this.deps, this.callerToken, {
      to: EXPERT,
      id: question.id,
      requestedBy: 'model',
      message: { id: `${message.id}.${question.id}`, text: question.text, sender: message.sender, received_at: message.received_at },
      replaces: question.asked.replaces,
    });
    question.call = { failure: step.failure, response: step.response };
    const told = toldToModel(question);
    run.steps.push(
      {
        kind: 'tool',
        started_at: started.toISOString(),
        duration_ms: Math.max(0, run.now().getTime() - started.getTime()),
        tool: this.name,
        requested_by: 'model',
        arguments: input,
        result: told,
        is_error: step.failure !== null,
      },
      step,
    );
    return new ToolResultBlock({ toolUseId, status: step.failure === null ? 'success' : 'error', content: [new TextBlock(JSON.stringify(told))] });
  }
}

// ---------- The model's loop ----------

// A sentence for a person about why the model call failed, as the other agents on Strands write it. Never the
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

// Gives each of a turn's calls to the tool its id and decides it, in the order the model wrote them.
function takeUp(run: OrchestratorRun, deps: OrchestratorDeps, message: InboundMessage, said: Message): void {
  const calls = said.content.filter((block) => block.type === 'toolUseBlock' && block.name === TOOL);
  if (calls.length === 0) return;
  run.round++;
  calls.forEach((block, index) => {
    if (block.type !== 'toolUseBlock') return;
    const id = `q${run.questions.length + 1}`;
    const decision = whetherPut(
      block.input,
      {
        messageText: message.text,
        putIds: run.questions.filter((question) => question.put).map((question) => question.id),
        nthInRound: index + 1,
        round: run.round,
        remainingMs: run.deadline.remainingMs(),
      },
      { ...deps.settings, callMs: run.limits.toolMs },
    );
    const question: Question = decision.put ? { id, put: true, asked: decision.asked, text: decision.text } : { id, put: false, reason: decision.reason };
    run.questions.push(question);
    run.decided.set(block.toolUseId, question);
  });
}

async function converse(run: OrchestratorRun, deps: OrchestratorDeps, settings: ModelSettings, message: InboundMessage, callerToken: string): Promise<LoopEnd> {
  const { limits } = run;
  const params = { seed: settings.seed };
  const model = new OpenAIModel({
    modelId: settings.modelId,
    apiKey: settings.apiKey,
    clientConfig: { baseURL: settings.baseUrl, timeout: limits.modelMs },
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    params,
  });
  const agent = new Agent({
    model,
    tools: [new AskLabelExpert(run, deps, message, callerToken)],
    systemPrompt: SYSTEM_PROMPT,
    conversationManager: new NullConversationManager(),
    printer: false,
  });

  const stopper = new AbortController();
  const timer = AbortSignal.timeout(Math.max(1, run.deadline.remainingMs()));
  let timeLimitReached = false;
  let modelFailed: string | undefined;
  let cutOff = false;
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
      if (stopper.signal.aborted) return;
      if (timer.aborted) {
        modelFailed = modelDidNotAnswerWithin(turnAllowanceMs);
        recordError(run, modelFailed, startedAt, durationMs);
        return;
      }
      if (event.error instanceof MaxTokensError) {
        const written = textOf(event.error.partialMessage);
        run.steps.push({
          kind: 'model',
          started_at: startedAt,
          duration_ms: durationMs,
          model: settings.modelId,
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
        cutOff = true;
        return;
      }
      modelFailed = modelFailure(event.error, limits.modelMs);
      recordError(run, modelFailed, startedAt, durationMs);
      return;
    }
    if (event.stopData === undefined) return;
    const { message: said, stopReason } = event.stopData;
    const text = textOf(said);
    run.steps.push({
      kind: 'model',
      started_at: startedAt,
      duration_ms: durationMs,
      model: settings.modelId,
      finish_reason: stopReason,
      text: text === '' ? null : text,
      tool_calls: said.content.filter((block) => block.type === 'toolUseBlock').map((block) => ({ name: block.name, arguments: block.input })),
      input_tokens: said.metadata?.usage?.inputTokens ?? null,
      output_tokens: said.metadata?.usage?.outputTokens ?? null,
    });
    takeUp(run, deps, message, said);
  });

  agent.addHook(AfterToolCallEvent, (event) => {
    if (event.tool === undefined) {
      // Strands found no such tool and told the model so in its own words.
      const { name, input } = event.toolUse;
      const told = event.result.content.find((block) => block.type === 'textBlock');
      recordNotCalled(run, name, input, { error: 'unknown_tool', detail: told?.text ?? '' });
    }
  });

  let result: AgentResult | undefined;
  let threw: unknown;
  try {
    result = await agent.invoke(userTurn(message), { cancelSignal: AbortSignal.any([stopper.signal, timer]), limits: { turns: limits.maxTurns } });
  } catch (error) {
    threw = error;
  }

  if (modelFailed !== undefined) return { finished: false, reason: modelFailed };
  if (timeLimitReached || timer.aborted) return { finished: false, reason: `The run reached its time limit of ${Math.round(limits.runMs / 1000)} s.` };
  if (cutOff) return { finished: false, reason: 'The model reached its output allowance part way through a turn.' };
  if (result === undefined) {
    const reason = `Strands stopped the run with ${threw instanceof Error ? threw.name : 'an error'}.`;
    recordError(run, reason);
    return { finished: false, reason };
  }
  if (result.stopReason === 'limitTurns') return { finished: false, reason: `The run reached its limit of ${limits.maxTurns} turns with the model.` };
  if (result.stopReason === 'endTurn') return { finished: true };
  return { finished: false, reason: `The model ended its turn (${result.stopReason}).` };
}

// ---------- One message ----------

export async function handleInquiry(deps: OrchestratorDeps, message: InboundMessage, caller: Caller): Promise<InvocationResponse> {
  const run: OrchestratorRun = { ...startRunState(deps.identity, deps.now, deps.limits), questions: [], decided: new Map(), round: 0 };
  // Screening starts first, by code, with the message as it arrived. It never rejects.
  const screening = delegate(run, deps, caller.token, { to: INTAKE, id: 'screening', requestedBy: 'agent', message, replaces: null });

  let loop: LoopEnd;
  if ('unavailable' in deps.model) {
    recordError(run, deps.model.unavailable);
    loop = { finished: false, reason: deps.model.unavailable };
  } else {
    try {
      loop = await converse(run, deps, deps.model, message, caller.token);
    } catch (error) {
      const reason = `The model's loop could not run: ${error instanceof Error ? error.name : 'an error'}.`;
      recordError(run, reason);
      loop = { finished: false, reason };
    }
  }
  const screened = await screening;

  const result = { screening: screened, questions: run.questions, loop };
  const { outcome, stop_reason } = howItEnds(result);
  const { reply, citations } = replyWithCitations(result);
  return {
    agent: deps.identity,
    outcome,
    stop_reason,
    reply,
    citations,
    case_actions: screened.response?.case_actions ?? [],
    steps: [screened, ...run.steps],
  };
}
