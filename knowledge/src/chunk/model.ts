// What a chunk is: the unit search finds, a model is shown, and an answer cites. Its text is label text, so chunks
// live only in the data folder.

export type Chunk = {
  // `<set id>/<version>/<section key>/<part>/<n>`: the section key is the section's own id when the label gives it
  // to exactly one section, otherwise its position in the tree (`at-1.2.3`); n counts the section's chunks of
  // that part from 1.
  id: string
  setId: string
  version: number
  effectiveTime: string
  kind: 'prescription' | 'otc' | 'other'
  format: 'new' | 'old'
  documentTypeCode: string
  // Every product name, generic name and active-ingredient name, once each (compared without case).
  drug: string[]
  section: { id: string | null; code: string | null; number: string | null; title: string | null; path: string[] }
  part: 'body' | 'highlights'
  type: 'text' | 'table' | 'table-rows'
  // `ordinal` counts the label's chunks from 1 in document order. For table-rows: the first and last row held, as
  // indexes into the table's rows, and the table's row count.
  position: { ordinal: number; firstRow?: number; lastRow?: number; rowCount?: number }
  text: string
  // Lines of `text` repeated from elsewhere so the chunk stands alone.
  repeated: string[]
  // One line naming the drug and the title path; not part of `text`.
  context: string
  words: number
  source: string
}

export type ChunkSettings = {
  // Words of text a chunk may hold.
  textLimit: number
  // Words above which a splittable table is split.
  tableLimit: number
}

export type NotSplittable = { headerNotThead: boolean; nestedTable: boolean; shortRow: boolean; boldRowNotGroupLabel: boolean }

// What the splitter did, for the report. Numbers and identifiers only.
export type SplitStats = {
  paragraphsSplitAtSentences: number
  sentencesSplitBetweenWords: number
  listsSplitBetweenItems: number
  itemsSplit: number
  sectionsImageOnlySkipped: number
  tables: {
    chunkId: string
    outcome: 'one-within-limit' | 'one-oversize' | 'split'
    words: number
    chunks: number
    notSplittable: NotSplittable | null
  }[]
}

// A word is a run of characters between white space that holds at least one letter or digit, so the cell
// separators and footnote symbols the plain form adds are not counted.
export const wordCount = (text: string): number => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length
