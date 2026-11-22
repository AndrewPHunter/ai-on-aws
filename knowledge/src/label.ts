// Downloads one version of one label and reads it safely: the zip, its one XML member, the parsed XML,
// and the identity inside it, which must be the set id and version asked for.

import { zipUrl } from './dailymed.ts'
import type { PoliteClient } from './http.ts'
import { Refusal } from './reasons.ts'
import { parseLabel, readIdentity } from './spl.ts'
import type { LabelIdentity } from './spl.ts'
import { extractXml } from './zip.ts'

export type Caps = {
  // Bytes of a zip as downloaded.
  zipBytes: number
  // Bytes of the XML as decompressed.
  xmlBytes: number
}

export type DownloadedLabel = { zip: Buffer; xml: Buffer; identity: LabelIdentity }

export async function downloadLabel(
  client: PoliteClient,
  base: string,
  setId: string,
  version: number,
  caps: Caps,
): Promise<DownloadedLabel> {
  const result = await client.get(zipUrl(base, setId, version), caps.zipBytes, new Refusal('zip-too-large'))
  if (result.status === 'not-found') throw new Refusal('version-not-served')
  const xml = await extractXml(result.body, caps.xmlBytes)
  const identity = readIdentity(parseLabel(xml))
  if (identity.setId.toLowerCase() !== setId || identity.version !== version) throw new Refusal('xml-identity-mismatch')
  return { zip: result.body, xml, identity }
}
