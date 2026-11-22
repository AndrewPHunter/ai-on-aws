// The check that no text was lost. It does not share the parser's traversal.
//
// Side A: every text node under the label's body (structuredBody), taken by a walk that knows nothing about
//   sections, blocks or tables. Two rules only: the product data (`subject` elements) is skipped, because it is
//   structured data parsed into products, not prose; and every element boundary separates words, except
//   `content` and `linkHtml`, which only style or link text and may sit inside a word.
// Side B: every piece of text in the parsed document: titles, paragraphs and their footnotes, list items with
//   their captions and footnotes, table captions, cells and footnotes, image text (once per object) and
//   captions, Highlights. The footnote marks the parser writes are removed first.
// Each side is cut into tokens at every character that is not a letter or a digit. The two collections, with
// their counts, must be equal.

import type { Document, Node } from '@xmldom/xmldom'

import { SPL_NAMESPACE } from '../spl.ts'
import { MARK_PATTERN } from './model.ts'
import type { Block, ParsedDocument, Section } from './model.ts'

const TRANSPARENT = new Set(['content', 'linkHtml'])

export function sideA(document: Document): string {
  const parts: string[] = []
  const bodies = document.getElementsByTagNameNS(SPL_NAMESPACE, 'structuredBody')
  const walk = (node: Node): void => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      parts.push(node.nodeValue ?? '')
      return
    }
    if (node.nodeType !== 1) return
    const local = (node as unknown as { localName: string }).localName
    if (local === 'subject') return
    const boundary = !TRANSPARENT.has(local)
    if (boundary) parts.push(' ')
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child)
    if (boundary) parts.push(' ')
  }
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies.item(i)
    if (body) walk(body)
  }
  return parts.join('')
}

export function sideB(document: ParsedDocument): string {
  const parts: string[] = []
  const seenImages = new Set<string>()
  const add = (text: string | null): void => {
    if (text !== null) parts.push(text.replace(MARK_PATTERN, ' '))
  }
  const blocks = (list: readonly Block[]): void => {
    for (const block of list) {
      if (block.type === 'paragraph') {
        add(block.text)
        for (const footnote of block.footnotes) add(footnote.text)
      } else if (block.type === 'list') {
        for (const item of block.items) {
          add(item.caption)
          add(item.text)
          for (const footnote of item.footnotes) add(footnote.text)
          blocks(item.blocks)
        }
      } else if (block.type === 'table') {
        add(block.caption)
        for (const row of block.rows) {
          for (const cell of row) {
            add(cell.text)
            blocks(cell.blocks)
          }
        }
        for (const footnote of block.footnotes) add(footnote.text)
      } else {
        if (block.objectId === null || !seenImages.has(block.objectId)) add(block.text)
        if (block.objectId !== null) seenImages.add(block.objectId)
        add(block.caption)
      }
    }
  }
  const sections = (list: readonly Section[]): void => {
    for (const section of list) {
      add(section.title)
      blocks(section.blocks)
      blocks(section.highlights)
      sections(section.sections)
    }
  }
  sections(document.sections)
  return parts.join(' ')
}

export function tokens(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of text.split(/[^\p{L}\p{N}]+/u)) {
    if (token !== '') counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

// Tokens of A not matched in B (missing), and of B not matched in A (extra), counted with multiplicity.
export function compareTokens(a: string, b: string): { missing: number; extra: number } {
  const left = tokens(a)
  const right = tokens(b)
  let missing = 0
  let extra = 0
  for (const [token, count] of left) missing += Math.max(0, count - (right.get(token) ?? 0))
  for (const [token, count] of right) extra += Math.max(0, count - (left.get(token) ?? 0))
  return { missing, extra }
}

export const checkConservation = (xml: Document, parsed: ParsedDocument): { missing: number; extra: number } =>
  compareTokens(sideA(xml), sideB(parsed))
