// What a parsed label is. Every string here that is not an identifier or a code is label text, so a parsed
// document lives only in the data folder.

// A footnote written in the text it belongs to. Its mark replaces it in that text: `[^N]`, numbered in document
// order across the label. A reference to a footnote that does not exist is written `[^?]`.
export type Footnote = { mark: string; text: string }

// The footnote marks the parser writes into text. The check that no text was lost removes exactly these.
export const MARK_PATTERN = /\[\^(?:\d+|\?)\]/g

export type Paragraph = {
  type: 'paragraph'
  text: string
  // The number of leading non-breaking spaces the label used to indent it. They are not in `text`.
  indent: number
  // Footnote marks in `text`, in order: its own footnotes' and references to footnotes elsewhere.
  marks: string[]
  footnotes: Footnote[]
}

export type ListItem = {
  // The item's own caption or marker, as the label writes it.
  caption: string | null
  text: string
  marks: string[]
  footnotes: Footnote[]
  // Nested lists, tables and images inside the item, in order.
  blocks: Block[]
}

export type List = { type: 'list'; ordered: boolean; items: ListItem[] }

export type Image = {
  type: 'image'
  // The referenced observationMedia's ID.
  objectId: string | null
  // The observationMedia's descriptive text, if the label gives any.
  text: string | null
  // The caption written on the reference, if any.
  caption: string | null
}

export type Cell = {
  text: string
  // A th element, or a cell of a thead row.
  header: boolean
  rowSpan: number
  colSpan: number
  indent: number
  marks: string[]
  // Tables (nested) and images inside the cell, in order. Their text is not in `text`.
  blocks: Block[]
}

export type TableFootnote = {
  // `[^N]` for a footnote element; for a tfoot line, the symbol or superscript it starts with, or null.
  mark: string | null
  text: string
  source: 'cell' | 'caption' | 'tfoot'
  // The cells that refer to it, as [row, cell] indexes into `rows`.
  cells: [number, number][]
}

export type Table = {
  type: 'table'
  caption: string | null
  captionSource: 'element' | 'inferred' | 'none'
  // Rows as written (thead then tbody), without a row taken as an inferred caption, and without tfoot.
  rows: Cell[][]
  // For each row of `rows`: whether it is wholly bold (every cell with text is a th or has all its text in bold,
  // and at least one cell has text), and how many of its cells have text. Header inference does not use these;
  // they let a later step tell a column heading from a row that labels a group of rows.
  rowFacts: { wholeBold: boolean; filledCells: number }[]
  // The widest row's width.
  columns: number
  // For every row and column, the [row, cell] that covers it once spans are applied; null where none does,
  // which is only ever at the end of a short row.
  grid: ([number, number] | null)[][]
  // The first `headerRows` rows of `rows` are the header.
  headerRows: number
  headerSource: 'thead' | 'inferred' | 'none'
  footnotes: TableFootnote[]
}

export type Block = Paragraph | List | Table | Image

export type Section = {
  id: string | null
  code: string | null
  title: string | null
  // From the start of the title, in a new-format label only, when it has the form 5 or 5.1.
  number: string | null
  // The titles from the top section down to this one, untitled sections skipped.
  path: string[]
  blocks: Block[]
  highlights: Block[]
  sections: Section[]
}

export type Product = { name: string | null; genericName: string | null; activeIngredients: string[] }

export type ParsedDocument = {
  setId: string
  version: number
  documentId: string
  effectiveTime: string
  documentTypeCode: string
  kind: 'prescription' | 'otc' | 'other'
  format: 'new' | 'old'
  title: string | null
  products: Product[]
  sections: Section[]
}

export const ERROR_CODES = ['text-not-conserved', 'table-not-rectangular', 'no-sections', 'unreadable'] as const
export const WARNING_CODES = [
  'section-untitled',
  'section-unclassified',
  'table-header-inferred',
  'table-header-none',
  'table-caption-inferred',
  'table-nested',
  'section-images-only',
  'footnote-reference-unmatched',
  'element-unknown',
  'table-row-short',
  'footnote-mark-unmatched',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]
export type WarningCode = (typeof WARNING_CODES)[number]

// A problem never carries label text: only a code, identifiers, an element name and counts.
export type Problem = {
  code: ErrorCode | WarningCode
  severity: 'error' | 'warning'
  sectionId?: string | null
  // The table's position among the tables of its section, in document order, nested ones counted.
  table?: number
  count?: number
  missing?: number
  extra?: number
  element?: string
  // For `unreadable`: the step 1 refusal code, or missing / checksum-mismatch.
  reason?: string
}

export type ParseResult = { document: ParsedDocument | null; problems: Problem[] }
