// Reads the one XML member of a label's zip, and nothing else of it.
//
// - A member's name is read only to tell whether it ends in ".xml"; it never names a file on disk.
// - Exactly one such member, or the zip is refused.
// - The XML's size is capped on the bytes the decompressor actually produces. The size the archive declares
//   is used only to refuse early; yauzl's own check against the declared size is turned off, so the count
//   here is what enforces the cap.

import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'

import { Refusal } from './reasons.ts'

const isXmlName = (name: Buffer): boolean => name.toString('latin1').toLowerCase().endsWith('.xml')

function open(zip: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings: false keeps names as raw bytes and skips yauzl's own name checks, which are not
    // needed: no name is ever used as a path.
    yauzl.fromBuffer(zip, { lazyEntries: true, decodeStrings: false, validateEntrySizes: false }, (error, file) => {
      if (error) reject(new Refusal('zip-unreadable'))
      else resolve(file)
    })
  })
}

function entries(file: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const found: Entry[] = []
    file.on('entry', (entry: Entry) => {
      found.push(entry)
      file.readEntry()
    })
    file.on('end', () => resolve(found))
    file.on('error', () => reject(new Refusal('zip-unreadable')))
    file.readEntry()
  })
}

function readCapped(file: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    file.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(new Refusal('zip-unreadable'))
        return
      }
      const parts: Buffer[] = []
      let total = 0
      let settled = false
      stream.on('data', (chunk: Buffer) => {
        if (settled) return
        total += chunk.length
        if (total > maxBytes) {
          settled = true
          stream.destroy()
          reject(new Refusal('xml-too-large'))
          return
        }
        parts.push(chunk)
      })
      stream.on('error', () => {
        if (settled) return
        settled = true
        reject(new Refusal('zip-unreadable'))
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(parts))
      })
    })
  })
}

// The bytes of the zip's one XML member. Throws a Refusal for anything else.
export async function extractXml(zip: Buffer, maxXmlBytes: number): Promise<Buffer> {
  const file = await open(zip)
  try {
    const all = await entries(file)
    const xml = all.filter((entry) => {
      const name: unknown = entry.fileName
      return Buffer.isBuffer(name) && isXmlName(name)
    })
    if (xml.length === 0) throw new Refusal('zip-no-xml-member')
    if (xml.length > 1) throw new Refusal('zip-several-xml-members')
    const [member] = xml
    if (member === undefined) throw new Refusal('zip-no-xml-member')
    if (member.uncompressedSize > maxXmlBytes) throw new Refusal('xml-too-large')
    return await readCapped(file, member, maxXmlBytes)
  } finally {
    file.close()
  }
}
