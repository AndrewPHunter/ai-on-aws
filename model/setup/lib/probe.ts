// Parses the output of
//   nvidia-smi --query-gpu=index,name,memory.total,memory.used,driver_version,compute_cap --format=csv,noheader,nounits
// One line per GPU, fields separated by a comma and a space, memory in MiB.

export type Gpu = {
  index: number
  name: string
  memoryTotalMiB: number
  memoryUsedMiB: number
  driverVersion: string
  computeCapability: string
}

export type ProbeResult = { ok: true; gpus: Gpu[] } | { ok: false; message: string }

const INTEGER = /^(0|[1-9][0-9]*)$/

export function parseProbe(output: string): ProbeResult {
  const gpus: Gpu[] = []
  const lines = output.split('\n').map((line) => line.replace(/\r$/, ''))
  for (const line of lines) {
    if (line.trim() === '') continue
    const fields = line.split(', ')
    if (fields.length !== 6) {
      return { ok: false, message: `expected 6 fields, got ${fields.length}: ${line}` }
    }
    const [index, name, total, used, driver, compute] = fields.map((field) => field.trim())
    if (!INTEGER.test(index)) return { ok: false, message: `GPU index is not an integer: ${line}` }
    if (name === '') return { ok: false, message: `GPU name is empty: ${line}` }
    if (!INTEGER.test(total)) return { ok: false, message: `total memory is not an integer number of MiB: ${line}` }
    if (!INTEGER.test(used)) return { ok: false, message: `used memory is not an integer number of MiB: ${line}` }
    if (!/^[0-9]+(\.[0-9]+)*$/.test(driver)) return { ok: false, message: `driver version is not numeric: ${line}` }
    if (!/^[0-9]+\.[0-9]+$/.test(compute)) return { ok: false, message: `compute capability is not <major>.<minor>: ${line}` }
    gpus.push({
      index: Number(index),
      name,
      memoryTotalMiB: Number(total),
      memoryUsedMiB: Number(used),
      driverVersion: driver,
      computeCapability: compute,
    })
  }
  return { ok: true, gpus }
}
