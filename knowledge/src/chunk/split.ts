// Splits a parsed document into chunks. A pure function of the document and the settings: no clock, no
// randomness, no input or output. The check that nothing was lost or doubled (check.ts) takes its own walk.

import type { Block, Image, List, ListItem, Paragraph, ParsedDocument, Section, Table } from '../parse/model.ts'
import type { Chunk, ChunkSettings, NotSplittable, SplitStats } from './model.ts'
import { wordCount } from './model.ts'

// A piece of text ready to pack: its lines, and the number of words in them.
type Unit = { lines: string[]; words: number }

const unit = (lines: string[]): Unit => ({ lines, words: wordCount(lines.join('\n')) })

// ---------- the plain form of blocks ----------

const footnoteLine = (mark: string | null, text: string): string => (mark === null ? text : `${mark} ${text}`).trim()

function imageLines(image: Image): string[] {
  return [image.text, image.caption].filter((line): line is string => line !== null && line !== '')
}

// A cell's text on one line: its line breaks become " / ".
const cellText = (text: string): string => text.split('\n').join(' / ')

function rowLine(table: Table, r: number): string {
  const row = table.grid[r] ?? []
  return row
    .map((position, c) => {
      if (position === null) return ''
      const [cellRow, cellIndex] = position
      // A cell is written once, at its first position; the other positions it covers are empty.
      if (cellRow !== r) return ''
      const first = row.findIndex((other) => other !== null && other[0] === cellRow && other[1] === cellIndex)
      if (first !== c) return ''
      return cellText(table.rows[cellRow]?.[cellIndex]?.text ?? '')
    })
    .join(' | ')
}

// Lines that follow a row: the nested tables and the images held by the cells that start in it.
function rowExtras(table: Table, r: number): string[] {
  const out: string[] = []
  for (const cell of table.rows[r] ?? []) {
    for (const block of cell.blocks) {
      if (block.type === 'table') out.push(...tableLines(block))
      else if (block.type === 'image') out.push(...imageLines(block))
      else out.push(...blockLines(block))
    }
  }
  return out
}

const tableFootnoteLine = (footnote: Table['footnotes'][number]): string =>
  // A tfoot line already starts with its own mark; a footnote element's mark is written in front.
  footnote.source === 'tfoot' ? footnote.text : footnoteLine(footnote.mark, footnote.text)

export function tableLines(table: Table): string[] {
  const lines: string[] = []
  if (table.caption !== null && table.caption !== '') lines.push(table.caption)
  table.rows.forEach((_, r) => {
    lines.push(rowLine(table, r), ...rowExtras(table, r))
  })
  for (const footnote of table.footnotes) lines.push(tableFootnoteLine(footnote))
  return lines
}

function itemLines(item: ListItem, depth: number): string[] {
  const indent = '  '.repeat(depth)
  const textLines = item.text.split('\n').filter((line) => line !== '')
  // The caption or marker leads the item's first line; further lines of the item keep its indent.
  const first = [item.caption ?? '', textLines[0] ?? ''].filter((part) => part !== '').join(' ')
  const lines: string[] = []
  if (first !== '') lines.push(`${indent}${first}`)
  for (const line of textLines.slice(1)) lines.push(`${indent}${line}`)
  for (const footnote of item.footnotes) lines.push(`${indent}${footnoteLine(footnote.mark, footnote.text)}`)
  for (const block of item.blocks) {
    if (block.type === 'list') for (const nested of block.items) lines.push(...itemLines(nested, depth + 1))
    else lines.push(...blockLines(block).map((line) => `${indent}  ${line}`))
  }
  return lines
}

function paragraphLines(paragraph: Paragraph): string[] {
  const lines = paragraph.text === '' ? [] : paragraph.text.split('\n')
  for (const footnote of paragraph.footnotes) lines.push(footnoteLine(footnote.mark, footnote.text))
  return lines
}

function blockLines(block: Block): string[] {
  if (block.type === 'paragraph') return paragraphLines(block)
  if (block.type === 'list') return block.items.flatMap((item) => itemLines(item, 0))
  if (block.type === 'table') return tableLines(block)
  return imageLines(block)
}

// ---------- splitting text that passes the limit ----------

function splitWords(text: string, limit: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '')
  const out: string[] = []
  for (let i = 0; i < words.length; i += limit) out.push(words.slice(i, i + limit).join(' '))
  return out
}

// Text over the limit, as pieces at sentence ends; a sentence over the limit is split between words.
function splitText(text: string, limit: number, stats: SplitStats): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim() !== '')
  stats.paragraphsSplitAtSentences++
  const pieces: string[] = []
  let current: string[] = []
  let words = 0
  const flush = (): void => {
    if (current.length > 0) pieces.push(current.join(' '))
    current = []
    words = 0
  }
  for (const sentence of sentences) {
    const n = wordCount(sentence)
    if (n > limit) {
      flush()
      stats.sentencesSplitBetweenWords++
      pieces.push(...splitWords(sentence, limit))
      continue
    }
    if (words + n > limit) flush()
    current.push(sentence)
    words += n
  }
  flush()
  return pieces
}

function textUnits(block: Block, limit: number, stats: SplitStats): Unit[] {
  if (block.type === 'paragraph') {
    const whole = unit(paragraphLines(block))
    if (whole.words <= limit) return whole.words === 0 ? [] : [whole]
    const pieces = splitText(block.text.split('\n').join(' '), limit, stats).map((piece) => unit([piece]))
    const footnotes = block.footnotes.map((footnote) => footnoteLine(footnote.mark, footnote.text))
    // The block's footnotes are written after it, with its last piece.
    const last = pieces.pop()
    return [...pieces, unit([...(last?.lines ?? []), ...footnotes])]
  }
  if (block.type === 'list') return listUnits(block, limit, stats)
  if (block.type === 'image') {
    const lines = imageLines(block)
    return lines.length === 0 ? [] : [unit(lines)]
  }
  return [unit(tableLines(block))]
}

function listUnits(list: List, limit: number, stats: SplitStats): Unit[] {
  const whole = unit(list.items.flatMap((item) => itemLines(item, 0)))
  if (whole.words <= limit) return whole.words === 0 ? [] : [whole]
  stats.listsSplitBetweenItems++
  const units: Unit[] = []
  for (const item of list.items) {
    const lines = itemLines(item, 0)
    const one = unit(lines)
    if (one.words === 0) continue
    if (one.words <= limit) {
      units.push(one)
      continue
    }
    // An item alone over the limit: split inside it, line by line, at sentence ends and then between words.
    stats.itemsSplit++
    let current: string[] = []
    let words = 0
    for (const line of lines) {
      const n = wordCount(line)
      const pieces = n > limit ? splitText(line, limit, stats) : [line]
      for (const piece of pieces) {
        const m = wordCount(piece)
        if (words + m > limit && current.length > 0) {
          units.push(unit(current))
          current = []
          words = 0
        }
        current.push(piece)
        words += m
      }
    }
    if (current.length > 0) units.push(unit(current))
  }
  return units
}

// ---------- tables ----------

export function notSplittable(table: Table): NotSplittable | null {
  const nestedTable = table.rows.some((row) => row.some((cell) => cell.blocks.some((block) => block.type === 'table')))
  const shortRow = table.grid.some((row) => row.some((position) => position === null))
  const boldRowNotGroupLabel = table.rowFacts.slice(table.headerRows).some((facts) => facts.wholeBold && facts.filledCells !== 1)
  const reasons = { headerNotThead: table.headerSource !== 'thead', nestedTable, shortRow, boldRowNotGroupLabel }
  return Object.values(reasons).some(Boolean) ? reasons : null
}

const isGroupLabel = (table: Table, r: number): boolean => {
  const facts = table.rowFacts[r]
  return facts !== undefined && facts.wholeBold && facts.filledCells === 1
}

// Whether a chunk may end after row r: no cell spans down from row r or above into row r + 1.
function cleanBoundary(table: Table, r: number): boolean {
  const next = table.grid[r + 1]
  if (next === undefined) return true
  return next.every((position) => position === null || position[0] === r + 1)
}

type RowsPiece = { lines: string[]; repeated: string[]; firstRow: number; lastRow: number }

// A splittable table over the limit, as runs of consecutive body rows. The first run holds the caption and header
// rows in place; later runs repeat them. A group label carried in from above, and a footnote already written in
// an earlier run, are repeated too.
function splitTable(table: Table, limit: number): RowsPiece[] {
  const caption = table.caption !== null && table.caption !== '' ? [table.caption] : []
  const header = Array.from({ length: table.headerRows }, (_, r) => [rowLine(table, r), ...rowExtras(table, r)]).flat()
  const written = new Set<number>()
  const pieces: RowsPiece[] = []
  // A footnote goes with a run of rows when a cell in those rows refers to it, when a header cell does (the
  // header is in every run), or when no cell does.
  const belongs = (footnote: Table['footnotes'][number], start: number, end: number): boolean =>
    footnote.cells.length === 0 || footnote.cells.some(([row]) => row < table.headerRows || (row >= start && row <= end))
  let start = table.headerRows
  while (start < table.rows.length) {
    const first = pieces.length === 0
    const carried: string[] = []
    if (!isGroupLabel(table, start)) {
      for (let r = start - 1; r >= table.headerRows; r--) {
        if (isGroupLabel(table, r)) {
          carried.push(rowLine(table, r))
          break
        }
      }
    }
    const build = (end: number): RowsPiece => {
      const rows: string[] = []
      for (let r = start; r <= end; r++) rows.push(rowLine(table, r), ...rowExtras(table, r))
      const footnoteLines: string[] = []
      const repeatedFootnotes: string[] = []
      table.footnotes.forEach((footnote, index) => {
        if (!belongs(footnote, start, end)) return
        const line = tableFootnoteLine(footnote)
        footnoteLines.push(line)
        if (written.has(index)) repeatedFootnotes.push(line)
      })
      const repeated = [...(first ? [] : [...caption, ...header]), ...carried, ...repeatedFootnotes]
      return { lines: [...caption, ...header, ...carried, ...rows, ...footnoteLines], repeated, firstRow: start, lastRow: end }
    }
    // As many rows as fit, ending only at a clean boundary, never on a group label with rows after it.
    let end = start
    let best = -1
    for (let candidate = start; candidate < table.rows.length; candidate++) {
      const allowed = cleanBoundary(table, candidate) && !(isGroupLabel(table, candidate) && candidate + 1 < table.rows.length)
      if (!allowed) continue
      if (best === -1 || wordCount(build(candidate).lines.join('\n')) <= limit) best = candidate
      else break
    }
    end = best === -1 ? table.rows.length - 1 : best
    const piece = build(end)
    table.footnotes.forEach((footnote, index) => {
      if (belongs(footnote, start, end)) written.add(index)
    })
    pieces.push(piece)
    start = end + 1
  }
  return pieces
}

// ---------- the document ----------

export function drugNames(document: ParsedDocument): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const product of document.products) {
    for (const name of [product.name, product.genericName, ...product.activeIngredients]) {
      if (name === null || name === '') continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(name)
    }
  }
  return out
}

function sectionKeys(sections: readonly Section[]): Map<Section, string> {
  const counts = new Map<string, number>()
  const walk = (list: readonly Section[]): void => {
    for (const section of list) {
      if (section.id !== null) counts.set(section.id, (counts.get(section.id) ?? 0) + 1)
      walk(section.sections)
    }
  }
  walk(sections)
  const keys = new Map<Section, string>()
  const assign = (list: readonly Section[], prefix: string): void => {
    list.forEach((section, index) => {
      const at = prefix === '' ? `${index + 1}` : `${prefix}.${index + 1}`
      const unique = section.id !== null && counts.get(section.id) === 1 && /^[A-Za-z0-9.:_-]{1,128}$/.test(section.id)
      keys.set(section, unique && section.id !== null ? section.id : `at-${at}`)
      assign(section.sections, at)
    })
  }
  assign(sections, '')
  return keys
}

export const sourceUrl = (setId: string, version: number): string =>
  `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}&version=${version}`

export function emptyStats(): SplitStats {
  return {
    paragraphsSplitAtSentences: 0,
    sentencesSplitBetweenWords: 0,
    listsSplitBetweenItems: 0,
    itemsSplit: 0,
    sectionsImageOnlySkipped: 0,
    tables: [],
  }
}

export function splitDocument(document: ParsedDocument, settings: ChunkSettings): { chunks: Chunk[]; stats: SplitStats } {
  if (!Number.isInteger(settings.textLimit) || settings.textLimit < 1) throw new Error('textLimit must be a positive integer')
  if (!Number.isInteger(settings.tableLimit) || settings.tableLimit < 1) throw new Error('tableLimit must be a positive integer')
  const stats = emptyStats()
  const chunks: Chunk[] = []
  const drug = drugNames(document)
  const keys = sectionKeys(document.sections)

  const emit = (section: Section, part: Chunk['part'], counter: { n: number }, piece: Omit<Chunk, 'id' | 'setId' | 'version' | 'effectiveTime' | 'kind' | 'format' | 'documentTypeCode' | 'drug' | 'section' | 'part' | 'context' | 'words' | 'source' | 'position'> & { position: Omit<Chunk['position'], 'ordinal'> }): Chunk => {
    counter.n++
    const chunk: Chunk = {
      id: `${document.setId}/${document.version}/${keys.get(section) ?? 'at-0'}/${part}/${counter.n}`,
      setId: document.setId,
      version: document.version,
      effectiveTime: document.effectiveTime,
      kind: document.kind,
      format: document.format,
      documentTypeCode: document.documentTypeCode,
      drug,
      section: { id: section.id, code: section.code, number: section.number, title: section.title, path: section.path },
      part,
      type: piece.type,
      position: { ordinal: chunks.length + 1, ...piece.position },
      text: piece.text,
      repeated: piece.repeated,
      context: `${drug.length > 0 ? drug.join(', ') : 'Unnamed product'}: ${section.path.length > 0 ? section.path.join(' > ') : 'Untitled section'}`,
      words: wordCount(piece.text),
      source: sourceUrl(document.setId, document.version),
    }
    chunks.push(chunk)
    return chunk
  }

  const chunkBlocks = (section: Section, part: Chunk['part'], blocks: readonly Block[]): void => {
    const counter = { n: 0 }
    let current: Unit[] = []
    let words = 0
    const flush = (): void => {
      if (current.length === 0) return
      emit(section, part, counter, { type: 'text', text: current.flatMap((u) => u.lines).join('\n'), repeated: [], position: {} })
      current = []
      words = 0
    }
    for (const block of blocks) {
      if (block.type === 'table') {
        flush()
        const lines = tableLines(block)
        const total = wordCount(lines.join('\n'))
        const reasons = notSplittable(block)
        const bodyRows = block.rows.length - block.headerRows
        if (reasons !== null || total <= settings.tableLimit || bodyRows < 2) {
          const chunk = emit(section, part, counter, { type: 'table', text: lines.join('\n'), repeated: [], position: {} })
          stats.tables.push({
            chunkId: chunk.id,
            outcome: total <= settings.tableLimit ? 'one-within-limit' : 'one-oversize',
            words: total,
            chunks: 1,
            notSplittable: reasons,
          })
          continue
        }
        const pieces = splitTable(block, settings.tableLimit)
        let firstId = ''
        for (const piece of pieces) {
          const chunk = emit(section, part, counter, {
            type: 'table-rows',
            text: piece.lines.join('\n'),
            repeated: piece.repeated,
            position: { firstRow: piece.firstRow, lastRow: piece.lastRow, rowCount: block.rows.length },
          })
          if (firstId === '') firstId = chunk.id
        }
        stats.tables.push({ chunkId: firstId, outcome: 'split', words: total, chunks: pieces.length, notSplittable: null })
        continue
      }
      for (const piece of textUnits(block, settings.textLimit, stats)) {
        if (current.length > 0 && words + piece.words > settings.textLimit) flush()
        current.push(piece)
        words += piece.words
      }
    }
    flush()
  }

  const walk = (sections: readonly Section[]): void => {
    for (const section of sections) {
      const before = chunks.length
      chunkBlocks(section, 'body', section.blocks)
      if (chunks.length === before && section.blocks.length > 0 && section.blocks.every((block) => block.type === 'image')) {
        stats.sectionsImageOnlySkipped++
      }
      chunkBlocks(section, 'highlights', section.highlights)
      walk(section.sections)
    }
  }
  walk(document.sections)
  return { chunks, stats }
}
