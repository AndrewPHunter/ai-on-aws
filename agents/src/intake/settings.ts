// The limits both implementations of the intake agent run with. One copy, so a comparison between the two is
// never a comparison between two sets of settings. What every request to the model carries is in
// ../run/sampling.ts.

import type { Limits } from '../run/limits.ts';

// The client waits 180 s for an agent. The run stops itself well inside that.
export const LIMITS: Limits = { maxTurns: 6, runMs: 150_000, modelMs: 90_000, toolMs: 10_000 };
