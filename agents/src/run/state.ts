// The state every agent's run keeps, whatever else the agent adds to it: who is running, the clock, the
// limits, the deadline they give, and the steps recorded so far.

import type { Step } from '../../../shared/agent-contract.ts';
import type { AgentIdentity } from '../contract/server.ts';
import type { Limits } from './limits.ts';
import { Deadline } from './record.ts';

export type RunState = {
  identity: AgentIdentity;
  now: () => Date;
  limits: Limits;
  deadline: Deadline;
  steps: Step[];
};

export function startRunState(identity: AgentIdentity, now: () => Date, limits: Limits): RunState {
  return { identity, now, limits, deadline: new Deadline(now, limits.runMs), steps: [] };
}
