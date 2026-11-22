// The limits one run of an agent works within. Each agent sets its own values.

export type Limits = {
  // Model turns in one run.
  maxTurns: number;
  // Time for the whole run. Kept below what the caller will wait, so the caller hears how it ended.
  runMs: number;
  modelMs: number;
  toolMs: number;
};
