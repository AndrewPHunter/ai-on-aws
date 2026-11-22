// Wording overlap: how much of a question's wording is found in the benchmark passage it was written from. Pure
// functions.
//
// A question's content words are its distinct words, lower-cased, of three letters or more, that are not in the fixed
// stop-word list below and not a word of the drug's name. A word is a run of letters: digits and other characters
// separate words and are never part of one, so a number is not a content word. The overlap is
// the share of those content words that are also words of the question's benchmark `context` (the text of every entry
// of its `context` list). A question with no content words has no overlap (null) and is counted apart.
//
// Thirds are cut at the sample's own values: of n overlaps sorted, the first cut point is the value at rank ceil(n/3),
// the second the value at rank ceil(2n/3) (nearest rank, counted from 1). A question is in the lowest third when its overlap is at or below the first cut, the middle
// third when above the first and at or below the second, and the highest third when above the second. Ties at a cut
// point fall to the lower third, so the thirds need not be the same size; their sizes are always printed.

export const MIN_WORD_LENGTH = 3;

// English function words of three letters or more. Fixed: a change to it changes every overlap.
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'about', 'above', 'after', 'again', 'against', 'all', 'also', 'among', 'and', 'any', 'are', 'because', 'been',
  'before', 'being', 'below', 'between', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'down', 'during',
  'each', 'either', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'her', 'here', 'hers', 'him',
  'his', 'how', 'into', 'its', 'itself', 'just', 'may', 'might', 'more', 'most', 'must', 'neither', 'nor', 'not',
  'off', 'once', 'only', 'onto', 'other', 'our', 'ours', 'out', 'over', 'own', 'per', 'same', 'shall', 'she',
  'should', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'too', 'under', 'until', 'upon', 'very', 'was', 'were', 'what', 'when', 'where',
  'whether', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'yet',
  'you', 'your', 'yours',
]);

const words = (text: string): string[] => text.toLowerCase().match(/\p{L}+/gu) ?? [];

// The distinct content words of a question, in the order they first appear.
export function contentWords(question: string, drugName: string): string[] {
  const drug = new Set(words(drugName));
  const found = new Set<string>();
  for (const word of words(question)) {
    if (word.length < MIN_WORD_LENGTH || STOP_WORDS.has(word) || drug.has(word)) continue;
    found.add(word);
  }
  return [...found];
}

// The share of the question's content words that are words of the context; null when it has none.
export function wordingOverlap(question: string, drugName: string, context: string): number | null {
  const wanted = contentWords(question, drugName);
  if (wanted.length === 0) return null;
  const present = new Set(words(context));
  return wanted.filter((word) => present.has(word)).length / wanted.length;
}

export type Third = 1 | 2 | 3;
export type Cuts = { low: number; high: number };

// The two cut points of a set of overlaps: the values at nearest ranks ceil(n/3) and ceil(2n/3), counted in whole
// numbers so no rounding moves a rank. Null when there are none.
export function thirdCuts(overlaps: readonly number[]): Cuts | null {
  const n = overlaps.length;
  if (n === 0) return null;
  const sorted = [...overlaps].sort((a, b) => a - b);
  const low = sorted[Math.ceil(n / 3) - 1];
  const high = sorted[Math.ceil((2 * n) / 3) - 1];
  return low === undefined || high === undefined ? null : { low, high };
}

export function thirdOf(overlap: number, cuts: Cuts): Third {
  if (overlap <= cuts.low) return 1;
  if (overlap <= cuts.high) return 2;
  return 3;
}

export const THIRD_NAMES: Record<Third, string> = { 1: 'lowest third', 2: 'middle third', 3: 'highest third' };
