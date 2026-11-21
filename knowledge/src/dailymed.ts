// DailyMed's two endpoints this piece uses: the version history of a set id, and the zip of one version.

import { z } from 'zod'

import type { PoliteClient } from './http.ts'

// Larger than any history page could be; a history is a short list of versions and dates.
const HISTORY_MAX_BYTES = 1024 * 1024

const HistoryPage = z.object({
  data: z.object({
    history: z.array(z.object({ spl_version: z.number().int().positive(), published_date: z.string() })),
  }),
  metadata: z.object({ total_pages: z.number().int().nonnegative(), current_page: z.number().int().positive() }),
})

export type HistoryEntry = { version: number; publishedDate: string }

export const historyUrl = (base: string, setId: string, page: number): string =>
  `${base}/services/v2/spls/${setId}/history.json?page=${page}`

export const zipUrl = (base: string, setId: string, version: number): string =>
  `${base}/getFile.cfm?type=zip&setid=${setId}&version=${version}`

const MONTHS: Readonly<Record<string, string>> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

// "Sep 27, 2021" as DailyMed writes it, to 2021-09-27. Read with a fixed month table, not the locale.
export function parsePublishedDate(text: string): string {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text.trim())
  const month = match?.[1] === undefined ? undefined : MONTHS[match[1]]
  if (!match || month === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`unexpected published date in a DailyMed history: ${JSON.stringify(text)}`)
  }
  return `${match[3]}-${month}-${match[2].padStart(2, '0')}`
}

// Every version DailyMed lists for the set id, across all pages. An empty list means no history.
export async function fetchHistory(client: PoliteClient, base: string, setId: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = []
  for (let page = 1; ; page++) {
    const result = await client.get(historyUrl(base, setId, page), HISTORY_MAX_BYTES, new Error(`DailyMed's history for ${setId} is larger than ${HISTORY_MAX_BYTES} bytes`))
    if (result.status === 'not-found') return entries
    let parsed: z.infer<typeof HistoryPage>
    try {
      parsed = HistoryPage.parse(JSON.parse(result.body.toString('utf8')))
    } catch {
      throw new Error(`DailyMed's history for ${setId}, page ${page}, is not in the expected shape`)
    }
    for (const item of parsed.data.history) {
      entries.push({ version: item.spl_version, publishedDate: parsePublishedDate(item.published_date) })
    }
    if (page >= parsed.metadata.total_pages) return entries
  }
}
