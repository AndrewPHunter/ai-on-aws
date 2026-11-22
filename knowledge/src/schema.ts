// The two tracked files, knowledge/corpus/benchmark.json and knowledge/corpus/manifest.json, as schemas.
// Both are written in a fixed key order and sorted, so the same inputs give byte-identical files.

import { z } from 'zod'

import { REASONS } from './reasons.ts'

// A set id as DailyMed and the benchmark write it: a lowercase GUID. Output file names are built from it.
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A document id: a GUID in either case, as written inside the XML.
const DOCUMENT_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

export const isGuid = (value: string): boolean => GUID.test(value)

const sha256 = z.string().regex(SHA256, 'must be 64 lowercase hex characters')

const benchmarkFile = z.strictObject({
  path: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/, 'must be a relative path inside the repository'),
  sha256,
  bytes: z.number().int().nonnegative(),
})

export const BenchmarkPinSchema = z.strictObject({
  repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be https://github.com/<owner>/<name>'),
  revision: z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit id'),
  licence: z.string().min(1),
  files: z.strictObject({ labels: benchmarkFile, qa: benchmarkFile }),
})

export type BenchmarkPin = z.infer<typeof BenchmarkPinSchema>

const pinnedLabel = z.strictObject({
  setId: z.string().regex(GUID, 'must be a lowercase GUID'),
  version: z.number().int().positive(),
  documentId: z.string().regex(DOCUMENT_ID, 'must be a GUID'),
  effectiveTime: z.string().regex(/^\d{8}[0-9.+-]*$/, 'must start with yyyymmdd'),
  publishedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd'),
  documentTypeCode: z.string().regex(/^\d{1,7}-\d$/, 'must be a LOINC code'),
  zipSha256: sha256,
  xmlSha256: sha256,
  xmlBytes: z.number().int().positive(),
})

export type PinnedLabel = z.infer<typeof pinnedLabel>

const notPinned = z.strictObject({
  // As the benchmark wrote it: may be empty or not a GUID, which is then the reason.
  setId: z.string(),
  drugId: z.string(),
  reason: z.enum(REASONS),
})

export type NotPinned = z.infer<typeof notPinned>

export const ManifestSchema = z
  .strictObject({
    labels: z.array(pinnedLabel),
    notPinned: z.array(notPinned),
  })
  .superRefine((manifest, context) => {
    const seen = new Map<string, number>()
    manifest.labels.forEach((label, index) => {
      const first = seen.get(label.setId)
      if (first === undefined) {
        seen.set(label.setId, index)
      } else {
        context.addIssue({
          code: 'custom',
          path: ['labels', index, 'setId'],
          message: `duplicates the set id of labels[${first}]`,
        })
      }
    })
  })

export type Manifest = z.infer<typeof ManifestSchema>

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: string[] }

// Each problem names where it is, as a path such as labels[2].xmlSha256.
function validate<T>(schema: z.ZodType<T>, input: unknown): Validation<T> {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  return {
    ok: false,
    problems: result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const part of path) {
    out += typeof part === 'number' ? `[${part}]` : `${out === '' ? '' : '.'}${String(part)}`
  }
  return out === '' ? '(root)' : out
}

export const validateManifest = (input: unknown): Validation<Manifest> => validate(ManifestSchema, input)
export const validateBenchmarkPin = (input: unknown): Validation<BenchmarkPin> => validate(BenchmarkPinSchema, input)

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// The manifest's one written form: labels by set id; labels not pinned by set id, then drug id.
export function serialiseManifest(manifest: Manifest): string {
  const labels = [...manifest.labels]
    .sort((a, b) => byString(a.setId, b.setId))
    .map((label) => ({
      setId: label.setId,
      version: label.version,
      documentId: label.documentId,
      effectiveTime: label.effectiveTime,
      publishedDate: label.publishedDate,
      documentTypeCode: label.documentTypeCode,
      zipSha256: label.zipSha256,
      xmlSha256: label.xmlSha256,
      xmlBytes: label.xmlBytes,
    }))
  const notPinnedSorted = [...manifest.notPinned]
    .sort((a, b) => byString(a.setId, b.setId) || byString(a.drugId, b.drugId))
    .map((entry) => ({ setId: entry.setId, drugId: entry.drugId, reason: entry.reason }))
  return `${JSON.stringify({ labels, notPinned: notPinnedSorted }, null, 2)}\n`
}

export function serialiseBenchmarkPin(pin: BenchmarkPin): string {
  const file = (f: BenchmarkPin['files']['labels']) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })
  return `${JSON.stringify(
    {
      repository: pin.repository,
      revision: pin.revision,
      licence: pin.licence,
      files: { labels: file(pin.files.labels), qa: file(pin.files.qa) },
    },
    null,
    2,
  )}\n`
}
