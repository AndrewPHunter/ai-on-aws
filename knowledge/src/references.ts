// How a benchmark reference is matched to a label section: the rule the knowledge gate measures retrieval by, and
// the evaluation harness scores citations and retrieval by. One copy, imported by both.
//
// A reference names a section in words, such as "2.1 Recommended Dosage". A section matches it when the section's
// number equals the number the reference starts with, or the section's title equals the reference, ignoring case and
// spacing.

export const normaliseReference = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

// The leading section number of each reference that has one, such as "2.1" of "2.1 Recommended Dosage".
export function referenceNumbers(references: readonly string[]): string[] {
  return references
    .map(normaliseReference)
    .map((reference) => /^(\d+(?:\.\d+)*)\b/.exec(reference)?.[1])
    .filter((number): number is string => number !== undefined);
}

// Whether a section (its number and title, as the chunks carry them) matches any of the references.
export function sectionMatches(section: { number: unknown; title: unknown }, references: readonly string[]): boolean {
  const normalised = references.map(normaliseReference);
  const numbers = referenceNumbers(references);
  const number = typeof section.number === 'string' ? section.number : null;
  const title = typeof section.title === 'string' ? normaliseReference(section.title) : null;
  return (number !== null && numbers.includes(number)) || (title !== null && normalised.includes(title));
}
