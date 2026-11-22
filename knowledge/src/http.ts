// A polite HTTP client: a cap on requests in flight, a fixed User-Agent, retries with growing waits for
// the failures worth retrying, and a cap on the bytes read from a body. Time is passed in: the waits go
// through `sleep`, and `timeoutMs` bounds one attempt. The transport is passed in too: the commands give it
// the platform's `fetch`.

export type HttpSettings = {
  fetch: typeof fetch
  userAgent: string
  // Requests in flight at once, across every caller of this client.
  maxConcurrent: number
  // Attempts in all, including the first.
  attempts: number
  // The wait before each retry: waitsMs[0] before the second attempt, and so on. Must hold attempts - 1 values.
  waitsMs: readonly number[]
  // How long one attempt may take, from sending to the last byte of the body.
  timeoutMs: number
  sleep: (ms: number) => Promise<void>
}

export type GetResult = { status: 'ok'; body: Buffer } | { status: 'not-found' }

// The request failed after every attempt, or got a status that is not retried.
export class TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportError'
  }
}

class TooLarge extends Error {}

const RETRIED = (status: number): boolean => status === 408 || status === 429 || (status >= 500 && status <= 599)

export class PoliteClient {
  readonly #settings: HttpSettings
  #inFlight = 0
  readonly #waiting: (() => void)[] = []
  #requests = 0

  constructor(settings: HttpSettings) {
    if (!Number.isInteger(settings.maxConcurrent) || settings.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer')
    }
    if (!Number.isInteger(settings.attempts) || settings.attempts < 1) {
      throw new Error('attempts must be a positive integer')
    }
    if (settings.waitsMs.length !== settings.attempts - 1) {
      throw new Error(`waitsMs must hold ${settings.attempts - 1} values, one before each retry`)
    }
    this.#settings = settings
  }

  // Requests sent so far, every attempt counted.
  get requests(): number {
    return this.#requests
  }

  // GET a URL. A 404 is returned, not retried. A body over maxBytes throws `tooLarge`.
  async get(url: string, maxBytes: number, tooLarge: Error): Promise<GetResult> {
    const { attempts, waitsMs, sleep } = this.#settings
    let last = ''
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(waitsMs[attempt - 2] ?? 0)
      const outcome = await this.#attempt(url, maxBytes)
      if (outcome.kind === 'done') return outcome.result
      if (outcome.kind === 'too-large') throw tooLarge
      if (outcome.kind === 'final') throw new TransportError(`${url}: ${outcome.detail}`)
      last = outcome.detail
    }
    throw new TransportError(`${url}: gave up after ${attempts} attempts; last: ${last}`)
  }

  async #attempt(
    url: string,
    maxBytes: number,
  ): Promise<
    | { kind: 'done'; result: GetResult }
    | { kind: 'retry'; detail: string }
    | { kind: 'final'; detail: string }
    | { kind: 'too-large' }
  > {
    await this.#acquire()
    this.#requests++
    try {
      const signal = AbortSignal.timeout(this.#settings.timeoutMs)
      let response: Response
      try {
        response = await this.#settings.fetch(url, { headers: { 'user-agent': this.#settings.userAgent }, redirect: 'follow', signal })
      } catch (error) {
        return { kind: 'retry', detail: `no response (${describe(error)})` }
      }
      if (response.status === 404) {
        await response.body?.cancel()
        return { kind: 'done', result: { status: 'not-found' } }
      }
      if (response.status !== 200) {
        await response.body?.cancel()
        const detail = `status ${response.status}`
        return RETRIED(response.status) ? { kind: 'retry', detail } : { kind: 'final', detail }
      }
      try {
        return { kind: 'done', result: { status: 'ok', body: await readCapped(response, maxBytes) } }
      } catch (error) {
        if (error instanceof TooLarge) return { kind: 'too-large' }
        return { kind: 'retry', detail: `body not received (${describe(error)})` }
      }
    } finally {
      this.#release()
    }
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < this.#settings.maxConcurrent) {
      this.#inFlight++
      return
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve))
  }

  // Hands the slot straight to the next waiter, so the count never passes the cap.
  #release(): void {
    const next = this.#waiting.shift()
    if (next) next()
    else this.#inFlight--
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new TooLarge()
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new TooLarge()
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
    return `${error.name}${cause}`
  }
  return 'unknown error'
}
