// One run of the intake agent: what it keeps, the rules it applies to tool calls, what it records,
// and how it ends. Shared by both implementations. Each has its own loop (one written by hand, one
// that is Strands') and comes here at the same points, so the two cannot drift apart on a rule:
//
//   before a tool call   refusalBeforeCall   may this call be made at all?
//   after each attempt   afterCall           is it settled, repeated once by code, or unknown?
//   after a model turn   askAgainWithoutThinking
//   at the end           completed, stoppedAt..., failed
//
// Nothing here calls a model or a tool.

import type { CaseAction, InvocationResponse, Step } from '../../../shared/agent-contract.ts';
import type { AgentIdentity } from '../contract/server.ts';
import { Deadline } from '../run/record.ts';
import { WRITING_TOOLS, caseActionFrom } from '../tools/case-system.ts';
import type { ToolOutcome } from '../tools/tool-set.ts';

export type Limits = {
  // Model turns in one run.
  maxTurns: number;
  // Time for the whole run. Kept below what the caller will wait, so the caller hears how it ended.
  runMs: number;
  modelMs: number;
  toolMs: number;
};

export type IntakeRun = {
  identity: AgentIdentity;
  now: () => Date;
  limits: Limits;
  deadline: Deadline;
  steps: Step[];
  caseActions: CaseAction[];
  // The case this run opened, or found already open for this message.
  openedCaseId: string | undefined;
  // Set when a write may or may not have happened and that could not be settled.
  unsettled: string | undefined;
};

export function startRun(identity: AgentIdentity, now: () => Date, limits: Limits): IntakeRun {
  return {
    identity,
    now,
    limits,
    deadline: new Deadline(now, limits.runMs),
    steps: [],
    caseActions: [],
    openedCaseId: undefined,
    unsettled: undefined,
  };
}

// --- Rules -------------------------------------------------------------------------------------------

// A call the agent's code will not make, and what the model is told instead.
export type Refusal = { error: string; detail: string };

function caseIdIn(args: unknown): unknown {
  return typeof args === 'object' && args !== null ? Reflect.get(args, 'case_id') : undefined;
}

// Before a call the model asked for. One message opens at most one case, at one version: once this
// run has a case, a second create_case and a follow-up to that same case are refused.
export function refusalBeforeCall(run: IntakeRun, tool: string, args: unknown): Refusal | undefined {
  if (run.openedCaseId === undefined) {
    return undefined;
  }
  if (tool === 'create_case') {
    return {
      error: 'case_already_opened_in_this_run',
      detail: `Case ${run.openedCaseId} was already opened from this message. A message opens one case.`,
    };
  }
  if (tool === 'add_follow_up' && caseIdIn(args) === run.openedCaseId) {
    return {
      error: 'follow_up_to_case_opened_in_this_run',
      detail: `Case ${run.openedCaseId} was opened from this same message, so there is nothing later to add to it.`,
    };
  }
  return undefined;
}

// What the loop does next after one attempt at a call.
//   done       the model is told what came back.
//   repeat     a write did not answer, so it may or may not have happened. The agent's code repeats
//              it once with exactly the same content: if the first attempt went through, the case
//              system says so and creates nothing. The model is not asked, because a model rewords.
//   unsettled  the repeat did not answer either. Whether the case was recorded is not known, and
//              the run must fail without composing a reply.
export type AfterCall = 'done' | 'repeat' | 'unsettled';

export function afterCall(run: IntakeRun, tool: string, outcome: ToolOutcome, attempt: number): AfterCall {
  if (outcome.kind === 'answered') {
    noteCaseAction(run, tool, outcome);
    return 'done';
  }
  if (!WRITING_TOOLS.includes(tool)) {
    return 'done';
  }
  if (attempt === 1) {
    return 'repeat';
  }
  run.unsettled = `The case system did not answer ${tool}, twice. Whether the case was recorded is not known.`;
  return 'unsettled';
}

// A write that got no answer and cannot be repeated, because the run's time has run out, is as
// unsettled as one that was repeated in vain.
export function unsettledWithoutRepeat(run: IntakeRun, tool: string): void {
  run.unsettled = `The case system did not answer ${tool}, and the run's time ran out before it could be repeated. Whether the case was recorded is not known.`;
}

function noteCaseAction(run: IntakeRun, tool: string, outcome: ToolOutcome): void {
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

// This model can redraft a two-sentence reply in its head until the turn's output allowance is gone,
// and then answer nothing. Such a turn is asked again once, with thinking off for the rest of the run.
export function askAgainWithoutThinking(turn: { wroteNothing: boolean; ranOutOfOutput: boolean; thinking: boolean }): boolean {
  return turn.wroteNothing && turn.ranOutOfOutput && turn.thinking;
}

// --- What the model is told about a call -----------------------------------------------------------

export function toldAbout(outcome: ToolOutcome): string {
  return JSON.stringify(outcome.kind === 'answered' ? outcome.payload : { error: 'no_answer', detail: outcome.reason });
}

// --- The record ------------------------------------------------------------------------------------

export function recordToolCall(
  run: IntakeRun,
  call: {
    tool: string;
    requestedBy: 'model' | 'agent';
    args: unknown;
    outcome: ToolOutcome;
    startedAt: string;
    durationMs: number;
  },
): void {
  const { outcome } = call;
  run.steps.push({
    kind: 'tool',
    started_at: call.startedAt,
    duration_ms: call.durationMs,
    tool: call.tool,
    requested_by: call.requestedBy,
    arguments: call.args,
    result: outcome.kind === 'answered' ? outcome.payload : { error: 'no_answer', detail: outcome.reason },
    is_error: outcome.kind === 'no_answer' || outcome.isError,
  });
}

// A call that was asked for and not made, with what the model was told instead.
export function recordNotCalled(run: IntakeRun, tool: string, args: unknown, told: unknown): void {
  run.steps.push({
    kind: 'tool',
    started_at: run.now().toISOString(),
    duration_ms: 0,
    tool,
    requested_by: 'model',
    arguments: args,
    result: told,
    is_error: true,
  });
}

// Records a refusal and returns it as the text the model is told.
export function recordRefusal(run: IntakeRun, tool: string, args: unknown, refusal: Refusal): string {
  recordNotCalled(run, tool, args, refusal);
  return JSON.stringify(refusal);
}

export function recordError(run: IntakeRun, message: string, startedAt?: string, durationMs = 0): void {
  run.steps.push({ kind: 'error', started_at: startedAt ?? run.now().toISOString(), duration_ms: durationMs, message });
}

// --- How a run ends --------------------------------------------------------------------------------

function ended(run: IntakeRun, outcome: InvocationResponse['outcome'], stopReason: string | null, reply: string): InvocationResponse {
  return {
    agent: run.identity,
    outcome,
    stop_reason: stopReason,
    reply,
    citations: [],
    case_actions: run.caseActions,
    steps: run.steps,
  };
}

export function completed(run: IntakeRun, reply: string): InvocationResponse {
  return ended(run, 'completed', null, reply);
}

export function stoppedAtTimeLimit(run: IntakeRun): InvocationResponse {
  return ended(run, 'stopped', `The run reached its time limit of ${Math.round(run.limits.runMs / 1000)} s.`, '');
}

export function stoppedAtTurnLimit(run: IntakeRun): InvocationResponse {
  return ended(run, 'stopped', `The run reached its limit of ${run.limits.maxTurns} turns with the model.`, '');
}

// An empty reply is not an answer.
export function stoppedWithoutReply(run: IntakeRun, finishReason: string): InvocationResponse {
  return ended(run, 'stopped', `The model ended its turn (${finishReason}) without writing a reply.`, '');
}

// The reply was cut off at the output allowance and the loop was given no text to return.
export function stoppedCutOff(run: IntakeRun): InvocationResponse {
  return ended(run, 'stopped', 'The model reached its output allowance part way through its reply, and the reply was not returned.', '');
}

// The run could not go on. It never carries a reply: a failed run has nothing it can vouch for.
export function failed(run: IntakeRun, reason: string): InvocationResponse {
  return ended(run, 'failed', reason, '');
}
