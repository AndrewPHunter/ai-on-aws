// The intake agent with its loop written by hand.
//
// The loop is the part a framework would otherwise own: send the conversation and the tools to the
// model, run the tools it asks for, send the results back, and stop when it answers. Writing it here
// puts every decision about a bad tool call, a lost reply and a limit in plain sight:
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
//   - The run has a turn limit and a time limit, and says which one stopped it.

import type { CaseAction, InboundMessage, InvocationResponse, Step } from '../../../shared/agent-contract.ts';
import type { AgentIdentity } from '../contract/server.ts';
import type { ChatMessage, ChatModel, ToolCall } from '../model/chat.ts';
import { Deadline, errorStep, timed } from '../run/record.ts';
import { WRITING_TOOLS, caseActionFrom } from '../tools/case-system.ts';
import type { Connected, ToolOutcome, ToolSet } from '../tools/tool-set.ts';
import { SYSTEM_PROMPT, userTurn } from './prompt.ts';

export type Limits = {
  // Model turns in one run.
  maxTurns: number;
  // Time for the whole run. Kept below what the caller will wait, so the caller hears how it ended.
  runMs: number;
  modelMs: number;
  toolMs: number;
};

export type IntakeDeps = {
  identity: AgentIdentity;
  model: ChatModel;
  connectTools: (message: InboundMessage, timeoutMs: number) => Promise<Connected>;
  now: () => Date;
  limits: Limits;
};

type Run = {
  deps: IntakeDeps;
  tools: ToolSet;
  deadline: Deadline;
  steps: Step[];
  caseActions: CaseAction[];
  // The case this run opened, or found already open for this message.
  openedCaseId: string | undefined;
  // Set when a write may or may not have happened and that could not be settled.
  unsettled: string | undefined;
};

function finish(
  run: { deps: IntakeDeps; steps: Step[]; caseActions: CaseAction[] },
  outcome: InvocationResponse['outcome'],
  stopReason: string | null,
  reply: string,
): InvocationResponse {
  return {
    agent: run.deps.identity,
    outcome,
    stop_reason: stopReason,
    reply,
    citations: [],
    case_actions: run.caseActions,
    steps: run.steps,
  };
}

function argumentsOf(call: ToolCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : undefined;
  } catch {
    return undefined;
  }
}

function note(run: Run, tool: string, outcome: ToolOutcome): void {
  const action = caseActionFrom(tool, outcome);
  if (action === undefined) {
    return;
  }
  if (!run.caseActions.some((seen) => seen.kind === action.kind && seen.case_id === action.case_id)) {
    run.caseActions.push(action);
  }
  if (tool === 'create_case') {
    run.openedCaseId = action.case_id;
  }
}

// Calls the case system once and records the step.
async function callOnce(
  run: Run,
  tool: string,
  args: Record<string, unknown>,
  requestedBy: 'model' | 'agent',
): Promise<ToolOutcome> {
  const call = await timed(run.deps.now, () => run.tools.call(tool, args, run.deadline.within(run.deps.limits.toolMs)));
  const outcome = call.value;
  run.steps.push({
    kind: 'tool',
    started_at: call.started_at,
    duration_ms: call.duration_ms,
    tool,
    requested_by: requestedBy,
    arguments: args,
    result: outcome.kind === 'answered' ? outcome.payload : { error: 'no_answer', detail: outcome.reason },
    is_error: outcome.kind === 'no_answer' || outcome.isError,
  });
  note(run, tool, outcome);
  return outcome;
}

function refused(run: Run, call: ToolCall, args: unknown, error: string, detail: string): string {
  const result = { error, detail };
  run.steps.push({
    kind: 'tool',
    started_at: run.deps.now().toISOString(),
    duration_ms: 0,
    tool: call.function.name,
    requested_by: 'model',
    arguments: args,
    result,
    is_error: true,
  });
  return JSON.stringify(result);
}

// Runs one tool call the model asked for and returns what the model is told about it.
async function runToolCall(run: Run, call: ToolCall): Promise<string> {
  const tool = call.function.name;
  const known = run.tools.definitions.map((definition) => definition.function.name);

  if (!known.includes(tool)) {
    return refused(run, call, call.function.arguments, 'unknown_tool', `There is no tool ${tool}. The tools are ${known.join(', ')}.`);
  }
  const args = argumentsOf(call);
  if (args === undefined) {
    return refused(run, call, call.function.arguments, 'arguments_not_json', 'The arguments were not a JSON object. Nothing was called.');
  }
  if (tool === 'create_case' && run.openedCaseId !== undefined) {
    return refused(run, call, args, 'case_already_opened_in_this_run', `Case ${run.openedCaseId} was already opened from this message. A message opens one case.`);
  }
  if (tool === 'add_follow_up' && run.openedCaseId !== undefined && args['case_id'] === run.openedCaseId) {
    return refused(run, call, args, 'follow_up_to_case_opened_in_this_run', `Case ${run.openedCaseId} was opened from this same message, so there is nothing later to add to it.`);
  }

  const first = await callOnce(run, tool, args, 'model');
  if (first.kind === 'answered') {
    return JSON.stringify(first.payload);
  }
  if (!WRITING_TOOLS.includes(tool)) {
    return JSON.stringify({ error: 'no_answer', detail: first.reason });
  }

  // A write did not answer, so it may or may not have happened. Repeat it once with exactly the
  // same content: if the first attempt went through, the case system says so and creates nothing.
  const second = await callOnce(run, tool, args, 'agent');
  if (second.kind === 'answered') {
    return JSON.stringify(second.payload);
  }
  run.unsettled = `The case system did not answer ${tool}, twice. Whether the case was recorded is not known.`;
  return JSON.stringify({ error: 'no_answer', detail: second.reason });
}

export async function handleInquiry(deps: IntakeDeps, message: InboundMessage): Promise<InvocationResponse> {
  const start = { deps, steps: [] as Step[], caseActions: [] as CaseAction[] };
  const deadline = new Deadline(deps.now, deps.limits.runMs);

  const connected = await deps.connectTools(message, deadline.within(deps.limits.toolMs));
  if (!connected.ok) {
    start.steps.push(errorStep(deps.now, connected.reason));
    return finish(start, 'failed', connected.reason, '');
  }

  const run: Run = { ...start, tools: connected.tools, deadline, openedCaseId: undefined, unsettled: undefined };
  try {
    return await loop(run, message);
  } finally {
    await run.tools.close();
  }
}

async function loop(run: Run, message: InboundMessage): Promise<InvocationResponse> {
  const { deps, deadline } = run;
  const conversation: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userTurn(message) },
  ];

  // Thinking is on until a turn is lost to it; then it stays off for the rest of the run.
  let thinking = true;

  for (let turn = 1; turn <= deps.limits.maxTurns; turn++) {
    if (deadline.expired()) {
      return finish(run, 'stopped', `The run reached its time limit of ${Math.round(deps.limits.runMs / 1000)} s.`, '');
    }

    const asked = await timed(deps.now, () =>
      deps.model.complete(conversation, run.tools.definitions, {
        timeoutMs: deadline.within(deps.limits.modelMs),
        thinking,
      }),
    );
    if (!asked.value.ok) {
      run.steps.push({ kind: 'error', started_at: asked.started_at, duration_ms: asked.duration_ms, message: asked.value.reason });
      return finish(run, 'failed', asked.value.reason, '');
    }
    const { completion } = asked.value;
    run.steps.push({
      kind: 'model',
      started_at: asked.started_at,
      duration_ms: asked.duration_ms,
      model: deps.model.id,
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
      if (reply === '' && completion.finishReason === 'length' && thinking) {
        // The whole allowance went on thinking. Ask again, this once, without it.
        thinking = false;
        continue;
      }
      if (reply === '') {
        // An empty reply is not an answer.
        return finish(run, 'stopped', `The model ended its turn (${completion.finishReason}) without writing a reply.`, '');
      }
      return finish(run, 'completed', null, reply);
    }

    // Every call the model made gets an answer, in order, before the model is asked again.
    conversation.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      const told = await runToolCall(run, call);
      conversation.push({ role: 'tool', tool_call_id: call.id, content: told });
      if (run.unsettled !== undefined) {
        return finish(run, 'failed', run.unsettled, '');
      }
    }
  }

  return finish(run, 'stopped', `The run reached its limit of ${deps.limits.maxTurns} turns with the model.`, '');
}
