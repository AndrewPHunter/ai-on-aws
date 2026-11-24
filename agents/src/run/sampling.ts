// What every request to the model carries: a temperature of 0 and the same seed. They do not make a
// run repeatable: the model server can still answer differently from one run to the next.
export const SAMPLING = { temperature: 0, maxTokens: 2048, seed: 20261120 } as const;
