// The numbers the orchestrator runs with. One copy of each.

import type { Limits } from '../run/limits.ts';

// The client waits 295 s for the orchestrator. The run stops itself inside that.
//   maxTurns  model turns in a run
//   runMs     the whole run
//   modelMs   each model request
//   toolMs    each call to a sub-agent, its token exchange included: the sub-agent's own 150 s, and the round trip
// A question is put only while the run has toolMs plus callMarginMs left, so a round starts no later than
// runMs - toolMs - callMarginMs, 120 s, into the run (derived), and a call that was started always ends, and is
// recorded, before the run's own timer fires.
export const ORCHESTRATOR_LIMITS: Limits = { maxTurns: 3, runMs: 280_000, modelMs: 30_000, toolMs: 155_000 };

export type OrchestratorSettings = {
  // Label questions put from one model turn.
  questionsPerRound: number;
  // Model turns whose questions are put.
  rounds: number;
  // Time the run must have left beyond a call's own limit for a question to be put.
  callMarginMs: number;
};

export const ORCHESTRATOR_SETTINGS: OrchestratorSettings = { questionsPerRound: 2, rounds: 2, callMarginMs: 5_000 };
