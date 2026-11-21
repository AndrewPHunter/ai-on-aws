// The census: counts and codes for every fetched label, and how much of the benchmark's text is found word for
// word in the fetched versions. It reads only the data folder and the two tracked files, makes no request,
// and writes no label text.

import { join } from 'node:path'

import { parseLabelRecords, parseQuestions } from './benchmark.ts'
import type { LabelRecord, Question } from './benchmark.ts'
import { readBenchmarkPin, readManifest, InputError } from './fetch.ts'
import { benchmarkPath, labelXmlPath, readIfPresent, sha256, writeIfChanged } from './files.ts'
import { SPL_NAMESPACE, children, documentText, isElement, parseLabel } from './spl.ts'
import type { Document, Element } from '@xmldom/xmldom'

export const NORMALISATION_RULE =
  'Both sides are normalised the same way before comparing: U+00A0 (non-breaking space) becomes U+0020; every run ' +
  'of characters in the ECMAScript \\s class (Unicode white space, line terminators and U+FEFF) becomes one U+0020; ' +
  'leading and trailing spaces are removed. Nothing else is changed: case, punctuation and every other character ' +
  'are compared as they are.'

export const TEXT_RULE =
  "The text of a fetched version is every text node of its XML (CDATA sections included), joined in document order " +
  'with nothing between them.'

export const MATCH_RULE =
  'A passage is found when its normalised text occurs as a substring of the normalised text of the fetched version. ' +
  'Answer passages are the context passages of the benchmark questions on that set id whose has_answer is true, ' +
  'each counted as often as it is listed. Chunks are the strings in the labels file record for that set id.'

export const DRUG_NAME_RULE =
  "drugNamePresent: the labels file's drug_name for the set id, normalised as above and lowercased, occurs in the " +
  'normalised, lowercased text of the fetched version.'

export const DISTRIBUTION_RULE =
  'Per label, the share found: full = all; mostly = at least 80% but not all; partly = more than 0% and less than ' +
  '80%; none = 0%; noPassages = the label has nothing to match.'

export const COUNT_RULES = {
  format: 'new if the label has an excerpt element with a highlight child, or a section whose code is 43685-7; otherwise old',
  sections: 'section elements at any depth',
  unclassifiedSections: 'sections whose own code is 42229-5',
  untitledSections: 'sections with no title child, or whose title has no text after normalisation',
  tables: 'table elements',
  tablesWithoutThead: 'tables with no thead child',
  spanningCells: 'td and th elements carrying a rowspan or colspan attribute, whatever its value',
  footnotes: 'footnote elements',
  images: 'observationMedia elements',
  products: 'manufacturedProduct elements whose parent is a subject element',
} as const

export const normalise = (text: string): string => text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

export type Matched = { total: number; found: number }

export type LabelCensus = {
  setId: string
  version: number
  documentTypeCode: string
  drugNamePresent: boolean
  xmlBytes: number
  format: 'new' | 'old'
  sections: number
  unclassifiedSections: number
  untitledSections: number
  tables: number
  tablesWithoutThead: number
  spanningCells: number
  footnotes: number
  images: number
  products: number
  questions: Record<string, number>
  highlightsQuestions: number
  answerPassages: Matched
  chunks: Matched
}

const elements = (document: Document, localName: string): Element[] => {
  const list = document.getElementsByTagNameNS(SPL_NAMESPACE, localName)
  const out: Element[] = []
  for (let index = 0; index < list.length; index++) {
    const item = list.item(index)
    if (item) out.push(item)
  }
  return out
}

const ownCode = (section: Element): string | undefined => children(section, 'code')[0]?.getAttribute('code') ?? undefined

// The structural counts of one parsed label.
export function countStructure(document: Document): Pick<
  LabelCensus,
  | 'format'
  | 'sections'
  | 'unclassifiedSections'
  | 'untitledSections'
  | 'tables'
  | 'tablesWithoutThead'
  | 'spanningCells'
  | 'footnotes'
  | 'images'
  | 'products'
> {
  const sections = elements(document, 'section')
  const tables = elements(document, 'table')
  const cells = [...elements(document, 'td'), ...elements(document, 'th')]
  const highlights = elements(document, 'excerpt').some((excerpt) => children(excerpt, 'highlight').length > 0)
  const isNew = highlights || sections.some((section) => ownCode(section) === '43685-7')
  return {
    format: isNew ? 'new' : 'old',
    sections: sections.length,
    unclassifiedSections: sections.filter((section) => ownCode(section) === '42229-5').length,
    untitledSections: sections.filter((section) => {
      const [title] = children(section, 'title')
      return title === undefined || normalise(title.textContent ?? '') === ''
    }).length,
    tables: tables.length,
    tablesWithoutThead: tables.filter((table) => children(table, 'thead').length === 0).length,
    spanningCells: cells.filter((cell) => cell.hasAttribute('rowspan') || cell.hasAttribute('colspan')).length,
    footnotes: elements(document, 'footnote').length,
    images: elements(document, 'observationMedia').length,
    products: elements(document, 'manufacturedProduct').filter((product) => {
      const parent = product.parentNode
      return parent !== null && isElement(parent) && parent.namespaceURI === SPL_NAMESPACE && parent.localName === 'subject'
    }).length,
  }
}

// How many of `passages` occur word for word, after normalisation, in `normalisedText`.
export function countFound(normalisedText: string, passages: readonly string[]): Matched {
  let found = 0
  for (const passage of passages) if (normalisedText.includes(normalise(passage))) found++
  return { total: passages.length, found }
}

export type Distribution = { full: number; mostly: number; partly: number; none: number; noPassages: number }

export function bucket(matched: Matched): keyof Distribution {
  if (matched.total === 0) return 'noPassages'
  if (matched.found === matched.total) return 'full'
  if (matched.found === 0) return 'none'
  return matched.found / matched.total >= 0.8 ? 'mostly' : 'partly'
}

export type CensusOptions = { corpusDir: string; dataDir: string; log: (line: string) => void; warn: (line: string) => void }

export type Census = {
  rules: Record<string, unknown>
  totals: Record<string, number>
  documentTypes: Record<string, number>
  formats: { new: number; old: number }
  questions: {
    byTask: Record<string, number>
    highlights: number
    onLabelsNotCounted: number
    contextPassages: { hasAnswerTrue: number; hasAnswerFalse: number; hasAnswerAbsent: number }
  }
  matching: {
    answerPassages: Matched & { share: number | null; labels: Distribution }
    chunks: Matched & { share: number | null; labels: Distribution }
  }
  notCounted: { setId: string; version: number; reason: 'missing' | 'checksum-mismatch' }[]
  labels: LabelCensus[]
}

const sortedRecord = (entries: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

const add = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by)
}

const share = (matched: Matched): number | null =>
  matched.total === 0 ? null : Math.round((matched.found / matched.total) * 10000) / 10000

async function readBenchmarkFile(dataDir: string, role: 'labels' | 'qa', sha: string): Promise<Buffer> {
  const bytes = await readIfPresent(benchmarkPath(dataDir, role))
  if (bytes === undefined) throw new InputError(`the benchmark ${role} file is not in the data folder; run knowledge/fetch.sh`)
  if (sha256(bytes) !== sha) throw new InputError(`the benchmark ${role} file does not match its pinned checksum; run knowledge/fetch.sh`)
  return bytes
}

export async function runCensus(options: CensusOptions): Promise<{ census: Census; exitCode: 0 | 1 }> {
  const pin = await readBenchmarkPin(options.corpusDir)
  const manifest = await readManifest(options.corpusDir)
  const records = parseLabelRecords(await readBenchmarkFile(options.dataDir, 'labels', pin.files.labels.sha256))
  const questions = parseQuestions(await readBenchmarkFile(options.dataDir, 'qa', pin.files.qa.sha256))

  const recordBySetId = new Map<string, LabelRecord>()
  for (const record of records) if (!recordBySetId.has(record.set_id)) recordBySetId.set(record.set_id, record)
  const questionsBySetId = new Map<string, Question[]>()
  for (const question of questions) {
    const list = questionsBySetId.get(question.set_id) ?? []
    list.push(question)
    questionsBySetId.set(question.set_id, list)
  }

  const labels: LabelCensus[] = []
  const notCounted: Census['notCounted'] = []
  for (const entry of manifest.labels) {
    const bytes = await readIfPresent(labelXmlPath(options.dataDir, entry.setId, entry.version))
    if (bytes === undefined) {
      notCounted.push({ setId: entry.setId, version: entry.version, reason: 'missing' })
      continue
    }
    if (sha256(bytes) !== entry.xmlSha256) {
      notCounted.push({ setId: entry.setId, version: entry.version, reason: 'checksum-mismatch' })
      continue
    }
    const document = parseLabel(bytes)
    const text = normalise(documentText(document))
    const record = recordBySetId.get(entry.setId)
    const onLabel = questionsBySetId.get(entry.setId) ?? []
    const byTask = new Map<string, number>()
    for (const question of onLabel) add(byTask, question.task)
    const answerPassages = onLabel.flatMap((question) =>
      question.context.filter((passage) => passage.has_answer === true).map((passage) => passage.text),
    )
    const drugName = record === undefined ? '' : normalise(record.drug_name).toLowerCase()
    labels.push({
      setId: entry.setId,
      version: entry.version,
      documentTypeCode: entry.documentTypeCode,
      drugNamePresent: drugName !== '' && text.toLowerCase().includes(drugName),
      xmlBytes: bytes.length,
      ...countStructure(document),
      questions: sortedRecord(byTask),
      highlightsQuestions: onLabel.filter((question) => question.source === 'highlights').length,
      answerPassages: countFound(text, answerPassages),
      chunks: countFound(text, record?.chunks ?? []),
    })
  }

  const counted = new Set(labels.map((label) => label.setId))
  const totals = new Map<string, number>()
  const documentTypes = new Map<string, number>()
  const formats = { new: 0, old: 0 }
  const answer: Matched = { total: 0, found: 0 }
  const chunk: Matched = { total: 0, found: 0 }
  const answerLabels: Distribution = { full: 0, mostly: 0, partly: 0, none: 0, noPassages: 0 }
  const chunkLabels: Distribution = { full: 0, mostly: 0, partly: 0, none: 0, noPassages: 0 }
  add(totals, 'labels', 0)
  for (const label of labels) {
    add(totals, 'labels')
    add(totals, 'drugNamePresent', label.drugNamePresent ? 1 : 0)
    add(totals, 'xmlBytes', label.xmlBytes)
    for (const key of Object.keys(COUNT_RULES) as (keyof typeof COUNT_RULES)[]) {
      if (key !== 'format') add(totals, key, label[key])
    }
    add(documentTypes, label.documentTypeCode)
    formats[label.format]++
    answer.total += label.answerPassages.total
    answer.found += label.answerPassages.found
    chunk.total += label.chunks.total
    chunk.found += label.chunks.found
    answerLabels[bucket(label.answerPassages)]++
    chunkLabels[bucket(label.chunks)]++
  }

  const byTask = new Map<string, number>()
  let highlights = 0
  let onLabelsNotCounted = 0
  const contextPassages = { hasAnswerTrue: 0, hasAnswerFalse: 0, hasAnswerAbsent: 0 }
  for (const question of questions) {
    add(byTask, question.task)
    if (question.source === 'highlights') highlights++
    if (!counted.has(question.set_id)) onLabelsNotCounted++
    for (const passage of question.context) {
      if (passage.has_answer === true) contextPassages.hasAnswerTrue++
      else if (passage.has_answer === false) contextPassages.hasAnswerFalse++
      else contextPassages.hasAnswerAbsent++
    }
  }

  const census: Census = {
    rules: {
      text: TEXT_RULE,
      normalisation: NORMALISATION_RULE,
      matching: MATCH_RULE,
      drugName: DRUG_NAME_RULE,
      distribution: DISTRIBUTION_RULE,
      counts: COUNT_RULES,
    },
    totals: Object.fromEntries(totals),
    documentTypes: sortedRecord(documentTypes),
    formats,
    questions: { byTask: sortedRecord(byTask), highlights, onLabelsNotCounted, contextPassages },
    matching: {
      answerPassages: { ...answer, share: share(answer), labels: answerLabels },
      chunks: { ...chunk, share: share(chunk), labels: chunkLabels },
    },
    notCounted,
    labels,
  }
  await writeIfChanged(join(options.dataDir, 'census.json'), `${JSON.stringify(census, null, 2)}\n`)

  for (const label of notCounted) options.warn(`not counted: ${label.setId} version ${label.version} (${label.reason})`)
  for (const line of summarise(census)) options.log(line)
  return { census, exitCode: notCounted.length === 0 ? 0 : 1 }
}

const percent = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

export function summarise(census: Census): string[] {
  const lines = [`Census of ${census.totals.labels ?? 0} labels (${census.notCounted.length} in the manifest not counted)`]
  lines.push('', 'Totals:')
  for (const [key, value] of Object.entries(census.totals)) lines.push(`  ${key}: ${value}`)
  lines.push('', 'Document types:')
  for (const [code, count] of Object.entries(census.documentTypes)) lines.push(`  ${code}: ${count}`)
  lines.push('', `Formats: new ${census.formats.new}, old ${census.formats.old}`)
  lines.push('', 'Benchmark questions:')
  for (const [task, count] of Object.entries(census.questions.byTask)) lines.push(`  ${task}: ${count}`)
  lines.push(`  source highlights: ${census.questions.highlights}`)
  lines.push(`  on labels not counted: ${census.questions.onLabelsNotCounted}`)
  const passages = census.questions.contextPassages
  lines.push(`  context passages: has_answer true ${passages.hasAnswerTrue}, false ${passages.hasAnswerFalse}, absent ${passages.hasAnswerAbsent}`)
  for (const [name, matched] of Object.entries(census.matching)) {
    const d = matched.labels
    lines.push(
      '',
      `${name}: ${matched.found} of ${matched.total} found word for word (${percent(matched.share)})`,
      `  labels: full ${d.full}, mostly ${d.mostly}, partly ${d.partly}, none ${d.none}, no passages ${d.noPassages}`,
    )
  }
  lines.push('', TEXT_RULE, NORMALISATION_RULE, DISTRIBUTION_RULE)
  return lines
}
