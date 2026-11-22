// P1. Identity and products: the fields, for a prescription label and an over-the-counter one; kind and format
// for each; a label with two products gives both, each with its ingredients.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P1_OTC, P1_PRESCRIPTION } from './support/labels.ts'
import { errors, parsedOk } from './support/parsed.ts'

test('P1. a new-format prescription label with two products', () => {
  const { document, problems } = parsedOk(P1_PRESCRIPTION)
  assert.deepEqual(errors(problems), [])
  assert.equal(document.setId, P1_PRESCRIPTION.setId)
  assert.equal(document.version, 1)
  assert.equal(document.documentId, P1_PRESCRIPTION.documentId)
  assert.equal(document.effectiveTime, '20240102')
  assert.equal(document.documentTypeCode, '34391-3')
  assert.equal(document.kind, 'prescription')
  assert.equal(document.format, 'new')
  assert.equal(document.title, 'Synthetic test label')
  assert.deepEqual(document.products, [
    { name: 'Examplamab', genericName: 'examplamab sodium', activeIngredients: ['EXAMPLAMAB SODIUM'] },
    { name: 'Examplamab Plus', genericName: null, activeIngredients: ['EXAMPLAMAB', 'TESTAZOLE'] },
  ])
})

test('P1. an old-format over-the-counter label', () => {
  const { document, problems } = parsedOk(P1_OTC)
  assert.deepEqual(errors(problems), [])
  assert.equal(document.setId, P1_OTC.setId)
  assert.equal(document.version, 4)
  assert.equal(document.documentTypeCode, '34390-5')
  assert.equal(document.kind, 'otc')
  assert.equal(document.format, 'old')
  assert.deepEqual(document.products, [{ name: 'Sampleprin', genericName: 'sampleprin', activeIngredients: ['SAMPLEPRIN'] }])
})
