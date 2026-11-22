// The check that nothing was lost or doubled in splitting. It takes its own walk of the parsed document.
//
// One side: every word in the document's blocks and Highlights blocks (titles are not: they are in each chunk's
// context). The other: every word in the chunks' text, less the words of their repeated lines. The parser's
// footnote marks are removed from both. Each side is cut into tokens at every character that is not a letter or a
// digit; the two collections, with their counts, must be equal.

import { compareTokens } from '../parse/conserve.ts'
import { MARK_PATTERN } from '../parse/model.ts'
import type { Block, ParsedDocument, Section } from '../parse/model.ts'
import type { Chunk } from './model.ts'

export function documentWords(document: ParsedDocument): string {
  const parts: string[] = []
  const add = (text: string | null): void => {
    if (text !== null) parts.push(text)
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
        add(block.text)
        add(block.caption)
      }
    }
  }
  const sections = (list: readonly Section[]): void => {
    for (const section of list) {
      blocks(section.blocks)
      blocks(section.highlights)
      sections(section.sections)
    }
  }
  sections(document.sections)
  return parts.join(' ').replace(MARK_PATTERN, ' ')
}

// The chunks' words, less their repeated lines. A repeated line is taken out of its chunk's text once.
export function chunkWords(chunks: readonly Chunk[]): { kept: string; repeated: string } {
  const kept: string[] = []
  const repeated: string[] = []
  for (const chunk of chunks) {
    kept.push(chunk.text)
    repeated.push(...chunk.repeated)
  }
  return { kept: kept.join('\n').replace(MARK_PATTERN, ' '), repeated: repeated.join('\n').replace(MARK_PATTERN, ' ') }
}

export function checkChunks(document: ParsedDocument, chunks: readonly Chunk[]): { missing: number; extra: number } {
  const { kept, repeated } = chunkWords(chunks)
  // Words of the chunks less the repeated ones, compared with the document: A is the document, B the chunks.
  // Repeated lines are moved to the document's side, which is the same as taking them out of the chunks'.
  return compareTokens(`${documentWords(document)}\n${repeated}`, kept)
}
