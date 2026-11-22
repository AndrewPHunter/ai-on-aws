// Q20 and Q21. A run on the reworded variant sends the reworded text and records the variant and its file's hash;
// scoring reads that variant's file, and refuses a run whose variant file has changed since. compare across variants:
// the same set of question ids required; --only-reworded restricts to the questions actually reworded; the paired
// counts within each third of wording overlap.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import { benchmarkLineWith, folder, io, question, response, startAgentStandIn } from './support.ts';

test('Q20. run --variant reworded sends the reworded text, records the variant and hash; score reads that file and refuses it changed', async (t) => {
  const dir = await folder(t);
  const data = join(dir, 'data');
  await mkdir(data, { recursive: true });
  const original = [
    question('a', 'factual', { question: 'Which Examplamab dose for kidney failure?' }),
    question('b', 'factual', { question: 'Which Examplamab dose for liver failure?' }),
    question('r', 'refusal', { question: 'Invented refusal question?' }),
  ];
  // a is reworded into words its passage does not hold; b kept its text.
  const reworded = [
    { ...original[0], question: 'How much Examplamab with poor renal function?', reworded: true, kept_because: null },
    { ...original[1], reworded: false, kept_because: 'the checker judged it not the same' },
    { ...original[2], reworded: false, kept_because: 'a refusal question: copied unchanged' },
  ];
  const sample = join(data, 'sample.jsonl');
  const rewordedFile = join(data, 'sample-reworded.jsonl');
  await writeFile(sample, original.map((q) => `${JSON.stringify(q)}\n`).join(''));
  const rewordedText = reworded.map((q) => `${JSON.stringify(q)}\n`).join('');
  await writeFile(rewordedFile, rewordedText);
  const knowledge = join(dir, 'knowledge');
  await mkdir(join(knowledge, 'benchmark'), { recursive: true });
  await writeFile(join(knowledge, 'chunk-report.json'), JSON.stringify({ labels: [] }));
  await writeFile(
    join(knowledge, 'benchmark', 'qa.jsonl'),
    `${original.map((q) => benchmarkLineWith(q, ['The dose for kidney failure and liver failure is listed in the table.'])).join('\n')}\n`,
  );

  const agent = await startAgentStandIn(t, () => ({ status: 200, body: response({ labelAnswer: 'answered' }) }));
  const runDir = join(dir, 'runs', 'reworded-1');
  assert.equal(await runCommand(['run', '--sample', sample, '--variant', 'reworded', '--run-dir', runDir, '--agent-url', agent.url], io().io), 0);
  const sent = new Map(agent.received.map((request) => {
    const message = (request.body as { message: { id: string; text: string } }).message;
    return [message.id, message.text];
  }));
  assert.deepEqual(Object.fromEntries(sent), { 'eval-a': 'How much Examplamab with poor renal function?', 'eval-b': original[1]?.question, 'eval-r': original[2]?.question });
  const runFile = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as { variant: string; sample_sha256: string };
  assert.deepEqual([runFile.variant, runFile.sample_sha256], ['reworded', createHash('sha256').update(rewordedText).digest('hex')]);

  // The same run started on the original sample is refused.
  const other = io();
  assert.equal(await runCommand(['run', '--sample', sample, '--variant', 'original', '--run-dir', runDir, '--agent-url', agent.url], other.io), 2);
  assert.ok(other.out.some((line) => line.includes('this run was made on the reworded sample, not the original one')));

  // Scored against the reworded file: its variant, the qids reworded, and the overlap of the text that was sent.
  const scored = io();
  assert.equal(await runCommand(['score', '--sample', sample, '--run-dir', runDir, '--knowledge-data', knowledge], scored.io), 0);
  const scores = JSON.parse(await readFile(join(runDir, 'scores.json'), 'utf8')) as { variant: string; rewordedQids: string[]; overlap: { byQid: Record<string, { overlap: number }> } };
  assert.deepEqual([scores.variant, scores.rewordedQids], ['reworded', ['a']]);
  // a's reworded content words (much, poor, renal, function) are not in the passage; b's original ones all are.
  assert.equal(scores.overlap.byQid.a?.overlap, 0);
  assert.equal(scores.overlap.byQid.b?.overlap, 1);
  assert.ok(scored.out.includes('sample variant: reworded (1 questions reworded)'));

  // The reworded file changed since the run: refused.
  await writeFile(rewordedFile, rewordedText.replace('poor renal function', 'weak kidneys'));
  const refused = io();
  assert.equal(await runCommand(['score', '--sample', sample, '--run-dir', runDir, '--knowledge-data', knowledge], refused.io), 2);
  assert.match(refused.err.join('\n'), /was made on the reworded sample, and that file has changed since/);
});

// A run folder with a run file and scores written as score.sh writes them, for compare.
async function scoredRun(dir: string, name: string, variant: string, sha: string, marks: Record<string, boolean>, thirds: Record<string, 1 | 2 | 3>, reworded: string[]): Promise<string> {
  const runDir = join(dir, name);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), JSON.stringify({ variant, sample_sha256: sha, agent_id: 'expert', models: [], strategies: [], started_at: '', ended_at: '' }));
  const perQuestion = Object.fromEntries(Object.entries(marks).map(([qid, value]) => [qid, { retrieved_first: value, retrieved_any: value }]));
  const byQid = Object.fromEntries(Object.entries(thirds).map(([qid, third]) => [qid, { overlap: third / 4, third }]));
  await writeFile(join(runDir, 'scores.json'), JSON.stringify({ perQuestion, variant, rewordedQids: reworded, overlap: { cuts: { low: 0.25, high: 0.5 }, byQid } }));
  return runDir;
}

test('Q21. compare across variants: the same set of ids, --only-reworded, and the paired counts in each third', async (t) => {
  const dir = await folder(t);
  const thirds = { q1: 1, q2: 1, q3: 2, q4: 2, q5: 3, q6: 3 } as const;
  //                       q1     q2     q3     q4     q5     q6
  const a = await scoredRun(dir, 'orig', 'original', 'a'.repeat(64), { q1: true, q2: true, q3: true, q4: false, q5: true, q6: false }, thirds, []);
  const b = await scoredRun(dir, 'rew', 'reworded', 'b'.repeat(64), { q1: false, q2: true, q3: false, q4: false, q5: true, q6: true }, { q1: 1, q2: 2, q3: 2, q4: 3, q5: 3, q6: 3 }, ['q1', 'q3', 'q6']);

  const all = io();
  assert.equal(await runCommand(['compare', '--run-a', a, '--run-b', b], all.io), 0);
  assert.equal(all.out[0], 'compared: orig (sample variant original) against rew (sample variant reworded)');
  const written = JSON.parse(await readFile(join(b, 'compare-orig.json'), 'utf8')) as {
    variants: unknown;
    rows: { measure: string; both: number; onlyA: number; onlyB: number; neither: number }[];
    byThird: { third: number; questions: number; rows: { measure: string; both: number; onlyA: number; onlyB: number; neither: number }[] }[];
  };
  assert.deepEqual(written.variants, { runA: 'original', runB: 'reworded' });
  const counts = (row: { both: number; onlyA: number; onlyB: number; neither: number } | undefined) => [row?.both, row?.onlyA, row?.onlyB, row?.neither];
  assert.deepEqual(counts(written.rows.find((row) => row.measure === 'retrieved_first')), [2, 2, 1, 1]);
  // By run A's thirds: q1 q2 | q3 q4 | q5 q6.
  const first = written.byThird.map((third) => [third.questions, ...counts(third.rows.find((row) => row.measure === 'retrieved_first'))]);
  assert.deepEqual(first, [
    [2, 1, 1, 0, 0],
    [2, 0, 1, 0, 1],
    [2, 1, 0, 1, 0],
  ]);
  assert.ok(all.out.some((line) => line.startsWith("by thirds of wording overlap, as orig's scores cut them (thirds cut at 25.0% and 50.0%)")));

  // Only the questions actually reworded: q1, q3, q6.
  const only = io();
  assert.equal(await runCommand(['compare', '--run-a', a, '--run-b', b, '--only-reworded'], only.io), 0);
  assert.ok(only.out.includes('restricted to the 3 questions actually reworded'));
  const restricted = JSON.parse(await readFile(join(b, 'compare-orig-only-reworded.json'), 'utf8')) as typeof written;
  assert.deepEqual(counts(restricted.rows.find((row) => row.measure === 'retrieved_first')), [0, 2, 1, 0]);
  assert.deepEqual(restricted.byThird.map((third) => third.questions), [1, 1, 1]);

  // --only-reworded needs a reworded run; two original runs on the same file compare without it.
  const a2 = await scoredRun(dir, 'orig2', 'original', 'a'.repeat(64), { q1: true, q2: true, q3: true, q4: true, q5: true, q6: true }, thirds, []);
  const neither = io();
  assert.equal(await runCommand(['compare', '--run-a', a, '--run-b', a2, '--only-reworded'], neither.io), 2);
  assert.match(neither.err.join('\n'), /--only-reworded needs a run made on the reworded sample/);

  // A different set of question ids: refused, whatever the variants.
  const fewer = await scoredRun(dir, 'fewer', 'reworded', 'b'.repeat(64), { q1: true, q2: true, q3: true, q4: true, q5: true }, thirds, ['q1']);
  const refused = io();
  assert.equal(await runCommand(['compare', '--run-a', a, '--run-b', fewer], refused.io), 2);
  assert.match(refused.err.join('\n'), /were not made on the same set of questions/);
});
