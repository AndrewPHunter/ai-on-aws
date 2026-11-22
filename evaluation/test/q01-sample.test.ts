// Q01. The sample: the same inputs give the same sample; the strata have the configured counts; a question whose label
// is not in the manifest is never drawn; a stratum with too few questions fails with its name; a draw that differs
// from the committed list fails.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import { drawSample } from '../src/sample.ts';
import { InputError } from '../src/benchmark.ts';
import type { Question } from '../src/benchmark.ts';
import { SET_A, SET_B, SET_OUT, benchmarkLine, folder, io, manifestText, question } from './support.ts';

const STRATA = { refusal: 3, factual: 4, multihop: 2, numeric: 2, list: 1 };

// 10 of each type in the corpus, and 5 of each whose label is not in it.
function benchmark(): Question[] {
  const questions: Question[] = [];
  for (const type of ['refusal', 'factual', 'multihop', 'numeric', 'list'] as const) {
    for (let i = 0; i < 10; i++) questions.push(question(`${type}-${String(i).padStart(2, '0')}`, type, { set_id: i % 2 === 0 ? SET_A : SET_B }));
    for (let i = 0; i < 5; i++) questions.push(question(`${type}-out-${i}`, type, { set_id: SET_OUT }));
  }
  return questions;
}

test('Q01. the same inputs give the same sample, with the configured counts, and only labels in the manifest', () => {
  const setIds = new Set([SET_A, SET_B]);
  const first = drawSample(benchmark(), setIds, { seed: 7, strata: STRATA });
  const again = drawSample([...benchmark()].reverse(), setIds, { seed: 7, strata: STRATA });
  assert.deepEqual(again.map((q) => q.qid), first.map((q) => q.qid));
  for (const [type, count] of Object.entries(STRATA)) assert.equal(first.filter((q) => q.question_type === type).length, count, type);
  assert.ok(first.every((q) => q.set_id !== SET_OUT));
  // Another seed draws another sample.
  assert.notDeepEqual(drawSample(benchmark(), setIds, { seed: 8, strata: STRATA }).map((q) => q.qid), first.map((q) => q.qid));
});

test('Q01. a stratum with too few questions fails with its name', () => {
  assert.throws(
    () => drawSample(benchmark(), new Set([SET_A, SET_B]), { seed: 7, strata: { ...STRATA, list: 11 } }),
    (error: unknown) => error instanceof InputError && /the stratum list has 10 questions whose label is in the manifest; 11 are asked for/.test(error.message),
  );
});

test('Q01. the command records the list, then checks every later draw against it; a draw that differs fails', async (t) => {
  const dir = await folder(t);
  const qa = join(dir, 'qa.jsonl');
  const manifest = join(dir, 'manifest.json');
  const settings = join(dir, 'sample.json');
  const out = join(dir, 'data', 'sample.jsonl');
  await writeFile(qa, `${benchmark().map(benchmarkLine).join('\n')}\n`);
  await writeFile(manifest, manifestText([SET_A, SET_B]));
  await writeFile(settings, JSON.stringify({ seed: 7, strata: STRATA, drawnFrom: null, qids: null }));
  const args = ['sample', '--qa', qa, '--manifest', manifest, '--settings', settings, '--out', out];

  // No list yet: refused, with what to do.
  const refused = io();
  assert.equal(await runCommand(args, refused.io), 2);
  assert.match(refused.err.join('\n'), /holds no list of qids yet: run evaluation\/sample.sh --record/);

  const recorded = io();
  assert.equal(await runCommand([...args, '--record'], recorded.io), 0);
  const committed = JSON.parse(await readFile(settings, 'utf8')) as { qids: string[]; drawnFrom: { qa: string; manifest: string } };
  assert.equal(committed.qids.length, 12);
  assert.match(committed.drawnFrom.qa, /^[0-9a-f]{64}$/);

  const checked = io();
  assert.equal(await runCommand(args, checked.io), 0);
  const written = (await readFile(out, 'utf8')).split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as Question).qid);
  assert.deepEqual(written, committed.qids);

  // A manifest that drops a label changes the draw: refused.
  await writeFile(manifest, manifestText([SET_A]));
  await writeFile(settings, JSON.stringify({ ...committed, strata: { refusal: 3, factual: 4, multihop: 2, numeric: 2, list: 1 } }));
  const differs = io();
  assert.equal(await runCommand(args, differs.io), 2);
  assert.match(differs.err.join('\n'), /the draw differs from the list in evaluation\/sample.json .*the benchmark file or the manifest differs/);
});
