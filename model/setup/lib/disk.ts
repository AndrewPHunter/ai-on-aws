// Disk: parsing what the disk probe container prints, and the disk verdict (contract section 6).

export type DiskProbe = {
  ownerUid: number
  ownerGid: number
  cacheFreeMiB: number
  dockerFreeMiB: number
  weightsPresent: boolean
  embedWeightsPresent: boolean
  rerankWeightsPresent: boolean
}

export type DiskProbeResult = { ok: true; probe: DiskProbe } | { ok: false; message: string }

// The probe container prints exactly these six lines:
//   owner <uid> <gid>                     from: stat -c '%u %g' /c
//   cache <last line of df -Pm /c>
//   docker <last line of df -Pm />
//   weights present|absent                the chat model's pinned revision in the cache
//   embed-weights present|absent          the embedding model's
//   rerank-weights present|absent         the reranker's
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
  const embedWeights = byTag.get('embed-weights')
  const rerankWeights = byTag.get('rerank-weights')
  if (!owner || !cache || !docker || !weights || !embedWeights || !rerankWeights || byTag.size !== 6) {
    return {
      ok: false,
      message: `expected the lines owner, cache, docker, weights, embed-weights and rerank-weights, got: ${[...byTag.keys()].join(', ')}`,
    }
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
  for (const [tag, fields] of [['weights', weights], ['embed-weights', embedWeights], ['rerank-weights', rerankWeights]] as const) {
    if (fields.length !== 1 || (fields[0] !== 'present' && fields[0] !== 'absent')) {
      return { ok: false, message: `${tag} line is not "present" or "absent": ${fields.join(' ')}` }
    }
  }
  return {
    ok: true,
    probe: {
      ownerUid: Number(uid),
      ownerGid: Number(gid),
      cacheFreeMiB: cacheFree,
      dockerFreeMiB: dockerFree,
      weightsPresent: weights[0] === 'present',
      embedWeightsPresent: embedWeights[0] === 'present',
      rerankWeightsPresent: rerankWeights[0] === 'present',
    },
  }
}

export type DiskInput = {
  weightsPresent: boolean
  cacheFreeMiB: number
  downloadMiB: number
  embedWeightsPresent: boolean
  embedDownloadMiB: number
  rerankWeightsPresent: boolean
  rerankDownloadMiB: number
  imagePresent: boolean
  dockerFreeMiB: number
  imageDiskMiB: number
}

export type Shortfall = { what: 'weights' | 'image'; needMiB: number; freeMiB: number; shortfallMiB: number; message: string }

export type DiskVerdict =
  | { ok: true; weightsNeedMiB: number; imageNeedMiB: number }
  | { ok: false; shortfalls: Shortfall[] }

export function diskVerdict(input: DiskInput): DiskVerdict {
  // Space for each of the three models whose pinned revision is not already in the cache.
  const weightsNeedMiB =
    (input.weightsPresent ? 0 : input.downloadMiB) +
    (input.embedWeightsPresent ? 0 : input.embedDownloadMiB) +
    (input.rerankWeightsPresent ? 0 : input.rerankDownloadMiB)
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

// The Metal disk probe, run on the Mac by model/metal/steps.sh, prints exactly these five lines:
//   cache <last line of df -m -I <cache dir>>  1 MiB blocks, no inode columns: the shape of a df -P line
//   weights present|absent                     the chat model's pinned revision in the cache
//   embed-weights present|absent               the embedding model's
//   rerank-weights present|absent              the reranker's
//   stamp <the stamp file's text, one line>|none  the lock sha256 the environment was installed from, if any
export type MetalDiskProbe = {
  cacheFreeMiB: number
  weightsPresent: boolean
  embedWeightsPresent: boolean
  rerankWeightsPresent: boolean
  stamp: string | null
}

export type MetalDiskProbeResult = { ok: true; probe: MetalDiskProbe } | { ok: false; message: string }

export function parseMetalDiskProbe(output: string): MetalDiskProbeResult {
  const byTag = new Map<string, string[]>()
  for (const line of output.split('\n').filter((text) => text.trim() !== '')) {
    const fields = line.trim().split(/\s+/)
    const tag = fields[0]
    if (tag === undefined) throw new Error('parseMetalDiskProbe: splitting a non-blank line gave no first field')
    if (byTag.has(tag)) return { ok: false, message: `line "${tag}" appears more than once` }
    byTag.set(tag, fields.slice(1))
  }
  const tags = ['cache', 'weights', 'embed-weights', 'rerank-weights', 'stamp']
  if (byTag.size !== tags.length || !tags.every((tag) => byTag.has(tag))) {
    return { ok: false, message: `expected the lines ${tags.join(', ')}, got: ${[...byTag.keys()].join(', ')}` }
  }
  const cache = byTag.get('cache') ?? []
  const free = cache[cache.length - 3]
  if (cache.length < 6 || free === undefined || !/^(0|[1-9][0-9]*)$/.test(free)) {
    return { ok: false, message: `cache line is not a df line: ${cache.join(' ')}` }
  }
  const present: boolean[] = []
  for (const tag of ['weights', 'embed-weights', 'rerank-weights']) {
    const fields = byTag.get(tag) ?? []
    if (fields.length !== 1 || (fields[0] !== 'present' && fields[0] !== 'absent')) {
      return { ok: false, message: `${tag} line is not "present" or "absent": ${fields.join(' ')}` }
    }
    present.push(fields[0] === 'present')
  }
  // Anything but one sha256 (no stamp, an empty or damaged one) is an environment not installed from a lock.
  const stamp = byTag.get('stamp') ?? []
  const installedFrom = stamp.length === 1 && /^[0-9a-f]{64}$/.test(stamp[0] ?? '') ? (stamp[0] ?? null) : null
  return {
    ok: true,
    probe: {
      cacheFreeMiB: Number(free),
      weightsPresent: present[0] === true,
      embedWeightsPresent: present[1] === true,
      rerankWeightsPresent: present[2] === true,
      stamp: installedFrom,
    },
  }
}

export type MetalDiskInput = {
  cacheFreeMiB: number
  environmentPresent: boolean
  environmentDiskMiB: number
  weightsPresent: boolean
  downloadMiB: number
  embedWeightsPresent: boolean
  embedDownloadMiB: number
  rerankWeightsPresent: boolean
  rerankDownloadMiB: number
}

export type MetalDiskVerdict =
  | { ok: true; weightsNeedMiB: number; environmentNeedMiB: number }
  | { ok: false; message: string }

// On a Mac the environment and the weights are both in the cache directory, so their needs are summed against the
// one free figure of its volume.
export function metalDiskVerdict(input: MetalDiskInput): MetalDiskVerdict {
  const weightsNeedMiB =
    (input.weightsPresent ? 0 : input.downloadMiB) +
    (input.embedWeightsPresent ? 0 : input.embedDownloadMiB) +
    (input.rerankWeightsPresent ? 0 : input.rerankDownloadMiB)
  const environmentNeedMiB = input.environmentPresent ? 0 : input.environmentDiskMiB
  const need = weightsNeedMiB + environmentNeedMiB
  if (need > input.cacheFreeMiB) {
    return {
      ok: false,
      message:
        `not enough space in the cache directory for the environment (${environmentNeedMiB} MiB) and the weights ` +
        `(${weightsNeedMiB} MiB): needs ${need} MiB, ${input.cacheFreeMiB} MiB free, short by ${need - input.cacheFreeMiB} MiB`,
    }
  }
  return { ok: true, weightsNeedMiB, environmentNeedMiB }
}
