// P15. The check that no text was lost, on its own with documents built by hand: equal sides pass; a missing
// word, a doubled word, and "10" and "6" run together each fail with the right counts. And every synthetic
// fixture used by P1 to P14 passes it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkConservation } from '../src/parse/conserve.ts'
import { parseDocument } from '../src/parse/parser.ts'
import type { ParsedDocument } from '../src/parse/model.ts'
import { parseLabel } from '../src/spl.ts'
import { FIXTURES, fixture, section } from './support/labels.ts'

const label = fixture(1501, section({ id: 'c1', code: '34084-4', title: 'Alpha title', text: '<paragraph>beta gamma 10<sup>6</sup> units</paragraph>' }))
const xml = parseLabel(label.xml)

const handBuilt = (paragraph: string): ParsedDocument => ({
  setId: label.setId,
  version: 1,
  documentId: label.documentId,
  effectiveTime: '20240102',
  documentTypeCode: '34391-3',
  kind: 'prescription',
  format: 'old',
  title: null,
  products: [],
  sections: [
    {
      id: 'c1',
      code: '34084-4',
      title: 'Alpha title',
      number: null,
      path: ['Alpha title'],
      blocks: [{ type: 'paragraph', text: paragraph, indent: 0, marks: [], footnotes: [] }],
      highlights: [],
      sections: [],
    },
  ],
})

const rows = [
  { name: 'equal sides pass', text: 'beta gamma 10^{6} units', missing: 0, extra: 0 },
  { name: 'a footnote mark the parser wrote does not count', text: 'beta[^1] gamma 10^{6} units', missing: 0, extra: 0 },
  { name: 'a missing word', text: 'beta 10^{6} units', missing: 1, extra: 0 },
  { name: 'a doubled word', text: 'beta gamma gamma 10^{6} units', missing: 0, extra: 1 },
  { name: '"10" and "6" run together', text: 'beta gamma 106 units', missing: 2, extra: 1 },
] as const

for (const row of rows) {
  test(`P15. hand-built: ${row.name}`, () => {
    assert.deepEqual(checkConservation(xml, handBuilt(row.text)), { missing: row.missing, extra: row.extra })
  })
}

test('P15. every fixture of P1 to P14 passes the check', () => {
  for (const [name, item] of Object.entries(FIXTURES)) {
    const result = parseDocument(item.xml)
    assert.ok(result.document, `${name}: no document`)
    assert.deepEqual(checkConservation(parseLabel(item.xml), result.document), { missing: 0, extra: 0 }, name)
    assert.deepEqual(result.problems.filter((p) => p.code === 'text-not-conserved'), [], name)
  }
})
