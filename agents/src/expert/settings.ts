// The numbers the label expert runs with. One copy of each.

import type { Limits } from '../run/limits.ts';

// The client waits 180 s for an agent. The run stops itself well inside that.
export const EXPERT_LIMITS: Limits = { maxTurns: 8, runMs: 150_000, modelMs: 90_000, toolMs: 10_000 };

// The model's output allowance for one turn. A structured final answer was measured at up to 1,232 output
// tokens, and one ran out at 2,048, so this agent allows twice that.
export const OUTPUT_ALLOWANCE = 4096;

// Characters of each passage's text kept in a retrieval step's record, for a reader of the record. The model is
// shown whole passages; this is only the excerpt recorded.
export const EXCERPT_CHARACTERS = 300;

export type SearchSettings = {
  // Searches the model may have made in one run. Enforced in code: the model was seen to ignore a limit in
  // its prompt.
  maxSearches: number;
  // Passages asked for in each search.
  resultsPerSearch: number;
  // Characters of passage text the model is shown in one run, whole passages only.
  readingAllowance: number;
};

export type AnswerSettings = {
  maxStatements: number;
  quoteMinCharacters: number;
  quoteMaxCharacters: number;
  // How many times the model is told what was wrong with its answer before the run stops.
  maxCorrections: number;
};

export type ExpertSettings = { search: SearchSettings; answer: AnswerSettings };

export const EXPERT_SETTINGS: ExpertSettings = {
  search: {
    maxSearches: 4,
    resultsPerSearch: 5,
    // At the worst rate measured, 0.75 tokens a character, 30,000 characters is about 22,500 tokens: inside
    // the model's 32,768-token context with room for the 4,096 output allowance, the prompt and the turns.
    readingAllowance: 30_000,
  },
  answer: { maxStatements: 8, quoteMinCharacters: 15, quoteMaxCharacters: 600, maxCorrections: 2 },
};
