// The parse command: every label in the manifest, from its fetched XML to a parsed document and one entry in
// the parse report. The report holds numbers, codes and identifiers only. A label with an error gets no parsed
// file (one left by an earlier run is removed); a label with only warnings is written.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { readManifest } from '../fetch.ts'
import { labelXmlPath, readIfPresent, sha256, writeIfChanged } from '../files.ts'
import { isGuid } from '../schema.ts'
import type { Block, ParsedDocument, Problem, Section, Table } from './model.ts'
import { ERROR_CODES, WARNING_CODES } from './model.ts'
import { parseDocument } from './parser.ts'

export const parsedPath = (dataDir: string, setId: string, version: number): string => {
  if (!isGuid(setId) || !Number.isInteger(version) || version < 1) throw new Error('refusing to build a path from an invalid set id or version')
  return join(dataDir, 'parsed', setId, `${version}.json`)
}

type Counts = { parsed: number; excluded: number }

export type ParseReport = {
  counts: { labels: number; parsed: number; excluded: number }
  excludedBy: Record<string, number>
  byKind: Record<'prescription' | 'otc' | 'other', Counts>
  byFormat: Record<'new' | 'old' | 'unknown', Counts>
  warnings: Record<string, { count: number; labels: number }>
  tables: {
    total: number
    header: { thead: number; inferred: number; none: number }
    caption: { element: number; inferred: number; none: number }
    nested: number
    // Tables with at least one wholly bold row after their header rows.
    boldRowAfterHeader: number
    // Tables with an inferred header, by the number of header rows.
    inferredHeaderRows: { one: number; two: number; three: number; moreThanThree: number }
    // Inferred headers that include a row with exactly one filled cell.
    inferredHeaderWithOneFilledRow: number
  }
  // Sections with no title, by their section code ('none' for a section with no code).
  untitledSectionsByCode: Record<string, number>
  unknownElements: Record<string, number>
  labels: {
    setId: string
    version: number
    kind: 'prescription' | 'otc' | 'other'
    format: 'new' | 'old' | 'unknown'
    status: 'parsed' | 'excluded'
    problems: Problem[]
  }[]
}

const IDENTIFIER = /^[A-Za-z0-9.:_-]{1,128}$/
const ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/
const REASON = /^[a-z0-9-]{1,64}$/

// Only identifiers, codes, element names and numbers leave the parser for the report.
function forReport(problem: Problem): Problem {
  const out: Problem = { code: problem.code, severity: problem.severity }
  if (problem.sectionId !== undefined) out.sectionId = problem.sectionId !== null && IDENTIFIER.test(problem.sectionId) ? problem.sectionId : null
  if (problem.table !== undefined) out.table = problem.table
  if (problem.count !== undefined) out.count = problem.count
  if (problem.missing !== undefined) out.missing = problem.missing
  if (problem.extra !== undefined) out.extra = problem.extra
  if (problem.element !== undefined) out.element = ELEMENT_NAME.test(problem.element) ? problem.element : 'not-an-element-name'
  if (problem.reason !== undefined) out.reason = REASON.test(problem.reason) ? problem.reason : 'other'
  return out
}

const KIND: Readonly<Record<string, 'prescription' | 'otc'>> = { '34391-3': 'prescription', '34390-5': 'otc' }

function eachTable(sections: readonly Section[], visit: (table: Table, nested: boolean) => void): void {
  const blocks = (list: readonly Block[], nested: boolean): void => {
    for (const block of list) {
      if (block.type === 'table') {
        visit(block, nested)
        for (const row of block.rows) for (const cell of row) blocks(cell.blocks, true)
      } else if (block.type === 'list') {
        for (const item of block.items) blocks(item.blocks, nested)
      }
    }
  }
  for (const section of sections) {
    blocks(section.blocks, false)
    blocks(section.highlights, false)
    eachTable(section.sections, visit)
  }
}

const sorted = <T>(record: Map<string, T>): Record<string, T> =>
  Object.fromEntries([...record.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export type ParseOptions = { corpusDir: string; dataDir: string; log: (line: string) => void }

export async function runParse(options: ParseOptions): Promise<ParseReport> {
  const manifest = await readManifest(options.corpusDir)
  const report: ParseReport = {
    counts: { labels: manifest.labels.length, parsed: 0, excluded: 0 },
    excludedBy: {},
    byKind: { prescription: { parsed: 0, excluded: 0 }, otc: { parsed: 0, excluded: 0 }, other: { parsed: 0, excluded: 0 } },
    byFormat: { new: { parsed: 0, excluded: 0 }, old: { parsed: 0, excluded: 0 }, unknown: { parsed: 0, excluded: 0 } },
    warnings: {},
    tables: {
      total: 0,
      header: { thead: 0, inferred: 0, none: 0 },
      caption: { element: 0, inferred: 0, none: 0 },
      nested: 0,
      boldRowAfterHeader: 0,
      inferredHeaderRows: { one: 0, two: 0, three: 0, moreThanThree: 0 },
      inferredHeaderWithOneFilledRow: 0,
    },
    untitledSectionsByCode: {},
    unknownElements: {},
    labels: [],
  }
  const excludedBy = new Map<string, number>(ERROR_CODES.map((code) => [code, 0]))
  const warnings = new Map<string, { count: number; labels: number }>(WARNING_CODES.map((code) => [code, { count: 0, labels: 0 }]))
  const unknown = new Map<string, number>()
  const untitled = new Map<string, number>()
  const CODE = /^\d{1,7}-\d$/
  const countUntitled = (sections: readonly Section[]): void => {
    for (const section of sections) {
      if (section.title === null) {
        const key = section.code !== null && CODE.test(section.code) ? section.code : 'none'
        untitled.set(key, (untitled.get(key) ?? 0) + 1)
      }
      countUntitled(section.sections)
    }
  }

  for (const entry of manifest.labels) {
    const kind = KIND[entry.documentTypeCode] ?? 'other'
    const bytes = await readIfPresent(labelXmlPath(options.dataDir, entry.setId, entry.version))
    let document: ParsedDocument | null = null
    let problems: Problem[]
    if (bytes === undefined) {
      problems = [{ code: 'unreadable', severity: 'error', reason: 'missing' }]
    } else if (sha256(bytes) !== entry.xmlSha256) {
      problems = [{ code: 'unreadable', severity: 'error', reason: 'checksum-mismatch' }]
    } else {
      const result = parseDocument(bytes)
      document = result.document
      problems = result.problems
      for (const [element, count] of result.unknown) {
        const key = ELEMENT_NAME.test(element) ? element : 'not-an-element-name'
        unknown.set(key, (unknown.get(key) ?? 0) + count)
      }
    }
    const errors = problems.filter((problem) => problem.severity === 'error')
    const status = errors.length === 0 && document !== null ? 'parsed' : 'excluded'
    const format = document?.format ?? 'unknown'
    const target = parsedPath(options.dataDir, entry.setId, entry.version)
    if (status === 'parsed' && document !== null) {
      const warningsOnly = problems.map(forReport)
      await writeIfChanged(target, `${JSON.stringify({ document, warnings: warningsOnly }, null, 2)}\n`)
    } else {
      await rm(target, { force: true })
    }

    report.counts[status]++
    report.byKind[kind][status]++
    report.byFormat[format][status]++
    for (const code of new Set(errors.map((problem) => problem.code))) excludedBy.set(code, (excludedBy.get(code) ?? 0) + 1)
    const touched = new Set<string>()
    for (const problem of problems) {
      if (problem.severity !== 'warning') continue
      const tally = warnings.get(problem.code) ?? { count: 0, labels: 0 }
      tally.count += problem.code === 'element-unknown' ? (problem.count ?? 1) : 1
      if (!touched.has(problem.code)) {
        tally.labels++
        touched.add(problem.code)
      }
      warnings.set(problem.code, tally)
    }
    if (document !== null) {
      countUntitled(document.sections)
      eachTable(document.sections, (table, nested) => {
        const stats = report.tables
        stats.total++
        stats.header[table.headerSource]++
        stats.caption[table.captionSource]++
        if (nested) stats.nested++
        if (table.rowFacts.slice(table.headerRows).some((facts) => facts.wholeBold)) stats.boldRowAfterHeader++
        if (table.headerSource === 'inferred') {
          const n = table.headerRows
          stats.inferredHeaderRows[n === 1 ? 'one' : n === 2 ? 'two' : n === 3 ? 'three' : 'moreThanThree']++
          if (table.rowFacts.slice(0, n).some((facts) => facts.filledCells === 1)) stats.inferredHeaderWithOneFilledRow++
        }
      })
    }
    report.labels.push({ setId: entry.setId, version: entry.version, kind, format, status, problems: problems.map(forReport) })
  }

  report.excludedBy = sorted(excludedBy)
  report.warnings = sorted(warnings)
  report.unknownElements = sorted(unknown)
  report.untitledSectionsByCode = sorted(untitled)
  await writeIfChanged(join(options.dataDir, 'parse-report.json'), `${JSON.stringify(report, null, 2)}\n`)

  options.log(`labels: ${report.counts.labels}; parsed ${report.counts.parsed}, excluded ${report.counts.excluded}`)
  for (const [code, count] of Object.entries(report.excludedBy)) if (count > 0) options.log(`  excluded, ${code}: ${count}`)
  for (const [code, tally] of Object.entries(report.warnings)) options.log(`  warning ${code}: ${tally.count} in ${tally.labels} labels`)
  for (const [element, count] of Object.entries(report.unknownElements)) options.log(`  unknown element ${element}: ${count}`)
  return report
}
