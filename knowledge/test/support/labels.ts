// Synthetic SPL labels for the parser's tests (P1 to P18). Every word in them is invented here. Each fixture is
// listed in FIXTURES, so P15 can check that every one of them passes the check that no text was lost.

import { parseDocument } from '../../src/parse/parser.ts'
import { documentGuid, guid } from './fixture.ts'
import { splDocument } from './spl.ts'

export type SectionSpec = {
  id: string
  code: string
  title?: string
  text?: string
  // Raw XML placed inside the section after its text: excerpts, components, product data.
  inner?: string
  children?: string[]
}

export const section = (spec: SectionSpec): string =>
  `<component><section><id root="${spec.id}"/><code code="${spec.code}"/>` +
  (spec.title === undefined ? '' : `<title>${spec.title}</title>`) +
  (spec.text === undefined ? '' : `<text>${spec.text}</text>`) +
  (spec.inner ?? '') +
  (spec.children ?? []).join('') +
  '</section></component>'

// A section coded 43685-7 makes a label new-format, by the census's rule.
export const NEW_FORMAT_MARKER = section({ id: 's-wp', code: '43685-7', title: '5 WARNINGS AND PRECAUTIONS', text: '<paragraph>Invented warning.</paragraph>' })

export type Fixture = { n: number; version: number; setId: string; documentId: string; typeCode: string; xml: Buffer }

export function fixture(n: number, body: string, typeCode = '34391-3', version = 1): Fixture {
  const setId = guid(n)
  const documentId = documentGuid(n * 100 + version)
  const xml = Buffer.from(splDocument({ documentId, setId, version, typeCode }, body), 'utf8')
  return { n, version, setId, documentId, typeCode, xml }
}

export const parse = (label: Fixture) => parseDocument(label.xml)

const product = (name: string, generic: string | null, ingredients: [string, string][]): string =>
  '<subject><manufacturedProduct><manufacturedProduct>' +
  `<name>${name}</name>` +
  (generic === null ? '' : `<asEntityWithGeneric><genericMedicine><name>${generic}</name></genericMedicine></asEntityWithGeneric>`) +
  ingredients
    .map(([classCode, ingredient]) => `<ingredient classCode="${classCode}"><ingredientSubstance><name>${ingredient}</name></ingredientSubstance></ingredient>`)
    .join('') +
  '</manufacturedProduct></manufacturedProduct></subject>'

// ---------- P1 ----------

export const P1_PRESCRIPTION = fixture(
  101,
  section({
    id: 's-products',
    code: '48780-1',
    title: 'Product data',
    inner:
      product('Examplamab', 'examplamab sodium', [['ACTIB', 'EXAMPLAMAB SODIUM'], ['IACT', 'INVENTED FILLER']]) +
      product('Examplamab Plus', null, [['ACTIM', 'EXAMPLAMAB'], ['ACTIB', 'TESTAZOLE'], ['IACT', 'INVENTED BINDER']]),
  }) + NEW_FORMAT_MARKER,
)

export const P1_OTC = fixture(
  102,
  section({ id: 's-otc-products', code: '48780-1', title: 'Product data', inner: product('Sampleprin', 'sampleprin', [['ACTIB', 'SAMPLEPRIN']]) }) +
    section({ id: 's-otc-use', code: '34067-9', title: 'Uses', text: '<paragraph>Invented relief of invented aches.</paragraph>' }),
  '34390-5',
  4,
)

// ---------- P2 ----------

export const P2_NEW = fixture(
  201,
  section({ id: 's1', code: '34067-9', title: '1 INDICATIONS\n      AND   USAGE', text: '<paragraph>Invented indication.</paragraph>' }) +
    section({
      id: 's5',
      code: '43685-7',
      title: '5 WARNINGS AND PRECAUTIONS',
      children: [
        section({ id: 's51', code: '42229-5', title: '5.1 Invented risk', text: '<paragraph>Invented risk text.</paragraph>' }),
        section({
          id: 's-untitled',
          code: '42229-5',
          children: [section({ id: 's-deep', code: '42229-5', title: 'Deep child', text: '<paragraph>Invented deep text.</paragraph>' })],
        }),
      ],
    }) +
    section({ id: 's17', code: '34076-0', title: '17 PATIENT COUNSELING INFORMATION', text: '<paragraph>Invented counselling.</paragraph>' }),
)

export const P2_OLD = fixture(
  202,
  section({
    id: 'o1',
    code: '34067-9',
    title: 'INDICATIONS',
    children: [
      section({ id: 'o11', code: '42229-5', title: '1. Invented disorders', text: '<paragraph>Invented disorder text.</paragraph>' }),
      section({ id: 'o12', code: '42229-5', title: '5.1 Looks numbered', text: '<paragraph>Invented other text.</paragraph>' }),
    ],
  }),
)

// ---------- P3 ----------

export const P3_HIGHLIGHTS = fixture(
  301,
  section({
    id: 'h1',
    code: '34066-1',
    title: 'BOXED WARNING',
    inner: '<excerpt><highlight><text><paragraph>Invented highlight summary.</paragraph></text></highlight></excerpt>',
    text: '<paragraph>Invented full warning text.</paragraph>',
  }),
)

// ---------- P4 ----------

export const P4_TEXT = fixture(
  401,
  section({
    id: 't1',
    code: '34068-7',
    title: 'DOSAGE',
    text:
      '<paragraph>Dose   is\n   ten   units<br/>per day</paragraph>' +
      '<paragraph>Area of 1.5 m<sup>2</sup> exactly</paragraph>' +
      '<paragraph>Count of 10<sup>6</sup> cells</paragraph>' +
      '<paragraph>Formula H<sub>2</sub>O here</paragraph>' +
      '<paragraph><content styleCode="bold">Bold</content> and <content styleCode="italics">italic</content> words</paragraph>',
  }),
)

// ---------- P5 ----------

export const P5_LISTS = fixture(
  501,
  section({
    id: 'l1',
    code: '34071-1',
    title: 'LISTS',
    text:
      '<list listType="ordered"><item>First invented step</item><item>Second invented step</item></list>' +
      '<list listType="unordered"><item>Outer invented point<list listType="unordered"><item>Inner invented point</item></list></item>' +
      '<item><caption>a.</caption>Captioned invented point</item></list>' +
      // An item whose marker is written as a caption opening its paragraph.
      '<list listType="unordered"><item><paragraph><caption>o</caption>Invented males</paragraph></item></list>' +
      // The same inside a table cell, where a list becomes lines of the cell's text.
      '<table><tbody><tr><td><list listType="unordered"><item><paragraph><caption>o</caption>Invented females</paragraph></item></list></td><td>Invented value</td></tr></tbody></table>',
  }),
)

// ---------- P6 to P9: tables ----------

export const P6_TABLE = fixture(
  601,
  section({
    id: 'tb1',
    code: '34084-4',
    title: 'TABLE',
    text:
      '<table><thead><tr><th>Invented dose</th><th>Invented effect</th></tr></thead>' +
      '<tbody><tr><td>Low</td><td>Mild rash*</td></tr><tr><td>High</td><td>Severe</td></tr></tbody>' +
      '<tfoot><tr><td colspan="2">* Invented table footnote.</td></tr></tfoot></table>',
  }),
)

const twoRowTable = (firstRow: string): string =>
  `<table><tbody>${firstRow}<tr><td>Invented body one</td><td>Invented body two</td></tr></tbody></table>`

export const P7_TH = fixture(701, section({ id: 'p7a', code: '34084-4', title: 'TH', text: twoRowTable('<tr><th>Head one</th><th>Head two</th></tr>') }))
export const P7_BOLD = fixture(
  702,
  section({
    id: 'p7b',
    code: '34084-4',
    title: 'BOLD',
    text: twoRowTable('<tr><td><content styleCode="bold">Head one</content></td><td><content styleCode="Bold italics">Head two</content></td></tr>'),
  }),
)
export const P7_PARTLY_BOLD = fixture(
  703,
  section({
    id: 'p7c',
    code: '34084-4',
    title: 'PARTLY',
    text: twoRowTable('<tr><td><content styleCode="bold">Head one</content></td><td>Plain two</td></tr>'),
  }),
)

// Bold rows that label groups of body rows, one with a single filled cell, recurring below the header.
export const P7_GROUPS = fixture(
  704,
  section({
    id: 'p7d',
    code: '34084-4',
    title: 'GROUPS',
    text:
      '<table><tbody>' +
      '<tr><td><content styleCode="bold">Invented group</content></td><td><content styleCode="bold">Count</content></td></tr>' +
      '<tr><td>alpha</td><td>1</td></tr>' +
      '<tr><td><content styleCode="bold">Invented subgroup (n=5)</content></td><td></td></tr>' +
      '<tr><td>beta</td><td>2</td></tr>' +
      '</tbody></table>',
  }),
)

export const P8_SPANS = fixture(
  801,
  section({
    id: 'p8',
    code: '34084-4',
    title: 'SPANS',
    text:
      '<table><tbody>' +
      '<tr><td rowspan="2">Alpha</td><td colspan="2">Beta</td></tr>' +
      '<tr><td>Gamma</td><td>Delta</td></tr>' +
      '<tr><td>Eps</td><td>Zeta</td><td>Eta</td></tr>' +
      '</tbody></table>',
  }),
)
export const P8_RAGGED = fixture(
  802,
  section({ id: 'p8r', code: '34084-4', title: 'RAGGED', text: '<table><tbody><tr><td>One</td><td>Two</td></tr><tr><td>Three</td></tr></tbody></table>' }),
)
// A row whose own cells stop before a cell spanning down from above: an empty position before a covered one.
export const P8_GAP = fixture(
  804,
  section({
    id: 'p8g',
    code: '34084-4',
    title: 'GAP',
    text: '<table><tbody><tr><td>One</td><td>Two</td><td rowspan="2">Three</td></tr><tr><td>Four</td></tr></tbody></table>',
  }),
)
export const P8_CLASH = fixture(
  803,
  section({
    id: 'p8c',
    code: '34084-4',
    title: 'CLASH',
    text: '<table><tbody><tr><td>One</td><td rowspan="2">Two</td><td>Three</td></tr><tr><td colspan="3">Four</td></tr></tbody></table>',
  }),
)

export const P9_CAPTION = fixture(
  901,
  section({ id: 'p9a', code: '34084-4', title: 'CAP', text: '<table><caption>Table 1: Invented caption</caption><tbody><tr><td>One</td><td>Two</td></tr></tbody></table>' }),
)
export const P9_INFERRED = fixture(
  902,
  section({
    id: 'p9b',
    code: '34084-4',
    title: 'INFERRED',
    text: '<table><tbody><tr><td colspan="3">Table 2: Invented title row</td></tr><tr><td>One</td><td>Two</td><td>Three</td></tr><tr><td>Four</td><td>Five</td><td>Six</td></tr></tbody></table>',
  }),
)
export const P9_PARTIAL = fixture(
  903,
  section({
    id: 'p9c',
    code: '34084-4',
    title: 'PARTIAL',
    text: '<table><tbody><tr><td colspan="2">Wide but not across</td><td></td></tr><tr><td>One</td><td>Two</td><td>Three</td></tr></tbody></table>',
  }),
)

// ---------- P10 to P14 ----------

export const P10_FOOTNOTES = fixture(
  1001,
  section({
    id: 'p10',
    code: '34084-4',
    title: 'NOTES',
    text:
      '<paragraph>Invented claim<footnote ID="fn-para">Invented paragraph note.</footnote> continues.</paragraph>' +
      '<table><tbody><tr><td>Rate<footnote ID="fn-cell">Invented cell note.</footnote></td><td>Other rate<footnoteRef IDREF="fn-cell"/></td></tr>' +
      '<tr><td>Plain</td><td>Lost reference<footnoteRef IDREF="fn-nowhere"/></td></tr></tbody></table>',
  }),
)

export const P11_INDENT = fixture(
  1101,
  section({
    id: 'p11',
    code: '34084-4',
    title: 'INDENT',
    text:
      '<paragraph>&#160;&#160;Indented invented paragraph</paragraph>' +
      '<table><tbody><tr><td>Group</td><td>Value</td></tr><tr><td>&#160;&#160;&#160;Invented subgroup</td><td>Five</td></tr></tbody></table>',
  }),
)

export const P12_IMAGES = fixture(
  1201,
  section({
    id: 'p12',
    code: '34089-3',
    title: 'DESCRIPTION',
    text: '<paragraph>Invented structure shown below.</paragraph><renderMultiMedia referencedObject="MM1"/>',
    inner: '<component><observationMedia ID="MM1"><text>Invented figure description</text><value mediaType="image/jpeg"><reference value="figure-1.jpg"/></value></observationMedia></component>',
  }) +
    section({
      id: 'p12-only',
      code: '51945-4',
      title: 'PACKAGE LABEL',
      text: '<renderMultiMedia referencedObject="MM2"/>',
      inner: '<component><observationMedia ID="MM2"><text>Invented carton picture</text><value mediaType="image/jpeg"><reference value="carton.jpg"/></value></observationMedia></component>',
    }),
)

export const P13_NESTED = fixture(
  1301,
  section({
    id: 'p13',
    code: '34084-4',
    title: 'NESTED',
    text:
      '<table><tbody><tr><td>Outer cell</td><td><table><tbody><tr><td>Inner one</td><td>Inner two</td></tr></tbody></table></td></tr></tbody></table>' +
      // A table in a list in a cell is inside the cell too.
      '<table><tbody><tr><td>Second outer</td><td><list listType="unordered"><item>Listed<table><tbody><tr><td>Deep one</td></tr></tbody></table></item></list></td></tr></tbody></table>',
  }),
)

export const P14_UNKNOWN = fixture(
  1401,
  section({ id: 'p14', code: '34084-4', title: 'UNKNOWN', text: '<paragraph>Invented <madeUpElement>kept words</madeUpElement> here</paragraph>' }),
)

// ---------- P19 to P21 ----------

export const P19_MARKS = fixture(
  1901,
  section({
    id: 'p19',
    code: '34084-4',
    title: 'MARKS',
    text:
      '<table><tbody>' +
      '<tr><td>Rate*</td><td>Double**</td></tr>' +
      '<tr><td>Value<sup>a</sup></td><td>Plain</td></tr>' +
      '</tbody><tfoot><tr><td colspan="2">' +
      '<paragraph>* Invented star note.</paragraph>' +
      '<paragraph><sup>a</sup> Invented letter note.</paragraph>' +
      '<paragraph>† Invented dagger note.</paragraph>' +
      '</td></tr></tfoot></table>',
  }),
)

const starTable = (cells: string): string =>
  `<table><tbody>${cells}</tbody><tfoot><tr><td colspan="2">* Invented note.</td></tr></tfoot></table>`

export const P20_TWO_TABLES = fixture(
  2001,
  section({
    id: 'p20',
    code: '34084-4',
    title: 'TWO',
    text:
      starTable('<tr><td>First</td><td>Marked*</td></tr><tr><td>Unmarked</td><td>Plain</td></tr>') +
      starTable('<tr><td>Second</td><td>Plain</td></tr><tr><td>Marked*</td><td>Plain</td></tr>'),
  }),
)

export const P21_REAL_SHAPE = fixture(
  2101,
  section({
    id: 'p21',
    code: '34084-4',
    title: 'REAL',
    text:
      '<table><tbody>' +
      '<tr><td colspan="3">Table 3: Invented adverse reactions</td></tr>' +
      '<tr><td></td><td><content styleCode="bold">Drug</content></td><td><content styleCode="bold">Placebo</content></td></tr>' +
      '<tr><td><content styleCode="bold">Reaction</content></td><td><content styleCode="bold">(n=10)</content></td><td><content styleCode="bold">(n=12)</content></td></tr>' +
      '<tr><td>Invented headache</td><td>5%</td><td>2%</td></tr>' +
      '<tr><td>Invented nausea</td><td>3%</td><td>1%</td></tr>' +
      '</tbody></table>',
  }),
)

// ---------- P16 ----------

export const P16_NO_SECTIONS = fixture(1601, '<component><section><id root="empty"/><code code="42229-5"/></section></component>')
export const P16_UNREADABLE: Fixture = {
  ...fixture(1602, ''),
  xml: Buffer.from('<?xml version="1.0"?><!DOCTYPE document [<!ENTITY x "y">]><document xmlns="urn:hl7-org:v3"/>'),
}

export const FIXTURES: Record<string, Fixture> = {
  P1_PRESCRIPTION, P1_OTC, P2_NEW, P2_OLD, P3_HIGHLIGHTS, P4_TEXT, P5_LISTS, P6_TABLE, P7_TH, P7_BOLD, P7_PARTLY_BOLD,
  P7_GROUPS, P8_SPANS, P8_RAGGED, P8_GAP, P8_CLASH, P9_CAPTION, P9_INFERRED, P9_PARTIAL, P10_FOOTNOTES, P11_INDENT,
  P12_IMAGES, P13_NESTED, P14_UNKNOWN, P19_MARKS, P20_TWO_TABLES, P21_REAL_SHAPE,
}
