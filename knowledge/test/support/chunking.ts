// Synthetic labels for the splitter's tests (U1 to U15), parsed by the real parser, and helpers to chunk them.
// Every word in them is invented here. CHUNK_FIXTURES lists them all, for U13.

import assert from 'node:assert/strict'

import type { Chunk, ChunkSettings, SplitStats } from '../../src/chunk/model.ts'
import { splitDocument } from '../../src/chunk/split.ts'
import type { ParsedDocument } from '../../src/parse/model.ts'
import { parseDocument } from '../../src/parse/parser.ts'
import type { Fixture } from './labels.ts'
import { fixture, section } from './labels.ts'

export function parsedDocument(label: Fixture): ParsedDocument {
  const result = parseDocument(label.xml)
  assert.ok(result.document, 'no document')
  return result.document
}

export function chunk(label: Fixture, settings: ChunkSettings): { chunks: Chunk[]; stats: SplitStats; document: ParsedDocument } {
  const document = parsedDocument(label)
  return { ...splitDocument(document, settings), document }
}

export const ofSection = (chunks: readonly Chunk[], id: string): Chunk[] => chunks.filter((c) => c.section.id === id)

// U2: four paragraphs of 4, 4, 2 and 3 words.
export const U2_PACK = fixture(
  3201,
  section({
    id: 'u2',
    code: '34068-7',
    title: 'PACK',
    text:
      '<paragraph>alpha beta gamma delta</paragraph><paragraph>epsilon zeta eta theta</paragraph>' +
      '<paragraph>iota kappa</paragraph><paragraph>lambda mu nu</paragraph>',
  }),
)

// U3: a paragraph of three sentences (8 words), and one sentence of 12 words.
export const U3_LONG = fixture(
  3301,
  section({ id: 'u3a', code: '34068-7', title: 'SENTENCES', text: '<paragraph>One two three. Four five six. Seven eight.</paragraph>' }) +
    section({ id: 'u3b', code: '34068-7', title: 'WORDS', text: '<paragraph>w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12.</paragraph>' }),
)

// U4: a list that fits, and one that does not, with a nested list and a captioned item.
export const U4_LISTS = fixture(
  3401,
  section({ id: 'u4a', code: '34071-1', title: 'FITS', text: '<list listType="unordered"><item>First item</item><item>Second item</item></list>' }) +
    section({
      id: 'u4b',
      code: '34071-1',
      title: 'SPLITS',
      text:
        '<list listType="ordered"><item>Alpha one two</item>' +
        '<item>Beta three four<list listType="unordered"><item>Gamma five</item></list></item>' +
        '<item><caption>a.</caption>Delta six</item></list>',
    }),
)

// U6: an untitled section with blocks of its own, under a titled one.
export const U6_UNTITLED = fixture(
  3601,
  section({
    id: 'u6',
    code: '34084-4',
    title: 'Parent title',
    children: [section({ id: 'u6-untitled', code: '42229-5', text: '<paragraph>Invented untitled text.</paragraph>' })],
  }),
)

// U8: the plain form of a table.
export const U8_TABLE = fixture(
  3801,
  section({
    id: 'u8',
    code: '34084-4',
    title: 'PLAIN',
    text:
      '<table><caption>Table 9: Invented</caption>' +
      '<thead><tr><th>Dose</th><th>Effect</th><th>Note</th></tr></thead>' +
      '<tbody><tr><td colspan="2">A</td><td>B</td></tr>' +
      '<tr><td>C</td><td>D<br/>E</td><td>F*<footnote>Invented cell note.</footnote></td></tr>' +
      '<tr><td>G</td></tr></tbody>' +
      '<tfoot><tr><td colspan="3">* Invented star.</td></tr></tfoot></table>',
  }),
)

const bold = (text: string): string => `<content styleCode="bold">${text}</content>`
const filler = (n: number): string => Array.from({ length: n }, (_, i) => `<tr><td>row${i}</td><td>value${i}</td></tr>`).join('')

// U9: tables that are not splittable, each far over a small limit.
export const U9_UNSPLITTABLE = fixture(
  3901,
  section({
    id: 'u9',
    code: '34084-4',
    title: 'UNSPLITTABLE',
    text:
      // An inferred header.
      `<table><tbody><tr><th>Head one</th><th>Head two</th></tr>${filler(6)}</tbody></table>` +
      // No header.
      `<table><tbody>${filler(6)}</tbody></table>` +
      // A nested table.
      `<table><thead><tr><th>Outer</th><th>Inner</th></tr></thead><tbody><tr><td>x</td><td><table><tbody><tr><td>deep</td></tr></tbody></table></td></tr>${filler(6)}</tbody></table>` +
      // A short row.
      `<table><thead><tr><th>One</th><th>Two</th></tr></thead><tbody>${filler(6)}<tr><td>alone</td></tr></tbody></table>` +
      // A wholly bold row below the header with two filled cells.
      `<table><thead><tr><th>One</th><th>Two</th></tr></thead><tbody>${filler(3)}<tr><td>${bold('Sub one')}</td><td>${bold('Sub two')}</td></tr>${filler(3)}</tbody></table>`,
  }),
)

// U10: a splittable table with a caption element and a thead.
const u10Rows = Array.from({ length: 6 }, (_, i) => `<tr><td>row${i + 1}</td><td>value${i + 1}</td></tr>`).join('')
export const U10_SPLITTABLE = fixture(
  4001,
  section({
    id: 'u10',
    code: '34084-4',
    title: 'SPLITTABLE',
    text: `<table><caption>Table 1: Invented</caption><thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody>${u10Rows}</tbody></table>`,
  }),
)

// U11: group labels (wholly bold, one filled cell) in a splittable table.
export const U11_GROUPS = fixture(
  4101,
  section({
    id: 'u11',
    code: '34084-4',
    title: 'GROUPS',
    text:
      '<table><thead><tr><th>Group</th><th>Value</th></tr></thead><tbody>' +
      `<tr><td>${bold('Alpha group')}</td><td></td></tr>` +
      '<tr><td>a1</td><td>1</td></tr><tr><td>a2</td><td>2</td></tr><tr><td>a3</td><td>3</td></tr>' +
      `<tr><td>${bold('Beta group')}</td><td></td></tr>` +
      '<tr><td>b1</td><td>4</td></tr><tr><td>b2</td><td>5</td></tr>' +
      '</tbody></table>',
  }),
)

// U12: footnotes in a split table: one referred to by a header cell, one per run, one that no cell refers to.
export const U12_FOOTNOTES = fixture(
  4201,
  section({
    id: 'u12',
    code: '34084-4',
    title: 'NOTES',
    text:
      '<table><thead><tr><th>Name<footnote>Invented header note.</footnote></th><th>Value</th></tr></thead><tbody>' +
      '<tr><td>x1</td><td>1*</td></tr><tr><td>x2</td><td>2</td></tr><tr><td>x3</td><td>3†</td></tr><tr><td>x4</td><td>4</td></tr>' +
      '</tbody><tfoot><tr><td colspan="2"><paragraph>* Star note.</paragraph><paragraph>† Dagger note.</paragraph><paragraph>‡ Orphan note.</paragraph></td></tr></tfoot></table>',
  }),
)

// U14: an image with text, and a section of images with no text.
export const U14_IMAGES = fixture(
  4401,
  section({
    id: 'u14',
    code: '34089-3',
    title: 'DESCRIPTION',
    text: '<renderMultiMedia referencedObject="IM1"/>',
    inner: '<component><observationMedia ID="IM1"><text>Invented structure picture</text><value mediaType="image/jpeg"><reference value="a.jpg"/></value></observationMedia></component>',
  }) +
    section({
      id: 'u14-bare',
      code: '51945-4',
      title: 'PACKAGE LABEL',
      text: '<renderMultiMedia referencedObject="IM2"/>',
      inner: '<component><observationMedia ID="IM2"><value mediaType="image/jpeg"><reference value="b.jpg"/></value></observationMedia></component>',
    }),
)

// U16: a splittable table where a cell spans rows 2 and 3.
export const U16_ROWSPAN = fixture(
  4601,
  section({
    id: 'u16',
    code: '34084-4',
    title: 'ROWSPAN',
    text:
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>' +
      '<tr><td>x1</td><td>1</td></tr>' +
      '<tr><td rowspan="2">spanning</td><td>2</td></tr>' +
      '<tr><td>3</td></tr>' +
      '<tr><td>x4</td><td>4</td></tr><tr><td>x5</td><td>5</td></tr>' +
      '</tbody></table>',
  }),
)

// U17: a splittable table with one body row far larger than the table limit.
const longCell = Array.from({ length: 20 }, (_, i) => `word${i + 1}`).join(' ')
export const U17_LONG_ROW = fixture(
  4701,
  section({
    id: 'u17',
    code: '34084-4',
    title: 'LONG ROW',
    text:
      '<table><caption>Table 5: Invented</caption><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>' +
      `<tr><td>a</td><td>1</td></tr><tr><td>${longCell}</td><td>2</td></tr><tr><td>c</td><td>3</td></tr>` +
      '</tbody></table>',
  }),
)

// U18: a table inside a list item.
export const U18_TABLE_IN_ITEM = fixture(
  4801,
  section({
    id: 'u18',
    code: '34071-1',
    title: 'TABLE IN ITEM',
    text:
      '<list listType="unordered"><item>Intro words' +
      '<table><tbody><tr><td>c1</td><td>c2</td></tr><tr><td>c3</td><td>c4</td></tr></tbody></table>' +
      '</item><item>Closing item</item></list>',
  }),
)

export const CHUNK_FIXTURES: Record<string, Fixture> = {
  U2_PACK, U3_LONG, U4_LISTS, U6_UNTITLED, U8_TABLE, U9_UNSPLITTABLE, U10_SPLITTABLE, U11_GROUPS, U12_FOOTNOTES, U14_IMAGES,
  U16_ROWSPAN, U17_LONG_ROW, U18_TABLE_IN_ITEM,
}
