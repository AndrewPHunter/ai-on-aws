// The tiers file, model/tiers.json (contract section 7): validation and the memory each tier needs.

export type Tier = { name: string; profile: string; measuredPeakMiB: number; downloadMiB: number }

export type Tiers = {
  requirements: { minDriverMajor: number; minComputeCapability: string }
  marginMiB: number
  reservedForOtherModelsMiB: number
  imageDiskMiB: number
  tiers: Tier[]
}

export type TiersResult = { ok: true; tiers: Tiers } | { ok: false; errors: string[] }

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function validateTiers(raw: unknown): TiersResult {
  const errors: string[] = []
  const top = record(raw)
  if (top === null) return { ok: false, errors: ['the tiers file must be a JSON object'] }

  const requirements = record(top.requirements)
  if (requirements === null) {
    errors.push('requirements must be an object')
  } else {
    if (!isPositiveInteger(requirements.minDriverMajor)) {
      errors.push('requirements.minDriverMajor must be a positive integer')
    }
    if (typeof requirements.minComputeCapability !== 'string' || !/^[0-9]+\.[0-9]+$/.test(requirements.minComputeCapability)) {
      errors.push('requirements.minComputeCapability must be a string of the form <major>.<minor>')
    }
  }
  for (const key of ['marginMiB', 'reservedForOtherModelsMiB', 'imageDiskMiB'] as const) {
    if (!isNonNegativeInteger(top[key])) errors.push(`${key} must be a non-negative integer`)
  }

  if (!Array.isArray(top.tiers) || top.tiers.length === 0) {
    errors.push('tiers must be a non-empty array')
  } else {
    const seen = new Set<string>()
    top.tiers.forEach((entry: unknown, position: number) => {
      const tier = record(entry)
      const label = `tiers[${position}]`
      if (tier === null) {
        errors.push(`${label} must be an object`)
        return
      }
      if (typeof tier.name !== 'string' || !SAFE_NAME.test(tier.name)) {
        errors.push(`${label}.name must be non-empty and made only of letters, digits, ".", "-" and "_"`)
      }
      if (typeof tier.profile !== 'string' || !SAFE_NAME.test(tier.profile)) {
        errors.push(`${label}.profile must be non-empty and made only of letters, digits, ".", "-" and "_"`)
      }
      if (!isPositiveInteger(tier.measuredPeakMiB)) errors.push(`${label}.measuredPeakMiB must be a positive integer`)
      if (!isPositiveInteger(tier.downloadMiB)) errors.push(`${label}.downloadMiB must be a positive integer`)
      if (typeof tier.name === 'string') {
        if (seen.has(tier.name)) errors.push(`tier names must be unique: ${tier.name} appears more than once`)
        seen.add(tier.name)
      }
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, tiers: raw as Tiers }
}

export function needMiB(tiers: Tiers, tier: Tier): number {
  return tier.measuredPeakMiB + tiers.marginMiB + tiers.reservedForOtherModelsMiB
}
