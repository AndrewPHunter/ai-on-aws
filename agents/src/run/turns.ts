// What a loop decides about a model turn that every agent decides the same way.

// This model can redraft a two-sentence reply in its head until the turn's output allowance is gone,
// and then answer nothing. Such a turn is asked again once, with thinking off for the rest of the run.
export function askAgainWithoutThinking(turn: { wroteNothing: boolean; ranOutOfOutput: boolean; thinking: boolean }): boolean {
  return turn.wroteNothing && turn.ranOutOfOutput && turn.thinking;
}
