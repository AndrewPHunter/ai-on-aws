// STAND-IN for DailyMed and for the benchmark's raw file host, for tests only. A loopback HTTP server that
// serves synthetic data the test registers, and records every request it receives. It is not DailyMed and
// says so: every response carries the header `x-stand-in: test`.
//
//   DailyMed paths are served under /dailymed, raw files under /raw. Anything not registered answers 404.

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { TestContext } from 'node:test'

export type Reply =
  | { status: number; body?: Buffer | string; contentType?: string }
  // Closes the connection without a response.
  | 'drop'

export type Received = { path: string; userAgent: string | undefined }

export class StandIn {
  readonly received: Received[] = []
  readonly #routes = new Map<string, Reply[]>()
  readonly #server: Server
  #base = ''
  // When set, requests are held until `parkUntil` of them are waiting, then all held ones are answered.
  #parking: { batch: number; total: number; held: (() => void)[]; arrived: number } | undefined

  constructor() {
    this.#server = createServer((request, response) => this.#handle(request, response))
  }

  static async start(t: TestContext): Promise<StandIn> {
    const standIn = new StandIn()
    await new Promise<void>((resolve) => {
      standIn.#server.listen(0, '127.0.0.1', resolve)
    })
    const address = standIn.#server.address()
    if (address === null || typeof address === 'string') throw new Error('the stand-in has no port')
    standIn.#base = `http://127.0.0.1:${address.port}`
    t.after(() => {
      standIn.#server.closeAllConnections()
      standIn.#server.close()
    })
    return standIn
  }

  get dailymedBase(): string {
    return `${this.#base}/dailymed`
  }

  get rawBase(): string {
    return `${this.#base}/raw`
  }

  // Registers the replies for a path (with its query). Each request takes the next reply; the last one repeats.
  on(path: string, ...replies: Reply[]): void {
    this.#routes.set(path, replies)
  }

  // Holds requests and answers them in batches of `batch`, the last batch being whatever remains of `total`.
  park(batch: number, total: number): void {
    this.#parking = { batch, total, held: [], arrived: 0 }
  }

  requestsTo(prefix: string): number {
    return this.received.filter((request) => request.path.startsWith(prefix)).length
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? ''
    const userAgent = request.headers['user-agent']
    this.received.push({ path, userAgent })
    const answer = (): void => this.#answer(path, request, response)
    const parking = this.#parking
    if (parking === undefined) {
      answer()
      return
    }
    parking.arrived++
    parking.held.push(answer)
    const remaining = parking.total - (parking.arrived - parking.held.length)
    if (parking.held.length >= Math.min(parking.batch, remaining)) {
      const batch = parking.held.splice(0)
      for (const release of batch) release()
    }
  }

  #answer(path: string, request: IncomingMessage, response: ServerResponse): void {
    const replies = this.#routes.get(path)
    const reply = replies === undefined ? { status: 404, body: 'not registered with the stand-in' } : replies.length > 1 ? replies.shift() : replies[0]
    if (reply === undefined || reply === 'drop') {
      request.socket.destroy()
      return
    }
    const body = reply.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body)
    response.writeHead(reply.status, {
      'content-type': reply.contentType ?? 'application/octet-stream',
      'content-length': body.length,
      'x-stand-in': 'test',
    })
    response.end(body)
  }
}

// DailyMed's history page, in the shape it answers with (an unknown set id gets an empty list and status 200).
export function historyPage(entries: { version: number; published: string }[], page = 1, totalPages = 1): string {
  return JSON.stringify({
    data: { spl: { title: '', setid: '' }, history: entries.map((e) => ({ spl_version: e.version, published_date: e.published })) },
    metadata: { total_pages: totalPages, current_page: page, elements_per_page: 100 },
  })
}

export const historyPath = (setId: string, page = 1): string => `/dailymed/services/v2/spls/${setId}/history.json?page=${page}`
export const zipPath = (setId: string, version: number): string =>
  `/dailymed/getFile.cfm?type=zip&setid=${setId}&version=${version}`
export const rawPath = (revision: string, path: string): string => `/raw/example-owner/example-bench/${revision}/${path}`
