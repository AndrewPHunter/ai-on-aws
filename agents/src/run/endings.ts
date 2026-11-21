// How a run ends, for every agent. An ending takes the run's citations and case actions from the run it is
// given: an agent with citations and no cases, and one with cases and no citations, share this one copy.

import type { CaseAction, Citation, InvocationResponse } from '../../../shared/agent-contract.ts';
import type { RunState } from './state.ts';

export type EndableRun = RunState & { citations: Citation[]; caseActions: CaseAction[] };

function ended(run: EndableRun, outcome: InvocationResponse['outcome'], stopReason: string | null, reply: string): InvocationResponse {
  return {
    agent: run.identity,
    outcome,
    stop_reason: stopReason,
    reply,
    citations: run.citations,
    case_actions: run.caseActions,
    steps: run.steps,
  };
}

export function completed(run: EndableRun, reply: string): InvocationResponse {
  return ended(run, 'completed', null, reply);
}

export function stoppedAtTimeLimit(run: EndableRun): InvocationResponse {
  return ended(run, 'stopped', `The run reached its time limit of ${Math.round(run.limits.runMs / 1000)} s.`, '');
}

export function stoppedAtTurnLimit(run: EndableRun): InvocationResponse {
  return ended(run, 'stopped', `The run reached its limit of ${run.limits.maxTurns} turns with the model.`, '');
}

// An empty reply is not an answer.
export function stoppedWithoutReply(run: EndableRun, finishReason: string): InvocationResponse {
  return ended(run, 'stopped', `The model ended its turn (${finishReason}) without writing a reply.`, '');
}

// The reply was cut off at the output allowance and the loop was given no text to return.
export function stoppedCutOff(run: EndableRun): InvocationResponse {
  return ended(run, 'stopped', 'The model reached its output allowance part way through its reply, and the reply was not returned.', '');
}

// The run stopped for a reason of the agent's own, written by the agent's code. It carries no reply.
export function stopped(run: EndableRun, reason: string): InvocationResponse {
  return ended(run, 'stopped', reason, '');
}

// The run could not go on. It never carries a reply: a failed run has nothing it can vouch for.
export function failed(run: EndableRun, reason: string): InvocationResponse {
  return ended(run, 'failed', reason, '');
}
