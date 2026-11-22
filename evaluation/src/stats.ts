// The statistics every figure is reported with: a share with its 95% Wilson interval, the exact two-sided sign test,
// and nearest-rank percentiles. Pure functions.

// Below this many items a share is marked as too few to read.
export const TOO_FEW = 20;
const Z = 1.959963984540054;

export type Share = {
  numerator: number;
  denominator: number;
  // Null when there is nothing to divide by.
  share: number | null;
  // The 95% Wilson score interval; null when the denominator is 0.
  low: number | null;
  high: number | null;
  tooFew: boolean;
};

export function wilson(numerator: number, denominator: number): Share {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error('a share needs whole numbers with 0 <= numerator <= denominator');
  }
  if (denominator === 0) return { numerator, denominator, share: null, low: null, high: null, tooFew: true };
  const p = numerator / denominator;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * denominator)) / (1 + z2 / denominator);
  const half = (Z / (1 + z2 / denominator)) * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator));
  return {
    numerator,
    denominator,
    share: p,
    // At 0 of n and n of n the interval reaches the bound exactly; arithmetic alone leaves it a hair short.
    low: numerator === 0 ? 0 : Math.max(0, centre - half),
    high: numerator === denominator ? 1 : Math.min(1, centre + half),
    tooFew: denominator < TOO_FEW,
  };
}

// The exact two-sided sign test on the discordant counts: the probability, if A and B were equally good, of a split
// at least as uneven as onlyA against onlyB.
export function signTest(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB;
  if (n === 0) return 1;
  const k = Math.min(onlyA, onlyB);
  // Sum of C(n, i) / 2^n for i <= k, computed in logarithms to stay exact enough for large n.
  let logChoose = 0;
  let total = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    total += Math.exp(logChoose - n * Math.LN2);
  }
  return Math.min(1, 2 * total);
}

// Nearest-rank percentile; null for no values.
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

export function formatShare(share: Share): string {
  if (share.share === null) return `0 of 0`;
  const pct = (value: number | null): string => (value === null ? '-' : `${(value * 100).toFixed(1)}%`);
  return `${share.numerator} of ${share.denominator} = ${pct(share.share)} [${pct(share.low)}, ${pct(share.high)}]${share.tooFew ? ' (too few to read)' : ''}`;
}
