// Turns a label's XML bytes into a parsed document and a list of problems. A pure function: no clock, no
// randomness, no input or output. The check that no text was lost (conserve.ts) is run on its result and does
// not share this traversal.

import type { Document, Element, Node } from '@xmldom/xmldom'

import { countStructure } from '../census.ts'
import { Refusal } from '../reasons.ts'
import { SPL_NAMESPACE, children, isElement, parseLabel, readIdentity } from '../spl.ts'
import { checkConservation } from './conserve.ts'
import { MARK_PATTERN } from './model.ts'
import type {
  Block,
  Cell,
  Footnote,
  Image,
  List,
  ListItem,
  Paragraph,
  ParsedDocument,
  ParseResult,
  Problem,
  Product,
  Section,
  Table,
  TableFootnote,
} from './model.ts'

const TEXT_NODE = 3
const CDATA_SECTION_NODE = 4

// Elements whose meaning the parser knows. Anything else is reported by name, and its text kept where it sits.
export const KNOWN_ELEMENTS = new Set([
  'section', 'id', 'code', 'title', 'effectiveTime', 'text', 'component', 'excerpt', 'highlight', 'subject',
  'paragraph', 'content', 'linkHtml', 'br', 'sup', 'sub', 'footnote', 'footnoteRef', 'caption',
  'list', 'item', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup',
  'renderMultiMedia', 'observationMedia', 'value', 'reference',
])

const BLOCK_ELEMENTS = new Set(['paragraph', 'list', 'table', 'renderMultiMedia'])

const GENERATED_MARK = /^\[\^(?:\d+|\?)\]$/
const UNMATCHED_MARK = '[^?]'
const SECTION_NUMBER = /^(\d+(?:\.\d+)*)\s/

type Mode = 'paragraph' | 'item' | 'cell' | 'inline'

type Context = {
  format: 'new' | 'old'
  footnoteMarks: Map<Element, string>
  footnoteById: Map<string, string>
  media: Map<string, Element>
  referencedMedia: Set<string>
  unknown: Map<string, number>
  // Elements already taken out of the text they sit in (an item's caption inside its paragraph).
  skip: Set<Element>
  problems: Problem[]
  sectionId: string | null
  tableIndex: number
  // How many table cells the parser is inside: a table met while it is above 0 is a nested table.
  cellDepth: number
}

// What rendering a run of nodes gives: raw text (white space not yet collapsed), the footnote marks written into
// it, the footnotes found in it, and the blocks (lists, tables, images) that sit inside it.
type Flow = { raw: string; marks: string[]; footnotes: Footnote[]; blocks: Block[] }

const newFlow = (): Flow => ({ raw: '', marks: [], footnotes: [], blocks: [] })

const isSpl = (element: Element): boolean => element.namespaceURI === SPL_NAMESPACE

// An element's name for the report: its local name, or `foreign:` and its local name outside the SPL namespace.
const name = (element: Element): string => (isSpl(element) ? element.localName ?? '' : `foreign:${element.localName ?? ''}`)

function childNodes(node: Node): Node[] {
  const out: Node[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child)
  return out
}

const isText = (node: Node): boolean => node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE

// Collapses white space in each line, drops empty lines, and counts the leading non-breaking spaces.
export function finish(raw: string): { text: string; indent: number } {
  const lead = /^[\s ]*/.exec(raw)?.[0] ?? ''
  const indent = [...lead].filter((character) => character === ' ').length
  const text = raw
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
  return { text, indent }
}

const oneLine = (raw: string): string => finish(raw).text.replace(/\n/g, ' ')

function countUnknown(context: Context, element: Element): void {
  const key = name(element)
  context.unknown.set(key, (context.unknown.get(key) ?? 0) + 1)
}

function render(nodes: readonly Node[], context: Context, mode: Mode, out: Flow): void {
  for (const node of nodes) {
    if (isText(node)) {
      // A line break in the source is only layout: only a br element (or a block boundary) breaks a line.
      out.raw += (node.nodeValue ?? '').replace(/[\r\n\t]/g, ' ')
      continue
    }
    if (!isElement(node)) continue
    const element = node
    const local = isSpl(element) ? element.localName : null
    switch (local) {
      case 'br':
        out.raw += '\n'
        break
      case 'content':
      case 'linkHtml':
      case 'col':
      case 'colgroup':
        render(childNodes(element), context, mode, out)
        break
      case 'caption':
        // A caption in running text is a marker or label of its own: it never runs into the next word.
        if (context.skip.has(element)) break
        out.raw += ' '
        render(childNodes(element), context, mode, out)
        out.raw += ' '
        break
      case 'sup':
        out.raw += '^{'
        render(childNodes(element), context, mode, out)
        out.raw += '}'
        break
      case 'sub':
        out.raw += '_{'
        render(childNodes(element), context, mode, out)
        out.raw += '}'
        break
      case 'footnote': {
        const mark = context.footnoteMarks.get(element) ?? UNMATCHED_MARK
        const inner = newFlow()
        render(childNodes(element), context, 'inline', inner)
        out.footnotes.push({ mark, text: finish(inner.raw).text }, ...inner.footnotes)
        out.blocks.push(...inner.blocks)
        out.marks.push(mark)
        out.raw += mark
        break
      }
      case 'footnoteRef': {
        const target = element.getAttribute('IDREF') ?? ''
        const mark = context.footnoteById.get(target)
        if (mark === undefined) {
          context.problems.push({ code: 'footnote-reference-unmatched', severity: 'warning', sectionId: context.sectionId })
        }
        out.marks.push(mark ?? UNMATCHED_MARK)
        out.raw += mark ?? UNMATCHED_MARK
        break
      }
      case 'paragraph':
        out.raw += '\n'
        render(childNodes(element), context, mode, out)
        out.raw += '\n'
        break
      case 'list': {
        const list = parseList(element, context)
        if (mode === 'item' || mode === 'paragraph') {
          out.blocks.push(list)
        } else {
          // In a cell, a footnote or a caption, a list becomes lines of the text.
          out.raw += `\n${listLines(list, out).join('\n')}\n`
        }
        break
      }
      case 'table':
        out.blocks.push(...parseTable(element, context))
        break
      case 'renderMultiMedia':
        out.blocks.push(imageFor(element, context))
        break
      case 'item':
        // An item outside a list: its text, on its own line.
        out.raw += '\n'
        render(childNodes(element), context, mode, out)
        out.raw += '\n'
        break
      default:
        if (local === null || !KNOWN_ELEMENTS.has(local)) countUnknown(context, element)
        render(childNodes(element), context, mode, out)
    }
  }
}

// A list's items as lines, for a list that sits where only text can go. Its footnotes, marks and blocks move to `out`.
function listLines(list: List, out: Flow): string[] {
  const lines: string[] = []
  for (const item of list.items) {
    const line = [item.caption, item.text].filter((part) => part !== null && part !== '').join(' ')
    if (line !== '') lines.push(line)
    out.marks.push(...item.marks)
    out.footnotes.push(...item.footnotes)
    for (const block of item.blocks) {
      if (block.type === 'list') lines.push(...listLines(block, out))
      else out.blocks.push(block)
    }
  }
  return lines
}

const firstElement = (node: Node): Element | undefined => {
  for (const child of childNodes(node)) {
    if (isElement(child)) return child
    if (isText(child) && (child.nodeValue ?? '').trim() !== '') return undefined
  }
  return undefined
}

// The item's caption: its own caption children, or a caption that opens the item's first paragraph.
function itemCaptions(element: Element): Element[] {
  const own = children(element, 'caption')
  if (own.length > 0) return own
  const first = firstElement(element)
  if (first === undefined || !isSpl(first) || first.localName !== 'paragraph') return []
  const opening = firstElement(first)
  return opening !== undefined && isSpl(opening) && opening.localName === 'caption' ? [opening] : []
}

function parseItem(element: Element, context: Context): ListItem {
  const captions = itemCaptions(element)
  for (const caption of captions) context.skip.add(caption)
  const rest = childNodes(element).filter((node) => !(isElement(node) && captions.includes(node)))
  const captionFlow = newFlow()
  for (const caption of captions) render(childNodes(caption), context, 'inline', captionFlow)
  const flow = newFlow()
  render(rest, context, 'item', flow)
  const caption = captions.length === 0 ? null : oneLine(captionFlow.raw)
  return {
    caption: caption === '' ? null : caption,
    text: finish(flow.raw).text,
    marks: [...captionFlow.marks, ...flow.marks],
    footnotes: [...captionFlow.footnotes, ...flow.footnotes],
    blocks: [...captionFlow.blocks, ...flow.blocks],
  }
}

function parseList(element: Element, context: Context): List {
  const items: ListItem[] = []
  for (const node of childNodes(element)) {
    if (isElement(node) && isSpl(node) && node.localName === 'item') {
      items.push(parseItem(node, context))
      continue
    }
    if (isText(node) && (node.nodeValue ?? '').trim() === '') continue
    // Anything else inside a list is kept as an item of its own.
    const flow = newFlow()
    render([node], context, 'item', flow)
    items.push({ caption: null, text: finish(flow.raw).text, marks: flow.marks, footnotes: flow.footnotes, blocks: flow.blocks })
  }
  return { type: 'list', ordered: element.getAttribute('listType') === 'ordered', items }
}

function imageFor(element: Element, context: Context): Image {
  const objectId = element.getAttribute('referencedObject') || null
  const media = objectId === null ? undefined : context.media.get(objectId)
  const captionFlow = newFlow()
  render(children(element, 'caption'), context, 'inline', captionFlow)
  const caption = oneLine(captionFlow.raw)
  return { type: 'image', objectId, text: media === undefined ? null : mediaText(media, context), caption: caption === '' ? null : caption }
}

function mediaText(media: Element, context: Context): string | null {
  const flow = newFlow()
  render(children(media, 'text'), context, 'inline', flow)
  const text = oneLine(flow.raw)
  return text === '' ? null : text
}

// Blocks from the children of a section's text (or a highlight's text): paragraphs, lists, tables and images
// as written; a run of loose text and inline elements becomes a paragraph of its own.
function parseBlocks(nodes: readonly Node[], context: Context): Block[] {
  const blocks: Block[] = []
  let run: Node[] = []
  const flush = (): void => {
    if (run.length === 0) return
    blocks.push(...paragraphFrom(run, context))
    run = []
  }
  for (const node of nodes) {
    const local = isElement(node) && isSpl(node) ? node.localName : null
    if (local === null || !BLOCK_ELEMENTS.has(local)) {
      run.push(node)
      continue
    }
    flush()
    const element = node as Element
    if (local === 'paragraph') blocks.push(...paragraphFrom(childNodes(element), context))
    else if (local === 'list') blocks.push(parseList(element, context))
    else if (local === 'table') blocks.push(...parseTable(element, context))
    else blocks.push(imageFor(element, context))
  }
  flush()
  return blocks
}

// A paragraph, then the blocks found inside it. Nothing at all if it holds no text, marks or blocks.
function paragraphFrom(nodes: readonly Node[], context: Context): Block[] {
  const flow = newFlow()
  render(nodes, context, 'paragraph', flow)
  const { text, indent } = finish(flow.raw)
  const out: Block[] = []
  if (text !== '' || flow.footnotes.length > 0) {
    const paragraph: Paragraph = { type: 'paragraph', text, indent, marks: flow.marks, footnotes: flow.footnotes }
    out.push(paragraph)
  }
  out.push(...flow.blocks)
  return out
}

// ---------- tables ----------

type ParsedCell = { cell: Cell; footnotes: Footnote[]; isTh: boolean; hasText: boolean; allBold: boolean }

const BOLD = /(^|\s)bold(\s|$)/i

// Whether every piece of text in a cell (outside footnotes) is inside bold content.
function boldness(cell: Element): { hasText: boolean; allBold: boolean } {
  let hasText = false
  let allBold = true
  const walk = (node: Node, bold: boolean): void => {
    if (isText(node)) {
      if ((node.nodeValue ?? '').replace(/[\s ]/g, '') !== '') {
        hasText = true
        if (!bold) allBold = false
      }
      return
    }
    if (!isElement(node)) return
    if (isSpl(node) && node.localName === 'footnote') return
    const here = bold || (isSpl(node) && node.localName === 'content' && BOLD.test(node.getAttribute('styleCode') ?? ''))
    for (const child of childNodes(node)) walk(child, here)
  }
  for (const child of childNodes(cell)) walk(child, false)
  return { hasText, allBold }
}

const span = (element: Element, attribute: string): number => {
  const value = element.getAttribute(attribute) ?? ''
  return /^[1-9]\d*$/.test(value) ? Number(value) : 1
}

function parseCell(element: Element, header: boolean, context: Context): ParsedCell {
  const flow = newFlow()
  context.cellDepth++
  render(childNodes(element), context, 'cell', flow)
  context.cellDepth--
  const { text, indent } = finish(flow.raw)
  const isTh = isSpl(element) && element.localName === 'th'
  return {
    cell: {
      text,
      header: header || isTh,
      rowSpan: span(element, 'rowspan'),
      colSpan: span(element, 'colspan'),
      indent,
      marks: flow.marks,
      blocks: flow.blocks,
    },
    footnotes: flow.footnotes,
    isTh,
    ...boldness(element),
  }
}

function parseRow(row: Element, header: boolean, context: Context, after: Block[]): ParsedCell[] {
  const cells: ParsedCell[] = []
  for (const node of childNodes(row)) {
    if (isElement(node)) {
      const local = isSpl(node) ? node.localName : null
      if (local !== 'td' && local !== 'th') countUnknown(context, node)
      cells.push(parseCell(node, header, context))
    } else if (isText(node) && (node.nodeValue ?? '').trim() !== '') {
      after.push(...paragraphFrom([node], context))
    }
  }
  return cells
}

export type Grid = { grid: ([number, number] | null)[][]; columns: number; rectangular: boolean; shortRows: number }

// The cells' positions once spans are applied, as in HTML: each cell takes the next free column of its row,
// and the widest row sets the table's width. A row that covers fewer columns is short: the positions after its
// last cell are empty (null). Not rectangular if two cells claim one position, a span runs past the last row,
// or a row leaves an empty position before a covered one.
export function buildGrid(rows: readonly (readonly { rowSpan: number; colSpan: number }[])[]): Grid {
  const occupied: ([number, number] | null)[][] = rows.map(() => [])
  let rectangular = true
  rows.forEach((row, r) => {
    let column = 0
    row.forEach((cell, index) => {
      while (occupied[r]?.[column]) column++
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        const target = occupied[r + dr]
        if (target === undefined) {
          rectangular = false
          continue
        }
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (target[column + dc]) rectangular = false
          else target[column + dc] = [r, index]
        }
      }
      column += cell.colSpan
    })
  })
  const columns = occupied.reduce((most, row) => Math.max(most, row.length), 0)
  const grid = occupied.map((row) => Array.from({ length: columns }, (_, c) => row[c] ?? null))
  let shortRows = 0
  for (const row of grid) {
    const covered = row.filter((position) => position !== null).length
    const lastCovered = row.reduce((last, position, c) => (position === null ? last : c), -1)
    if (lastCovered + 1 !== covered) rectangular = false
    else if (covered < columns) shortRows++
  }
  return { grid, columns, rectangular, shortRows }
}

const SUPERSCRIPT_MARK = /^\^\{([^}]{1,3})\}/
const SYMBOL_MARK = /^([*†‡§¶#]+)/

function tfootFootnotes(rows: Element[], context: Context, after: Block[]): TableFootnote[] {
  const out: TableFootnote[] = []
  for (const row of rows) {
    for (const parsed of parseRow(row, false, context, after)) {
      after.push(...parsed.cell.blocks)
      for (const footnote of parsed.footnotes) out.push({ mark: footnote.mark, text: footnote.text, source: 'tfoot', cells: [] })
      for (const line of parsed.cell.text.split('\n')) {
        if (line.replace(MARK_PATTERN, '').trim() === '') continue
        const mark = SUPERSCRIPT_MARK.exec(line)?.[1] ?? SYMBOL_MARK.exec(line)?.[1] ?? null
        out.push({ mark, text: line, source: 'tfoot', cells: [] })
      }
    }
  }
  return out
}

const SYMBOLS = '*†‡§¶#'
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whether a cell carries a footnote's mark: the same generated mark; the same superscript, exactly; or the same
// run of symbols, not part of a longer run (a cell marked ** does not carry *).
function refersTo(cell: Cell, footnote: TableFootnote, line: string | null): boolean {
  if (footnote.mark === null) return false
  if (GENERATED_MARK.test(footnote.mark)) return cell.marks.includes(footnote.mark)
  if (line !== null && SUPERSCRIPT_MARK.test(line)) return cell.text.includes(`^{${footnote.mark}}`)
  return new RegExp(`(?<![${SYMBOLS}])${escape(footnote.mark)}(?![${SYMBOLS}])`, 'u').test(cell.text)
}

function parseTable(element: Element, context: Context): Block[] {
  const index = context.tableIndex++
  if (context.cellDepth > 0) context.problems.push({ code: 'table-nested', severity: 'warning', sectionId: context.sectionId, table: index })
  const after: Block[] = []
  const captions: Element[] = []
  const written: { row: Element; header: boolean }[] = []
  const footRows: Element[] = []
  for (const node of childNodes(element)) {
    if (!isElement(node)) {
      if (isText(node) && (node.nodeValue ?? '').trim() !== '') after.push(...paragraphFrom([node], context))
      continue
    }
    const local = isSpl(node) ? node.localName : null
    if (local === 'caption') captions.push(node)
    else if (local === 'col' || local === 'colgroup') continue
    else if (local === 'tr') written.push({ row: node, header: false })
    else if (local === 'thead' || local === 'tbody' || local === 'tfoot') {
      for (const part of childNodes(node)) {
        if (isElement(part) && isSpl(part) && part.localName === 'tr') {
          if (local === 'tfoot') footRows.push(part)
          else written.push({ row: part, header: local === 'thead' })
        } else if (isElement(part)) {
          countUnknown(context, part)
          after.push(...paragraphFrom([part], context))
        } else if (isText(part) && (part.nodeValue ?? '').trim() !== '') {
          after.push(...paragraphFrom([part], context))
        }
      }
    } else {
      countUnknown(context, node)
      after.push(...paragraphFrom([node], context))
    }
  }

  const footnotes: TableFootnote[] = []
  let caption: string | null = null
  let captionSource: Table['captionSource'] = 'none'
  if (captions.length > 0) {
    const flow = newFlow()
    render(captions, context, 'cell', flow)
    caption = finish(flow.raw).text
    captionSource = 'element'
    after.push(...flow.blocks)
    for (const footnote of flow.footnotes) footnotes.push({ mark: footnote.mark, text: footnote.text, source: 'caption', cells: [] })
  }

  let rows = written.map(({ row, header }) => ({ header, cells: parseRow(row, header, context, after) }))
  const first = rows[0]?.cells
  const width = buildGrid(rows.map((row) => row.cells.map((parsed) => parsed.cell))).columns
  if (captionSource === 'none' && first?.length === 1 && first[0] !== undefined && width >= 2 && first[0].cell.colSpan === width && first[0].cell.rowSpan === 1) {
    const only = first[0]
    caption = only.cell.text
    captionSource = 'inferred'
    after.push(...only.cell.blocks)
    for (const footnote of only.footnotes) footnotes.push({ mark: footnote.mark, text: footnote.text, source: 'caption', cells: [] })
    rows = rows.slice(1)
    context.problems.push({ code: 'table-caption-inferred', severity: 'warning', sectionId: context.sectionId, table: index })
  }

  const cells = rows.map((row) => row.cells.map((parsed) => parsed.cell))
  const { grid, columns, rectangular, shortRows } = buildGrid(cells)
  if (!rectangular) context.problems.push({ code: 'table-not-rectangular', severity: 'error', sectionId: context.sectionId, table: index })
  if (rectangular && shortRows > 0) {
    context.problems.push({ code: 'table-row-short', severity: 'warning', sectionId: context.sectionId, table: index, count: shortRows })
  }
  // Facts a later step needs to judge whether a row is a column heading or a group label.
  const rowFacts = rows.map((row) => {
    const filled = row.cells.filter((parsed) => parsed.hasText)
    return { wholeBold: filled.length > 0 && filled.every((parsed) => parsed.isTh || parsed.allBold), filledCells: filled.length }
  })

  let headerRows = rows.filter((row) => row.header).length
  let headerSource: Table['headerSource'] = 'thead'
  if (headerRows === 0) {
    const qualifies = (row: ParsedCell[]): boolean =>
      row.length > 0 &&
      row.every((parsed) => parsed.isTh || !parsed.hasText || parsed.allBold) &&
      row.some((parsed) => parsed.isTh || (parsed.hasText && parsed.allBold))
    while (headerRows < rows.length - 1 && qualifies(rows[headerRows]?.cells ?? [])) headerRows++
    headerSource = headerRows > 0 ? 'inferred' : 'none'
    context.problems.push({
      code: headerRows > 0 ? 'table-header-inferred' : 'table-header-none',
      severity: 'warning',
      sectionId: context.sectionId,
      table: index,
    })
  }

  rows.forEach((row) => {
    for (const parsed of row.cells) {
      for (const footnote of parsed.footnotes) footnotes.push({ mark: footnote.mark, text: footnote.text, source: 'cell', cells: [] })
    }
  })
  const footLines = tfootFootnotes(footRows, context, after)
  footnotes.push(...footLines)
  for (const footnote of footnotes) {
    const line = footnote.source === 'tfoot' ? footnote.text : null
    cells.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (refersTo(cell, footnote, line)) footnote.cells.push([r, c])
      })
    })
    if (footnote.source === 'tfoot' && footnote.mark !== null && footnote.cells.length === 0) {
      context.problems.push({ code: 'footnote-mark-unmatched', severity: 'warning', sectionId: context.sectionId, table: index })
    }
  }

  const table: Table = { type: 'table', caption, captionSource, rows: cells, rowFacts, columns, grid, headerRows, headerSource, footnotes }
  return [table, ...after]
}

// ---------- sections, products, the document ----------

function parseSection(element: Element, parentPath: readonly string[], context: Context): Section {
  const id = children(element, 'id')[0]?.getAttribute('root') || null
  const code = children(element, 'code')[0]?.getAttribute('code') || null
  const titleFlow = newFlow()
  render(children(element, 'title'), context, 'inline', titleFlow)
  const titleText = oneLine(titleFlow.raw)
  const title = children(element, 'title').length === 0 || titleText === '' ? null : titleText
  const number = context.format === 'new' && title !== null ? (SECTION_NUMBER.exec(title)?.[1] ?? null) : null
  const path = title === null ? [...parentPath] : [...parentPath, title]

  const saved = { sectionId: context.sectionId, tableIndex: context.tableIndex }
  context.sectionId = id
  context.tableIndex = 0
  const blocks: Block[] = []
  const highlights: Block[] = []
  const sections: Section[] = []
  // Footnotes written in a title are kept as a paragraph at the head of the section.
  if (titleFlow.footnotes.length > 0) {
    blocks.push({ type: 'paragraph', text: '', indent: 0, marks: [], footnotes: titleFlow.footnotes })
  }
  blocks.push(...titleFlow.blocks)

  for (const node of childNodes(element)) {
    if (!isElement(node)) {
      if (isText(node) && (node.nodeValue ?? '').trim() !== '') blocks.push(...paragraphFrom([node], context))
      continue
    }
    const local = isSpl(node) ? node.localName : null
    switch (local) {
      case 'id':
      case 'code':
      case 'title':
      case 'effectiveTime':
      case 'subject':
        break
      case 'text':
        blocks.push(...parseBlocks(childNodes(node), context))
        break
      case 'excerpt':
        for (const part of childNodes(node)) {
          if (isElement(part) && isSpl(part) && part.localName === 'highlight') {
            for (const inner of childNodes(part)) {
              if (isElement(inner) && isSpl(inner) && inner.localName === 'text') highlights.push(...parseBlocks(childNodes(inner), context))
              else highlights.push(...parseBlocks([inner], context))
            }
          } else {
            highlights.push(...parseBlocks([part], context))
          }
        }
        break
      case 'component':
        for (const part of childNodes(node)) {
          if (isElement(part) && isSpl(part) && part.localName === 'section') {
            sections.push(parseSection(part, path, context))
          } else if (isElement(part) && isSpl(part) && part.localName === 'observationMedia') {
            const mediaId = part.getAttribute('ID') || null
            if (mediaId === null || !context.referencedMedia.has(mediaId)) {
              blocks.push({ type: 'image', objectId: mediaId, text: mediaText(part, context), caption: null })
            }
          } else {
            blocks.push(...parseBlocks([part], context))
          }
        }
        break
      default:
        blocks.push(...parseBlocks([node], context))
    }
  }

  if (title === null) context.problems.push({ code: 'section-untitled', severity: 'warning', sectionId: id })
  if (code === '42229-5') context.problems.push({ code: 'section-unclassified', severity: 'warning', sectionId: id })
  if (blocks.length > 0 && highlights.length === 0 && blocks.every((block) => block.type === 'image')) {
    context.problems.push({ code: 'section-images-only', severity: 'warning', sectionId: id })
  }
  context.sectionId = saved.sectionId
  context.tableIndex = saved.tableIndex
  return { id, code, title, number, path, blocks, highlights, sections }
}

const textOf = (element: Element | undefined): string | null => {
  if (element === undefined) return null
  const text = (element.textContent ?? '').replace(/[\s ]+/g, ' ').trim()
  return text === '' ? null : text
}

function parseProducts(document: Document): Product[] {
  const products: Product[] = []
  const subjects = document.getElementsByTagNameNS(SPL_NAMESPACE, 'subject')
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects.item(i)
    const outer = subject === null ? undefined : children(subject, 'manufacturedProduct')[0]
    if (outer === undefined) continue
    const product = children(outer, 'manufacturedProduct')[0] ?? children(outer, 'manufacturedMedicine')[0]
    if (product === undefined) continue
    const generic = children(product, 'asEntityWithGeneric')[0]
    const genericMedicine = generic === undefined ? undefined : children(generic, 'genericMedicine')[0]
    const ingredients: string[] = []
    const collect = (holder: Element): void => {
      for (const ingredient of [...children(holder, 'ingredient'), ...children(holder, 'activeIngredient')]) {
        const classCode = ingredient.getAttribute('classCode') ?? ''
        if (ingredient.localName === 'ingredient' && !classCode.startsWith('ACTI')) continue
        const substance = children(ingredient, 'ingredientSubstance')[0] ?? children(ingredient, 'activeIngredientSubstance')[0]
        const ingredientName = textOf(substance === undefined ? undefined : children(substance, 'name')[0])
        if (ingredientName !== null && !ingredients.includes(ingredientName)) ingredients.push(ingredientName)
      }
      for (const part of children(holder, 'part')) {
        const partProduct = children(part, 'partProduct')[0]
        if (partProduct !== undefined) collect(partProduct)
      }
    }
    collect(product)
    products.push({
      name: textOf(children(product, 'name')[0]),
      genericName: textOf(genericMedicine === undefined ? undefined : children(genericMedicine, 'name')[0]),
      activeIngredients: ingredients,
    })
  }
  return products
}

const KINDS: Readonly<Record<string, ParsedDocument['kind']>> = { '34391-3': 'prescription', '34390-5': 'otc' }

function hasText(section: Section): boolean {
  if (section.title !== null) return true
  const blockText = (block: Block): boolean => {
    if (block.type === 'paragraph') return block.text !== '' || block.footnotes.length > 0
    if (block.type === 'list') return block.items.some((item) => item.text !== '' || item.caption !== null || item.blocks.some(blockText))
    if (block.type === 'table') return block.caption !== null || block.rows.some((row) => row.some((cell) => cell.text !== ''))
    return block.text !== null || block.caption !== null
  }
  return section.blocks.some(blockText) || section.highlights.some(blockText) || section.sections.some(hasText)
}

export function parseDocument(bytes: Buffer): ParseResult & { unknown: Map<string, number> } {
  let xml: Document
  let identity: ReturnType<typeof readIdentity>
  try {
    xml = parseLabel(bytes)
    identity = readIdentity(xml)
  } catch (error) {
    if (error instanceof Refusal) {
      return { document: null, problems: [{ code: 'unreadable', severity: 'error', reason: error.reason }], unknown: new Map() }
    }
    throw error
  }

  const footnoteMarks = new Map<Element, string>()
  const footnoteById = new Map<string, string>()
  const allFootnotes = xml.getElementsByTagNameNS(SPL_NAMESPACE, 'footnote')
  for (let i = 0; i < allFootnotes.length; i++) {
    const footnote = allFootnotes.item(i)
    if (footnote === null) continue
    const mark = `[^${i + 1}]`
    footnoteMarks.set(footnote, mark)
    const footnoteId = footnote.getAttribute('ID')
    if (footnoteId) footnoteById.set(footnoteId, mark)
  }
  const media = new Map<string, Element>()
  const allMedia = xml.getElementsByTagNameNS(SPL_NAMESPACE, 'observationMedia')
  for (let i = 0; i < allMedia.length; i++) {
    const item = allMedia.item(i)
    const mediaId = item?.getAttribute('ID')
    if (item && mediaId) media.set(mediaId, item)
  }
  const referencedMedia = new Set<string>()
  const references = xml.getElementsByTagNameNS(SPL_NAMESPACE, 'renderMultiMedia')
  for (let i = 0; i < references.length; i++) {
    const target = references.item(i)?.getAttribute('referencedObject')
    if (target) referencedMedia.add(target)
  }

  const format = countStructure(xml).format
  const context: Context = {
    format,
    footnoteMarks,
    footnoteById,
    media,
    referencedMedia,
    unknown: new Map(),
    skip: new Set(),
    problems: [],
    sectionId: null,
    tableIndex: 0,
    cellDepth: 0,
  }

  const root = xml.documentElement
  const sections: Section[] = []
  const body = root === null ? undefined : children(root, 'component').flatMap((component) => children(component, 'structuredBody'))[0]
  if (body !== undefined) {
    for (const component of children(body, 'component')) {
      for (const section of children(component, 'section')) sections.push(parseSection(section, [], context))
    }
  }
  const titleElement = root === null ? undefined : children(root, 'title')[0]
  const titleFlow = newFlow()
  if (titleElement !== undefined) render([titleElement], context, 'inline', titleFlow)
  const title = oneLine(titleFlow.raw)

  const document: ParsedDocument = {
    setId: identity.setId,
    version: identity.version,
    documentId: identity.documentId,
    effectiveTime: identity.effectiveTime,
    documentTypeCode: identity.documentTypeCode,
    kind: KINDS[identity.documentTypeCode] ?? 'other',
    format,
    title: title === '' ? null : title,
    products: parseProducts(xml),
    sections,
  }

  const problems = context.problems
  if (!sections.some(hasText)) problems.push({ code: 'no-sections', severity: 'error' })
  const conservation = checkConservation(xml, document)
  if (conservation.missing > 0 || conservation.extra > 0) {
    problems.push({ code: 'text-not-conserved', severity: 'error', missing: conservation.missing, extra: conservation.extra })
  }
  for (const [element, count] of [...context.unknown.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    problems.push({ code: 'element-unknown', severity: 'warning', element, count })
  }
  return { document, problems, unknown: context.unknown }
}
