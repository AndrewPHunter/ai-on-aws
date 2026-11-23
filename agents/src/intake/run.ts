// One run of the intake agent: what it keeps beyond what every run keeps, and the rules it applies to tool
// calls. Shared by both implementations. Each has its own loop (one written by hand, one that is Strands')
// and comes here at the same points, so the two cannot drift apart on a rule:
//
//   before a tool call   refusalBeforeCall   may this call be made at all?
//   after each attempt   afterCall           is it settled, repeated once by code, or unknown?
//   at the model's reply afterReply          may the run end completed, or not yet, or not at all?
//
// What every agent records, how a turn is asked again, and how a run ends are in ../run/: steps.ts,
// turns.ts and endings.ts. Nothing here calls a model or a tool.

import type { CaseAction, Citation, InvocationResponse, ReportFinding } from '../../../shared/agent-contract.ts';
import type { AgentIdentity } from '../contract/server.ts';
import type { Limits } from '../run/limits.ts';
import { startRunState } from '../run/state.ts';
import type { RunState } from '../run/state.ts';
import type { Refusal } from '../run/steps.ts';
import { caseActionFrom } from '../tools/case-system.ts';
import type { ToolOutcome } from '../tools/tool-set.ts';

export type IntakeRun = RunState & {
  // The intake agent cites nothing: its reply is an acknowledgement, not an answer from a source.
  citations: Citation[];
  caseActions: CaseAction[];
  // The case this run opened, or found already open for this message.
  openedCaseId: string | undefined;
  // Set when a write may or may not have happened and that could not be settled.
  unsettled: string | undefined;
  // What the report check found (report-check.ts), once it has been made. It is made at most once in a run.
  finding: ReportFinding | undefined;
  // Whether the model has been told, by code, to record what the report check found.
  told: boolean;
};

export function startRun(identity: AgentIdentity, now: () => Date, limits: Limits): IntakeRun {
  return {
    ...startRunState(identity, now, limits),
    citations: [],
    caseActions: [],
    openedCaseId: undefined,
    unsettled: undefined,
    finding: undefined,
    told: false,
  };
}

// --- Rules -------------------------------------------------------------------------------------------

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
// Every tool the model is shown writes (CASE_TOOLS in ../tools/case-system.ts), so a call with no answer
// is always a write whose outcome is unknown.
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

// --- At the model's reply ----------------------------------------------------------------------------

// The turn the model is given, written by code, when the report check found an adverse event and no case was
// recorded.
export const TOLD_ONCE =
  "This desk's own check of the message found that it describes an adverse event. A sender cannot decline a report. Record it now with create_case, passing only what the message states.";

export const STOPPED_FOUND_NOT_RECORDED =
  'A separate check of the message found an adverse event, and the run recorded no case. A person must read this message.';
export const STOPPED_CHECK_NOT_MADE = 'The run recorded no case, and the separate check for an adverse event could not be made.';

// What a loop does when the model has ended its turn with a reply.
//   complete   the run ends completed with the reply.
//   check      the report check is needed and has not been made: make it, keep the finding on the run, ask again.
//   tell_once  the model is given TOLD_ONCE as one more turn. The loop sets `told`.
//   stop       the run ends stopped with the reason.
// A run that recorded a case is complete without a check.
export type AfterReply = 'complete' | 'check' | 'tell_once' | { stop: string };

export function afterReply(run: Pick<IntakeRun, 'caseActions' | 'finding' | 'told'>): AfterReply {
  if (run.caseActions.length > 0) {
    return 'complete';
  }
  switch (run.finding) {
    case undefined:
      return 'check';
    case 'none':
      return 'complete';
    case 'unknown':
      return { stop: STOPPED_CHECK_NOT_MADE };
    case 'adverse_event':
      return run.told ? { stop: STOPPED_FOUND_NOT_RECORDED } : 'tell_once';
  }
}

// Applied where each handler returns its ending. A run whose report check found an adverse event and that ends
// stopped with no case, whatever stopped it (the turn limit, the time limit, a reply written after being told),
// ends with the sentence that says a person must read the message. A failed run is left as it is.
export function holdingToFinding(run: IntakeRun, ending: InvocationResponse): InvocationResponse {
  const found = run.finding === 'adverse_event' && run.caseActions.length === 0;
  return found && ending.outcome === 'stopped' ? { ...ending, stop_reason: STOPPED_FOUND_NOT_RECORDED } : ending;
}
