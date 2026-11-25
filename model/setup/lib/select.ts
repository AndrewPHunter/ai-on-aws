// Tier selection (contract section 5). Pure: probed GPUs, a valid tiers file and an optional tier name in;
// the selected tier or the first refusal out. Never returns a tier that does not fit, and never substitutes
// another tier for the one named.

import type { Gpu } from './probe.ts'
import { metalNeedMiB, needMiB, type MetalTier, type MetalTiers, type Tier, type Tiers } from './tiers.ts'

export type Selection =
  | { ok: true; gpu: Gpu; tier: Tier; needMiB: number; freeMiB: number }
  | { ok: false; reason: 'no_gpu'; message: string }
  | { ok: false; reason: 'multiple_gpus'; message: string; count: number }
  | { ok: false; reason: 'driver_too_old'; message: string; driverMajor: number; minDriverMajor: number }
  | { ok: false; reason: 'gpu_too_old'; message: string; computeCapability: string; minComputeCapability: string }
  | {
      ok: false
      reason: 'insufficient_memory'
      message: string
      tier: string
      needMiB: number
      freeMiB: number
      shortfallMiB: number
    }

function capability(text: string): [number, number] {
  const [major, minor] = text.split('.')
  return [Number(major), Number(minor)]
}

function capabilityBelow(actual: string, minimum: string): boolean {
  const [aMajor, aMinor] = capability(actual)
  const [mMajor, mMinor] = capability(minimum)
  return aMajor < mMajor || (aMajor === mMajor && aMinor < mMinor)
}

export function selectTier(gpus: readonly Gpu[], tiers: Tiers, tierName: string | null): Selection {
  if (gpus.length === 0) {
    return { ok: false, reason: 'no_gpu', message: 'no NVIDIA GPU is available to containers on that machine' }
  }
  if (gpus.length > 1) {
    return {
      ok: false,
      reason: 'multiple_gpus',
      count: gpus.length,
      message: `${gpus.length} GPUs found; a machine with more than one GPU is not supported yet`,
    }
  }
  const gpu = gpus[0]
  if (gpu === undefined) throw new Error('selectTier: a list of one GPU has no element 0')

  const driverMajor = Number(gpu.driverVersion.split('.')[0])
  const { minDriverMajor, minComputeCapability } = tiers.requirements
  if (driverMajor < minDriverMajor) {
    return {
      ok: false,
      reason: 'driver_too_old',
      driverMajor,
      minDriverMajor,
      message: `NVIDIA driver ${gpu.driverVersion} is too old: major version ${driverMajor}, at least ${minDriverMajor} is needed`,
    }
  }
  if (capabilityBelow(gpu.computeCapability, minComputeCapability)) {
    return {
      ok: false,
      reason: 'gpu_too_old',
      computeCapability: gpu.computeCapability,
      minComputeCapability,
      message: `${gpu.name} has compute capability ${gpu.computeCapability}; at least ${minComputeCapability} is needed`,
    }
  }

  const freeMiB = gpu.memoryTotalMiB - gpu.memoryUsedMiB
  const refuse = (tier: Tier): Selection => {
    const need = needMiB(tiers, tier)
    return {
      ok: false,
      reason: 'insufficient_memory',
      tier: tier.name,
      needMiB: need,
      freeMiB,
      shortfallMiB: need - freeMiB,
      message:
        `not enough free GPU memory for tier ${tier.name}: needs ${need} MiB, ${freeMiB} MiB free ` +
        `(${gpu.memoryTotalMiB} MiB total, ${gpu.memoryUsedMiB} MiB in use), short by ${need - freeMiB} MiB`,
    }
  }

  if (tierName !== null) {
    const named = tiers.tiers.find((tier) => tier.name === tierName)
    if (named === undefined) {
      // parseArgs refuses unknown names first; this keeps the function total.
      throw new Error(`tier ${tierName} is not in the tiers file`)
    }
    const need = needMiB(tiers, named)
    return need <= freeMiB ? { ok: true, gpu, tier: named, needMiB: need, freeMiB } : refuse(named)
  }

  let best: Tier | null = null
  for (const tier of tiers.tiers) {
    const need = needMiB(tiers, tier)
    if (need <= freeMiB && (best === null || need > needMiB(tiers, best))) best = tier
  }
  if (best !== null) return { ok: true, gpu, tier: best, needMiB: needMiB(tiers, best), freeMiB }

  let smallest = tiers.tiers[0]
  // A valid tiers file has at least one tier (validateTiers refuses an empty list).
  if (smallest === undefined) throw new Error('selectTier: the tiers file has no tiers')
  for (const tier of tiers.tiers) if (needMiB(tiers, tier) < needMiB(tiers, smallest)) smallest = tier
  return refuse(smallest)
}

// The Metal machine check and selection (invariant 9). Pure: the Mac's macOS version, as `sw_vers -productVersion`
// prints it, and its total memory in bytes, as `sysctl -n hw.memsize` prints it, in. Apple silicon is established
// before this, by the toolchain. The check is necessary, not sufficient: it compares the need with the total memory,
// and other programs may hold some of it when a server starts.
export type MetalSelection =
  | { ok: true; tier: MetalTier; needMiB: number; memoryMiB: number }
  | { ok: false; reason: 'probe_unreadable' | 'macos_too_old' | 'insufficient_memory'; message: string }

export function selectMetalTier(macosVersion: string, memoryBytes: string, tiers: MetalTiers, tierName: string | null): MetalSelection {
  const version = macosVersion.trim()
  if (!/^[0-9]+(\.[0-9]+)*$/.test(version)) {
    return { ok: false, reason: 'probe_unreadable', message: `the macOS version is not <major>[.<minor>...]: ${JSON.stringify(version)}` }
  }
  const bytes = memoryBytes.trim()
  if (!/^[1-9][0-9]*$/.test(bytes)) {
    return { ok: false, reason: 'probe_unreadable', message: `the total memory is not a number of bytes: ${JSON.stringify(bytes)}` }
  }
  const major = Number(version.split('.')[0])
  const { minMacosMajor } = tiers.requirements
  if (major < minMacosMajor) {
    return { ok: false, reason: 'macos_too_old', message: `macOS ${version} is too old: major version ${major}, at least ${minMacosMajor} is needed` }
  }
  const memoryMiB = Math.floor(Number(bytes) / 1048576)
  const fits = (tier: MetalTier): boolean => metalNeedMiB(tiers, tier) <= memoryMiB
  const refuse = (tier: MetalTier): MetalSelection => {
    const need = metalNeedMiB(tiers, tier)
    return {
      ok: false,
      reason: 'insufficient_memory',
      message: `not enough memory for tier ${tier.name}: needs ${need} MiB in total, this Mac has ${memoryMiB} MiB, short by ${need - memoryMiB} MiB`,
    }
  }
  if (tierName !== null) {
    const named = tiers.tiers.find((tier) => tier.name === tierName)
    // parseArgs refuses unknown names first; this keeps the function total.
    if (named === undefined) throw new Error(`tier ${tierName} is not in the Metal tiers file`)
    return fits(named) ? { ok: true, tier: named, needMiB: metalNeedMiB(tiers, named), memoryMiB } : refuse(named)
  }
  let best: MetalTier | null = null
  for (const tier of tiers.tiers) {
    if (fits(tier) && (best === null || metalNeedMiB(tiers, tier) > metalNeedMiB(tiers, best))) best = tier
  }
  if (best !== null) return { ok: true, tier: best, needMiB: metalNeedMiB(tiers, best), memoryMiB }
  let smallest = tiers.tiers[0]
  if (smallest === undefined) throw new Error('selectMetalTier: the Metal tiers file has no tiers')
  for (const tier of tiers.tiers) if (metalNeedMiB(tiers, tier) < metalNeedMiB(tiers, smallest)) smallest = tier
  return refuse(smallest)
}
