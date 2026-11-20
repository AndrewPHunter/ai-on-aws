// Disk: parsing what the disk probe container prints, and the disk verdict (contract section 6).

export type DiskProbe = {
  ownerUid: number
  ownerGid: number
  cacheFreeMiB: number
  dockerFreeMiB: number
  weightsPresent: boolean
}

export type DiskProbeResult = { ok: true; probe: DiskProbe } | { ok: false; message: string }

// The probe container prints exactly these four lines:
//   owner <uid> <gid>                     from: stat -c '%u %g' /c
//   cache <last line of df -Pm /c>
//   docker <last line of df -Pm />
//   weights present|absent
// In a df -P line the available space is the third field from the end (Available, Capacity, Mounted on).
export function parseDiskProbe(output: string): DiskProbeResult {
  const lines = output.split('\n').filter((line) => line.trim() !== '')
  const byTag = new Map<string, string[]>()
  for (const line of lines) {
    const fields = line.trim().split(/\s+/)
    const tag = fields[0]
    if (tag === undefined) throw new Error('parseDiskProbe: splitting a non-blank line gave no first field')
    if (byTag.has(tag)) return { ok: false, message: `line "${tag}" appears more than once` }
    byTag.set(tag, fields.slice(1))
  }
  const owner = byTag.get('owner')
  const cache = byTag.get('cache')
  const docker = byTag.get('docker')
  const weights = byTag.get('weights')
  if (!owner || !cache || !docker || !weights || byTag.size !== 4) {
    return { ok: false, message: `expected the lines owner, cache, docker and weights, got: ${[...byTag.keys()].join(', ')}` }
  }
  const integer = /^(0|[1-9][0-9]*)$/
  const [uid, gid] = owner
  if (owner.length !== 2 || uid === undefined || gid === undefined || !integer.test(uid) || !integer.test(gid)) {
    return { ok: false, message: `owner line is not "<uid> <gid>": ${owner.join(' ')}` }
  }
  const available = (fields: string[], what: string): number | string => {
    const value = fields[fields.length - 3]
    if (fields.length < 6 || value === undefined || !integer.test(value)) return `${what} line is not a df -P line: ${fields.join(' ')}`
    return Number(value)
  }
  const cacheFree = available(cache, 'cache')
  if (typeof cacheFree === 'string') return { ok: false, message: cacheFree }
  const dockerFree = available(docker, 'docker')
  if (typeof dockerFree === 'string') return { ok: false, message: dockerFree }
  if (weights.length !== 1 || (weights[0] !== 'present' && weights[0] !== 'absent')) {
    return { ok: false, message: `weights line is not "present" or "absent": ${weights.join(' ')}` }
  }
  return {
    ok: true,
    probe: {
      ownerUid: Number(uid),
      ownerGid: Number(gid),
      cacheFreeMiB: cacheFree,
      dockerFreeMiB: dockerFree,
      weightsPresent: weights[0] === 'present',
    },
  }
}

export type DiskInput = {
  weightsPresent: boolean
  cacheFreeMiB: number
  downloadMiB: number
  imagePresent: boolean
  dockerFreeMiB: number
  imageDiskMiB: number
}

export type Shortfall = { what: 'weights' | 'image'; needMiB: number; freeMiB: number; shortfallMiB: number; message: string }

export type DiskVerdict =
  | { ok: true; weightsNeedMiB: number; imageNeedMiB: number }
  | { ok: false; shortfalls: Shortfall[] }

export function diskVerdict(input: DiskInput): DiskVerdict {
  const weightsNeedMiB = input.weightsPresent ? 0 : input.downloadMiB
  const imageNeedMiB = input.imagePresent ? 0 : input.imageDiskMiB
  const shortfalls: Shortfall[] = []
  if (weightsNeedMiB > input.cacheFreeMiB) {
    const short = weightsNeedMiB - input.cacheFreeMiB
    shortfalls.push({
      what: 'weights',
      needMiB: weightsNeedMiB,
      freeMiB: input.cacheFreeMiB,
      shortfallMiB: short,
      message: `not enough space in the cache directory for the weights: needs ${weightsNeedMiB} MiB, ${input.cacheFreeMiB} MiB free, short by ${short} MiB`,
    })
  }
  if (imageNeedMiB > input.dockerFreeMiB) {
    const short = imageNeedMiB - input.dockerFreeMiB
    shortfalls.push({
      what: 'image',
      needMiB: imageNeedMiB,
      freeMiB: input.dockerFreeMiB,
      shortfallMiB: short,
      message: `not enough space in Docker's storage for the server image: needs ${imageNeedMiB} MiB, ${input.dockerFreeMiB} MiB free, short by ${short} MiB`,
    })
  }
  return shortfalls.length === 0 ? { ok: true, weightsNeedMiB, imageNeedMiB } : { ok: false, shortfalls }
}
