// The intake agent with its loop written by hand.
//
// The loop is the part a framework would otherwise own: send the conversation and the tools to the
// model, run the tools it asks for, send the results back, and stop when it answers. Writing it here
// puts every decision about a bad tool call, a lost reply and a limit in plain sight. The rules
// themselves are in run.ts, shared with the Strands implementation; this file is where and when
// this loop applies them:
//
//   - A tool the model names that does not exist, or arguments that are not JSON, go back to the
//     model as an error. Nothing is called.
//   - A write whose reply is lost is repeated once, by this code, with identical content. The case
//     system recognises an identical repeat, so the result is one case either way. The model is
//     not asked to retry, because a model rewords.
//   - Once a case is opened in a run, a second create_case, or a follow-up to that same case, is
//     refused here. One message opens at most one case, at one version.
//   - If it is still unknown whether a write happened, the run fails. It does not compose a reply.
//   - If the model spends a whole turn's output allowance thinking and answers nothing, it is asked
//     once more with thinking off. This model can redraft a two-sentence reply in its head until
//     the allowance is gone.
//   - A request to the model that fails in a way that could go differently next time is sent again,
//     up to three times in all, after a short wait. Asking the model changes nothing in the case
//     system, so asking twice is safe. A request that ran out of time is not sent again: a second
//     one would get less time than the first and hold the caller for the rest of the run. Every
//     failed request is in the run's record.
//   - The run has a turn limit and a time limit, and says which one stopped it.

import type { Caller } from '../../../shared/access-token.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import type { AgentIdentity } from '../contract/server.ts';
import type { ChatMessage, ChatModel, ChatResult, ToolCall } from '../model/chat.ts';
import { timed } from '../run/record.ts';
import type { Timed } from '../run/record.ts';
import type { Connected, ToolOutcome, ToolSet } from '../tools/tool-set.ts';
import { SYSTEM_PROMPT, userTurn } from './prompt.ts';
import {
  afterCall,
  askAgainWithoutThinking,
  completed,
  failed,
  recordError,
  recordRefusal,
  recordToolCall,
  refusalBeforeCall,
  startRun,
  stoppedAtTimeLimit,
  stoppedAtTurnLimit,
  stoppedWithoutReply,
  toldAbout,
} from './run.ts';
import type { IntakeRun, Limits } from './run.ts';

export type IntakeDeps = {
  identity: AgentIdentity;
  model: ChatModel;
  // Connects to the case system for one message, passing on the token of the caller it is for.
  connectTools: (message: InboundMessage, callerToken: string, timeoutMs: number) => Promise<Connected>;
  now: () => Date;
  // Waits between two requests to the model. Given, so a test does not wait in real time.
  sleep: (ms: number) => Promise<void>;
  // A number from 0 up to 1, for the length of that wait.
  random: () => number;
  limits: Limits;
};

// How a failed request to the model is sent again.
//
//   attempts     Three requests at most. What this is for is brief: a dropped connection, a server
//                that is restarting, a moment of overload. A fault that outlasts two more tries is
//                not brief, and the caller is better told than kept waiting.
//   firstWaitMs  The wait before the second request is up to half a second, and before the third up
//                to a second. A person waiting on a run of several seconds does not notice either,
//                and a restart or a burst gets a moment to pass.
export const MODEL_RETRY = { attempts: 3, firstWaitMs: 500 } as const;

// The wait before request number `next` (2 or 3). The step doubles each time. The wait is between
// half the step and all of it, by `random`: every run in flight sees the same outage at the same
// moment, and without the spread they would all come back at the same moment too.
export function waitBeforeRequest(next: number, random: number): number {
  const step = MODEL_RETRY.firstWaitMs * 2 ** (next - 2);
  return Math.round(step / 2 + (random * step) / 2);
}

function argumentsOf(call: ToolCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : undefined;
  } catch {
    return undefined;
  }
}

// Calls the case system once and records the step.
async function callOnce(
  run: IntakeRun,
  tools: ToolSet,
  tool: string,
  args: Record<string, unknown>,
  requestedBy: 'model' | 'agent',
): Promise<ToolOutcome> {
  const call = await timed(run.now, () => tools.call(tool, args, run.deadline.within(run.limits.toolMs)));
  recordToolCall(run, { tool, requestedBy, args, outcome: call.value, startedAt: call.started_at, durationMs: call.duration_ms });
  return call.value;
}

// Runs one tool call the model asked for and returns what the model is told about it.
async function runToolCall(run: IntakeRun, tools: ToolSet, call: ToolCall): Promise<string> {
  const tool = call.function.name;
  const known = tools.definitions.map((definition) => definition.function.name);

  // These two are this loop's own: a framework's loop decides them for itself.
  if (!known.includes(tool)) {
    return recordRefusal(run, tool, call.function.arguments, {
      error: 'unknown_tool',
      detail: `There is no tool ${tool}. The tools are ${known.join(', ')}.`,
    });
  }
  const args = argumentsOf(call);
  if (args === undefined) {
    return recordRefusal(run, tool, call.function.arguments, {
      error: 'arguments_not_json',
      detail: 'The arguments were not a JSON object. Nothing was called.',
    });
  }

  const refusal = refusalBeforeCall(run, tool, args);
  if (refusal !== undefined) {
    return recordRefusal(run, tool, args, refusal);
  }

  const first = await callOnce(run, tools, tool, args, 'model');
  if (afterCall(run, tool, first, 1) !== 'repeat') {
    return toldAbout(first);
  }
  const second = await callOnce(run, tools, tool, args, 'agent');
  afterCall(run, tool, second, 2);
  return toldAbout(second);
}

// Asks the model for one turn, sending the request again where that could help. Every failed
// request is recorded. What is returned is the answer, or the last failure.
async function askModel(
  run: IntakeRun,
  deps: IntakeDeps,
  conversation: ChatMessage[],
  tools: ToolSet,
  thinking: boolean,
): Promise<Timed<ChatResult>> {
  for (let request = 1; ; request++) {
    const asked = await timed(run.now, () =>
      deps.model.complete(conversation, tools.definitions, { timeoutMs: run.deadline.within(run.limits.modelMs), thinking }),
    );
    if (asked.value.ok) {
      return asked;
    }
    recordError(run, asked.value.reason, asked.started_at, asked.duration_ms);
    if (!asked.value.retryable || request === MODEL_RETRY.attempts) {
      return asked;
    }
    const waitMs = waitBeforeRequest(request + 1, deps.random());
    if (waitMs >= run.deadline.remainingMs()) {
      // The run's time would be gone before the next request could be sent.
      return asked;
    }
    await deps.sleep(waitMs);
  }
}

export async function handleInquiry(deps: IntakeDeps, message: InboundMessage, caller: Caller): Promise<InvocationResponse> {
  const run = startRun(deps.identity, deps.now, deps.limits);

  const connected = await deps.connectTools(message, caller.token, run.deadline.within(deps.limits.toolMs));
  if (!connected.ok) {
    recordError(run, connected.reason);
    return failed(run, connected.reason);
  }

  try {
    return await loop(run, deps, connected.tools, message);
  } finally {
    await connected.tools.close();
  }
}

async function loop(run: IntakeRun, deps: IntakeDeps, tools: ToolSet, message: InboundMessage): Promise<InvocationResponse> {
  const { deadline, limits } = run;
  const { model } = deps;
  const conversation: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userTurn(message) },
  ];

  // Thinking is on until a turn is lost to it; then it stays off for the rest of the run.
  let thinking = true;

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    if (deadline.expired()) {
      return stoppedAtTimeLimit(run);
    }

    // A request that is sent again is still the same turn.
    const asked = await askModel(run, deps, conversation, tools, thinking);
    if (!asked.value.ok) {
      return failed(run, asked.value.reason);
    }
    const { completion } = asked.value;
    run.steps.push({
      kind: 'model',
      started_at: asked.started_at,
      duration_ms: asked.duration_ms,
      model: model.id,
      finish_reason: completion.finishReason,
      text: completion.content,
      tool_calls: completion.toolCalls.map((call) => ({
        name: call.function.name,
        arguments: argumentsOf(call) ?? call.function.arguments,
      })),
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
    });

    if (completion.toolCalls.length === 0) {
      const reply = completion.content?.trim() ?? '';
      if (askAgainWithoutThinking({ wroteNothing: reply === '', ranOutOfOutput: completion.finishReason === 'length', thinking })) {
        thinking = false;
        continue;
      }
      if (reply === '') {
        return stoppedWithoutReply(run, completion.finishReason);
      }
      return completed(run, reply);
    }

    // Every call the model made gets an answer, in order, before the model is asked again.
    conversation.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      const told = await runToolCall(run, tools, call);
      conversation.push({ role: 'tool', tool_call_id: call.id, content: told });
      if (run.unsettled !== undefined) {
        return failed(run, run.unsettled);
      }
    }
  }

  return stoppedAtTurnLimit(run);
}
