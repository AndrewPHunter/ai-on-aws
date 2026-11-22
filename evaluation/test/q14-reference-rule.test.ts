// Q14. The rule that matches a benchmark reference to a section, moved to knowledge/src/references.ts for the gate and
// this harness to share, matches exactly as the gate's own copy did: the gate's former expression is kept here as the
// oracle and compared on every case below.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { sectionMatches } from '../../knowledge/src/references.ts';

// The gate's code before the move, verbatim apart from its names.
function gateBefore(section: { number: unknown; title: unknown }, refs: string[]): boolean {
  const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const references = refs.map(normalise);
  const numbers = references.map((r) => /^(\d+(?:\.\d+)*)\b/.exec(r)?.[1]).filter((n): n is string => n !== undefined);
  const number = typeof section.number === 'string' ? section.number : null;
  const title = typeof section.title === 'string' ? normalise(section.title) : null;
  return (number !== null && numbers.includes(number)) || (title !== null && references.includes(title));
}

const sections = [
  { number: '2.1', title: '2.1 Recommended Dosage' },
  { number: '2', title: '2 DOSAGE AND ADMINISTRATION' },
  { number: null, title: 'Boxed Warning' },
  { number: '12.3', title: null },
  { number: 7, title: 7 },
];
const referenceSets = [
  ['2.1 Recommended Dosage'],
  ['2.1\tRecommended   dosage'],
  ['2 Dosage and Administration'],
  ['2.10 Something'],
  ['boxed  warning'],
  ['BOXED WARNING', '12.3 Pharmacokinetics'],
  ['Pharmacokinetics'],
  ['12.3'],
  [],
  ['  2.1 ', 'x'],
];

test('Q14. the shared rule matches as the gate did, on every pair', () => {
  for (const section of sections) {
    for (const references of referenceSets) {
      assert.equal(sectionMatches(section, references), gateBefore(section, references), `${JSON.stringify(section)} ${JSON.stringify(references)}`);
    }
  }
});

test('Q14. the gate imports the shared rule and keeps no copy of its own', () => {
  const gate = readFileSync(new URL('../../knowledge/src/gate/gate.ts', import.meta.url), 'utf8');
  assert.match(gate, /import \{ sectionMatches \} from '\.\.\/references\.ts';/);
  assert.doesNotMatch(gate, /\\d\+\(\?:\\\.\\d\+\)\*/);
});
