// Small readers over a parse result, for the parser's tests.

import assert from 'node:assert/strict'

import type { Block, ParsedDocument, Paragraph, Problem, Section, Table } from '../../src/parse/model.ts'
import type { Fixture } from './labels.ts'
import { parse } from './labels.ts'

export function parsedOk(label: Fixture): { document: ParsedDocument; problems: Problem[] } {
  const result = parse(label)
  assert.ok(result.document, 'no document')
  return { document: result.document, problems: result.problems }
}

export function sectionById(sections: readonly Section[], id: string): Section {
  for (const section of sections) {
    if (section.id === id) return section
    try {
      return sectionById(section.sections, id)
    } catch {
      // not under this one
    }
  }
  throw new Error(`no section ${id}`)
}

export const errors = (problems: readonly Problem[]): Problem[] => problems.filter((problem) => problem.severity === 'error')
export const withCode = (problems: readonly Problem[], code: string): Problem[] => problems.filter((problem) => problem.code === code)

export function tables(blocks: readonly Block[]): Table[] {
  return blocks.filter((block): block is Table => block.type === 'table')
}

export function paragraphs(blocks: readonly Block[]): Paragraph[] {
  return blocks.filter((block): block is Paragraph => block.type === 'paragraph')
}

export function onlyTable(label: Fixture, sectionId: string): Table {
  const { document } = parsedOk(label)
  const [table] = tables(sectionById(document.sections, sectionId).blocks)
  assert.ok(table, 'no table')
  return table
}
