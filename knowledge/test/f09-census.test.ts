// F9. The census, on synthetic labels: each count is right for a new-format and an old-format label; a passage
// that differs only in white space and non-breaking spaces is counted as found; one with a changed word is not.

import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { runCensus } from '../src/census.ts'
import { sha256 } from '../src/files.ts'
import { benchmarkPin, folders, jsonl, manifestEntry, syntheticLabel, writeCorpus } from './support/fixture.ts'

// New format: Highlights excerpts and a 43685-7 section. Five sections, two of them unclassified and untitled
// (one with an empty title, one with none), two tables (one without thead), three cells with a span attribute
// (colspan="1" counts: the attribute is what is counted), one footnote, one image, two products.
const NEW_BODY = `
<component><section><code code="48780-1"/><title>Product data</title>
  <subject><manufacturedProduct><manufacturedProduct><name>Examplamab</name></manufacturedProduct></manufacturedProduct></subject>
  <subject><manufacturedProduct><manufacturedProduct><name>Examplamab kit</name><part><partProduct/></part></manufacturedProduct></manufacturedProduct></subject>
</section></component>
<component><section><code code="34066-1"/><title>BOXED WARNING</title>
  <excerpt><highlight><text><paragraph>Invented highlight.</paragraph></text></highlight></excerpt>
  <text><paragraph>Invented boxed text.</paragraph></text>
</section></component>
<component><section><code code="43685-7"/><title>5 WARNINGS AND PRECAUTIONS</title>
  <component><section><code code="42229-5"/><title/><text><paragraph>Untitled unclassified subsection.</paragraph></text></section></component>
  <component><section><code code="42229-5"/>
    <text><paragraph>Another&#160;passage   with
      spaces.</paragraph>
      <table><thead><tr><th colspan="2">Head</th></tr></thead>
        <tbody><tr><td rowspan="2">a<footnote>Invented footnote.</footnote></td><td>b</td></tr><tr><td>c</td></tr></tbody></table>
      <table><tbody><tr><td colspan="1">x</td><td>y</td></tr></tbody></table>
      <renderMultiMedia referencedObject="fig1"/>
    </text>
    <component><observationMedia ID="fig1"><text>Figure one</text><value mediaType="image/jpeg"><reference value="fig1.jpg"/></value></observationMedia></component>
  </section></component>
</section></component>`

// Old format: no Highlights, no 43685-7 section; an excerpt without a highlight does not make it new. Three
// sections, one untitled, one table without thead, one product.
const OLD_BODY = `
<component><section><code code="34089-3"/><title>DESCRIPTION</title><text><paragraph>Old format invented description.</paragraph></text></section></component>
<component><section><code code="34067-9"/><title>INDICATIONS</title>
  <text><paragraph>Used for invented purposes.</paragraph><table><tbody><tr><td>p</td></tr></tbody></table></text>
  <excerpt><text>Not a highlight.</text></excerpt>
</section></component>
<component><section><code code="48780-1"/><subject><manufacturedProduct><manufacturedProduct><name>Oldexample</name></manufacturedProduct></manufacturedProduct></subject></section></component>`

test('F9. the census counts each label right, and matches passages under the stated normalisation only', async (t) => {
  const where = await folders(t)
  const fresh = syntheticLabel(1, 7, { body: NEW_BODY })
  const old = syntheticLabel(2, 1, { body: OLD_BODY })

  const labels = jsonl([
    {
      set_id: fresh.setId,
      drug_name: 'examplamab',
      drug_id: 'examplamab',
      label_raw: '',
      // Found: differs only in white space. Not found: one word changed.
      chunks: ['Another passage\twith spaces.', 'Invented boxed words.'],
    },
    { set_id: old.setId, drug_name: 'Notinthislabel', drug_id: 'notinthislabel', label_raw: '', chunks: ['Used for invented purposes.'] },
  ])
  const qa = jsonl([
    {
      qid: 'q1',
      task: 'factual',
      source: 'highlights',
      set_id: fresh.setId,
      question: 'invented',
      answer: 'invented',
      context: [
        // Found: a non-breaking space and doubled spaces where the label has others.
        { text: 'Another passage with  spaces.', has_answer: true },
        // Not found: one word changed.
        { text: 'Invented boxing text.', has_answer: true },
        // Not an answer passage: not counted.
        { text: 'Invented highlight.', has_answer: false },
      ],
    },
    {
      qid: 'q2',
      task: 'refusal',
      source: 'section_selfinst',
      set_id: fresh.setId,
      question: 'invented',
      answer: 'invented',
      context: [{ text: 'Untitled unclassified subsection.', has_answer: true }],
    },
    {
      qid: 'q3',
      task: 'multihop',
      source: 'highlights',
      set_id: old.setId,
      question: 'invented',
      answer: 'invented',
      context: [
        { text: '  Old format invented description.\n', has_answer: true },
        // has_answer absent: not counted.
        { text: 'Used for invented purposes.' },
      ],
    },
  ])

  await mkdir(join(where.dataDir, 'benchmark'))
  await writeFile(join(where.dataDir, 'benchmark', 'labels.jsonl'), labels)
  await writeFile(join(where.dataDir, 'benchmark', 'qa.jsonl'), qa)
  for (const label of [fresh, old]) {
    await mkdir(join(where.dataDir, 'labels', label.setId), { recursive: true })
    await writeFile(join(where.dataDir, 'labels', label.setId, `${label.version}.xml`), label.xml)
  }
  await writeCorpus(where.corpusDir, benchmarkPin({ labels, qa }), {
    labels: [manifestEntry(fresh), manifestEntry(old)],
    notPinned: [],
  })

  const { census, exitCode } = await runCensus({ corpusDir: where.corpusDir, dataDir: where.dataDir, log: () => {}, warn: () => {} })

  assert.equal(exitCode, 0)
  assert.deepEqual(census.labels, [
    {
      setId: fresh.setId,
      version: 7,
      documentTypeCode: '34391-3',
      drugNamePresent: true,
      xmlBytes: fresh.xml.length,
      format: 'new',
      sections: 5,
      unclassifiedSections: 2,
      untitledSections: 2,
      tables: 2,
      tablesWithoutThead: 1,
      spanningCells: 3,
      footnotes: 1,
      images: 1,
      products: 2,
      questions: { factual: 1, refusal: 1 },
      highlightsQuestions: 1,
      answerPassages: { total: 3, found: 2 },
      chunks: { total: 2, found: 1 },
    },
    {
      setId: old.setId,
      version: 1,
      documentTypeCode: '34391-3',
      drugNamePresent: false,
      xmlBytes: old.xml.length,
      format: 'old',
      sections: 3,
      unclassifiedSections: 0,
      untitledSections: 1,
      tables: 1,
      tablesWithoutThead: 1,
      spanningCells: 0,
      footnotes: 0,
      images: 0,
      products: 1,
      questions: { multihop: 1 },
      highlightsQuestions: 1,
      answerPassages: { total: 1, found: 1 },
      chunks: { total: 1, found: 1 },
    },
  ])
  assert.deepEqual(census.formats, { new: 1, old: 1 })
  assert.deepEqual(census.documentTypes, { '34391-3': 2 })
  assert.equal(census.totals.sections, 8)
  assert.equal(census.totals.products, 3)
  assert.deepEqual(census.matching.answerPassages, {
    total: 4,
    found: 3,
    share: 0.75,
    labels: { full: 1, mostly: 0, partly: 1, none: 0, noPassages: 0 },
  })
  assert.deepEqual(census.matching.chunks, {
    total: 3,
    found: 2,
    share: 0.6667,
    labels: { full: 1, mostly: 0, partly: 1, none: 0, noPassages: 0 },
  })
  assert.deepEqual(census.questions.contextPassages, { hasAnswerTrue: 4, hasAnswerFalse: 1, hasAnswerAbsent: 1 })

  // Counts and codes only: none of the labels' text is in the written census.
  const written = await readFile(join(where.dataDir, 'census.json'), 'utf8')
  for (const phrase of ['Invented', 'Untitled unclassified', 'Examplamab', 'Old format', 'purposes']) {
    assert.ok(!written.includes(phrase), `census.json holds label text: ${phrase}`)
  }
  assert.equal(sha256(Buffer.from(written)), sha256(Buffer.from(`${JSON.stringify(census, null, 2)}\n`)))
})
