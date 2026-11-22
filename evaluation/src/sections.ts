// The section of each passage, from the chunks the index was built from (knowledge/data, read-only): the passage id a
// citation or a retrieval hit names, mapped to the section number and title the gate's matching rule compares. Only
// the labels of the sampled questions are read.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InputError } from './benchmark.ts';
import type { Section } from './score.ts';

type ReportLabel = { setId: string; version: number; status: string };

export async function readSections(knowledgeDataDir: string, setIds: ReadonlySet<string>): Promise<Map<string, Section>> {
  let report: { labels: ReportLabel[] };
  try {
    report = JSON.parse(await readFile(join(knowledgeDataDir, 'chunk-report.json'), 'utf8')) as { labels: ReportLabel[] };
  } catch {
    throw new InputError('knowledge/data/chunk-report.json could not be read: run knowledge/chunk.sh');
  }
  const sections = new Map<string, Section>();
  for (const label of report.labels) {
    if (label.status !== 'chunked' || !setIds.has(label.setId)) continue;
    const shown = `chunks/${label.setId}/${label.version}.jsonl`;
    let text: string;
    try {
      text = await readFile(join(knowledgeDataDir, 'chunks', label.setId, `${label.version}.jsonl`), 'utf8');
    } catch {
      throw new InputError(`knowledge/data/${shown} could not be read`);
    }
    for (const [at, line] of text.split('\n').entries()) {
      if (line === '') continue;
      let chunk: { id?: unknown; section?: { number?: unknown; title?: unknown } };
      try {
        chunk = JSON.parse(line) as typeof chunk;
      } catch {
        throw new InputError(`knowledge/data/${shown} line ${at + 1} is not JSON`);
      }
      if (typeof chunk.id !== 'string') continue;
      const number = chunk.section?.number;
      const title = chunk.section?.title;
      sections.set(chunk.id, { number: typeof number === 'string' ? number : null, title: typeof title === 'string' ? title : null });
    }
  }
  return sections;
}
