// Builds zip archives for tests, byte by byte, so an archive can lie: declare a size it does not have, carry a
// member named with "../" or an absolute path, or be cut short. Not a general zip writer.

import { crc32, deflateRawSync } from 'node:zlib'

export type ZipMember = {
  name: string
  data: Buffer | string
  // The uncompressed size written in both headers. Defaults to the true size.
  declaredSize?: number
  // Stored instead of deflated (method 0), so the archive is as large as its data.
  stored?: boolean
}

export function buildZip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8')
    const raw = Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data, 'utf8')
    const method = member.stored ? 0 : 8
    const body = member.stored ? raw : deflateRawSync(raw)
    const crc = crc32(raw)
    const declared = member.declaredSize ?? raw.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(declared, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(declared, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
