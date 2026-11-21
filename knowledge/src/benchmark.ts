// The two files of the FDARxBench benchmark, read as the fields this piece uses. Each line is one JSON object.

import { z } from 'zod'

const LabelRecord = z.object({
  set_id: z.string(),
  drug_name: z.string(),
  drug_id: z.string(),
  chunks: z.array(z.string()),
})

export type LabelRecord = z.infer<typeof LabelRecord>

const Passage = z.object({
  text: z.string(),
  // true, false, or absent: only true counts as an answer passage.
  has_answer: z.boolean().optional(),
})

const Question = z.object({
  qid: z.union([z.string(), z.number()]),
  task: z.string(),
  source: z.string(),
  set_id: z.string(),
  context: z.array(Passage),
})

export type Question = z.infer<typeof Question>

function parseLines<T>(bytes: Buffer, schema: z.ZodType<T>, file: string): T[] {
  const out: T[] = []
  const lines = bytes.toString('utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`${file} line ${index + 1} is not JSON`)
    }
    const result = schema.safeParse(value)
    if (!result.success) {
      const where = result.error.issues.map((issue) => issue.path.join('.')).join(', ')
      throw new Error(`${file} line ${index + 1} lacks the expected fields (${where})`)
    }
    out.push(result.data)
  })
  return out
}

export const parseLabelRecords = (bytes: Buffer): LabelRecord[] => parseLines(bytes, LabelRecord, 'labels file')
export const parseQuestions = (bytes: Buffer): Question[] => parseLines(bytes, Question, 'questions file')
