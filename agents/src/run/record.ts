// What both implementations of an agent share when they record a run: a clock for each step and a
// deadline for the whole run. Kept out of the loop so the two loops differ only in how they loop.

import type { Step } from '../../../shared/agent-contract.ts';

export type Timed<Value> = { value: Value; started_at: string; duration_ms: number };

export async function timed<Value>(now: () => Date, work: () => Promise<Value>): Promise<Timed<Value>> {
  const started = now();
  const value = await work();
  return { value, started_at: started.toISOString(), duration_ms: Math.max(0, now().getTime() - started.getTime()) };
}

// How much of the run's time is left. The run has one allowance; each call inside it gets the
// smaller of its own limit and what remains.
export class Deadline {
  private readonly endsAt: number;
  private readonly now: () => Date;

  constructor(now: () => Date, allowanceMs: number) {
    this.now = now;
    this.endsAt = now().getTime() + allowanceMs;
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - this.now().getTime());
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  within(limitMs: number): number {
    return Math.min(limitMs, this.remainingMs());
  }
}

export function errorStep(now: () => Date, message: string): Step {
  return { kind: 'error', started_at: now().toISOString(), duration_ms: 0, message };
}
