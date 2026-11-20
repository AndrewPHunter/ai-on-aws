// vLLM's start-up capacity line and the verdict on it (contract section 3, step 12). The line, as vLLM
// v0.34.0 prints it after a logger prefix:
//   GPU KV cache size: 82,895 tokens, Maximum concurrency for 20,480 tokens per request: 4.05x

export type Capacity = { tokens: number; context: number; concurrency: number }

export type CapacityParse = { ok: true; capacity: Capacity } | { ok: false; message: string }

const LINE = /GPU KV cache size: ([0-9][0-9,]*) tokens, Maximum concurrency for ([0-9][0-9,]*) tokens per request: ([0-9]+(?:\.[0-9]+)?)x/

function number(text: string): number {
  return Number(text.replaceAll(',', ''))
}

export function parseCapacity(log: string): CapacityParse {
  let last: RegExpExecArray | null = null
  for (const line of log.split('\n')) {
    const match = LINE.exec(line)
    if (match !== null) last = match
  }
  if (last === null) {
    return { ok: false, message: "the server's log has no line \"GPU KV cache size: ... Maximum concurrency for ... tokens per request: ...x\"" }
  }
  return { ok: true, capacity: { tokens: number(last[1]), context: number(last[2]), concurrency: Number(last[3]) } }
}

export type CapacityVerdict = { ok: true } | { ok: false; message: string }

export function capacityVerdict(capacity: Capacity, maxModelLen: number, maxNumSeqs: number): CapacityVerdict {
  if (capacity.context !== maxModelLen) {
    return {
      ok: false,
      message: `vLLM sized its cache for requests of ${capacity.context} tokens, but the profile's CHAT_MAX_MODEL_LEN is ${maxModelLen}`,
    }
  }
  if (capacity.concurrency < maxNumSeqs) {
    return {
      ok: false,
      message:
        `capacity short: vLLM's cache of ${capacity.tokens} tokens holds ${capacity.concurrency} requests of ${capacity.context} tokens at once, ` +
        `but the profile's CHAT_MAX_NUM_SEQS is ${maxNumSeqs}`,
    }
  }
  return { ok: true }
}
