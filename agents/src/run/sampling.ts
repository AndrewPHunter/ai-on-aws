// What every request to the model carries. The seed and a temperature of 0 make a run repeatable
// as far as the model server allows.
export const SAMPLING = { temperature: 0, maxTokens: 2048, seed: 20261120 } as const;
