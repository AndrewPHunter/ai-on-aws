// The invariants the command line holds ("Always true" 8 and 9 in docs/architecture/evaluation.md): a run is pinned
// to its variant's file, and nothing of a question, answer, reply, rewrite or reason is printed. Each command runs
// through runCommand with an in-memory agent and sign-in, on invented files in a temporary folder; the model calls
// go through evaluation/judge/call-all.sh and the labelled stand-in adapter (a test double).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import type { CommandIo } from '../src/cli.ts';
import type { Question } from '../src/benchmark.ts';
import { SET_A, agent, answered, benchmarkLine, callAdapter, describeAdapter, folder, question, response } from './support.ts';
import type { Answer } from './support.ts';

const NOW = new Date('2026-03-01T10:00:00.000Z');

// A run folder's surroundings: the benchmark file and the chunk report score reads, and the commands' output.
async function workspace(dir: string, questions: Question[], answer: (text: string) => Answer) {
  const data = join(dir, 'data');
  const knowledge = join(dir, 'knowledge');
  await mkdir(join(knowledge, 'benchmark'), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(join(knowledge, 'chunk-report.json'), JSON.stringify({ labels: [] }));
  const qa = join(knowledge, 'benchmark', 'qa.jsonl');
  await writeFile(qa, `${questions.map((q) => benchmarkLine(q, 'Zyxpassage about the dose.')).join('\n')}\n`);
  const stand = agent(answer);
  const printed: string[] = [];
  const io: CommandIo = {
    fetch: stand.fetch,
    now: () => NOW,
    env: {},
    log: (line) => printed.push(line),
    warn: (line) => printed.push(line),
    signIn: () => Promise.resolve({ token: 'token-1', expiresAt: NOW.getTime() + 600_000 }),
  };
  const command = (...argv: string[]): Promise<number> => runCommand(argv, io);
  return { data, knowledge, qa, sample: join(data, 'sample.jsonl'), stand, printed, command };
}

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

test('evaluation 8. a run records its variant and its file\'s SHA-256; scoring and judging refuse it once that file has changed', async (t) => {
  const dir = await folder(t);
  const original = question('f1', 'factual', { question: 'Invented original question?' });
  const refusal = question('r1', 'refusal');
  const w = await workspace(dir, [original, refusal], () => answered());
  await writeFile(w.sample, [original, refusal].map((q) => `${JSON.stringify(q)}\n`).join(''));
  const reworded = join(w.data, 'sample-reworded.jsonl');
  await writeFile(reworded, `${JSON.stringify({ ...original, question: 'Invented reworded question?', reworded: true, kept_because: null })}\n${JSON.stringify({ ...refusal, reworded: false, kept_because: 'copied' })}\n`);
  const runDir = join(w.data, 'runs', 'r');
  const score = () => w.command('score', '--sample', w.sample, '--run-dir', runDir, '--knowledge-data', w.knowledge);
  const prepare = () => w.command('judge-prepare', '--sample', w.sample, '--run-dir', runDir, '--rubric', 'answers-question');

  assert.equal(await w.command('run', '--sample', w.sample, '--variant', 'reworded', '--run-dir', runDir, '--agent-url', 'http://agent.test'), 0);
  const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as { variant: string; sample_sha256: string };
  assert.deepEqual([run.variant, run.sample_sha256], ['reworded', await sha256(reworded)]);
  assert.ok(w.stand.sent.some((call) => call.body.message.text === 'Invented reworded question?'));

  // Unchanged: scored and judged, and the judge is given the question the run sent.
  assert.equal(await score(), 0);
  assert.equal(await prepare(), 0);
  const pending = join(runDir, 'judge-pending-answers-question');
  const [request] = (await readdir(pending)).filter((name) => name !== 'index.json');
  assert.equal((JSON.parse(await readFile(join(pending, request ?? ''), 'utf8')) as { question: string }).question, 'Invented reworded question?');

  await appendFile(reworded, '\n');
  assert.equal(await score(), 2);
  assert.equal(await prepare(), 2);
});

test('evaluation 9. no command prints a question, an answer, a reply, a rewrite or a model\'s reason, or writes one to a tracked file', async (t) => {
  const dir = await folder(t);
  const markers = ['Zyxquestion', 'Zyxanswer', 'Zyxreply', 'Zyxpassage', 'Rephrased', 'Invented reason'];
  const questions = (['refusal', 'factual', 'factual', 'numeric'] as const).map((type, at) =>
    question(`${type}-${at}`, type, { question: `Zyxquestion Examplamab ${at}?`, ...(type === 'refusal' ? {} : { answer: `Zyxanswer ${at} mg.` }) }),
  );
  let calls = 0;
  const w = await workspace(dir, questions, () => (calls++ === 0 ? { status: 500, body: '{"error":"Zyxreply in an error"}' } : answered(response({ labelAnswer: 'answered', reply: 'Zyxreply GOOD 12 mg. [1]' }))));
  const manifest = join(dir, 'manifest.json');
  const settings = join(dir, 'sample.json');
  await writeFile(manifest, JSON.stringify({ labels: [{ setId: SET_A, version: 1, documentId: SET_A, effectiveTime: '20240102', publishedDate: '2024-01-02', documentTypeCode: '34391-3', zipSha256: '1'.repeat(64), xmlSha256: '2'.repeat(64), xmlBytes: 100 }], notPinned: [] }));
  await writeFile(settings, JSON.stringify({ seed: 1, strata: { refusal: 1, factual: 2, multihop: 0, numeric: 1, list: 0 }, drawnFrom: null, qids: null }));
  const pending = join(w.data, 'reword-pending');
  const log = join(dir, 'log');
  const runA = join(w.data, 'runs', 'a');
  const runB = join(w.data, 'runs', 'b');
  const judging = join(runB, 'judge-pending-answers-question');
  const reword = ['--sample', w.sample, '--qa', w.qa, '--pending', pending];
  const broken = join(dir, 'broken.jsonl');
  await writeFile(broken, '{"qid": "Zyxquestion not JSON\n');
  // Each command with its exit code, and between them the model calls the scripts make on the operator's machine.
  const steps: ([string[], number] | (() => Promise<void>))[] = [
    [['sample', '--qa', w.qa, '--manifest', manifest, '--settings', settings, '--out', w.sample, '--record'], 0],
    [['sample', '--qa', w.qa, '--manifest', manifest, '--settings', settings, '--out', w.sample], 0],
    [['reword-prepare', ...reword], 0],
    () => describeAdapter(pending),
    () => callAdapter(join(pending, 'rewrite'), 'reword/rewrite.schema.json', log),
    [['reword-check-prepare', ...reword], 0],
    () => callAdapter(join(pending, 'check'), 'reword/same.schema.json', log),
    [['reword-collect', ...reword], 0],
    [['reword-check', '--sample', w.sample, '--count', '2'], 0],
    [['run', '--sample', w.sample, '--variant', 'original', '--run-dir', runA, '--agent-url', 'http://agent.test'], 1],
    [['run', '--sample', w.sample, '--variant', 'original', '--run-dir', runA, '--agent-url', 'http://agent.test', '--retry-failed'], 0],
    [['run', '--sample', w.sample, '--variant', 'reworded', '--run-dir', runB, '--agent-url', 'http://agent.test'], 0],
    [['judge-prepare', '--sample', w.sample, '--run-dir', runB, '--rubric', 'answers-question'], 0],
    () => describeAdapter(judging),
    () => callAdapter(judging, 'judge/answers-question.schema.json', log),
    [['judge-collect', '--run-dir', runB, '--rubric', 'answers-question'], 0],
    [['judge-check', '--sample', w.sample, '--run-dir', runB, '--rubric', 'answers-question', '--count', '2'], 0],
    [['score', '--sample', w.sample, '--run-dir', runA, '--knowledge-data', w.knowledge], 0],
    [['score', '--sample', w.sample, '--run-dir', runB, '--knowledge-data', w.knowledge], 0],
    [['compare', '--run-a', runA, '--run-b', runB, '--only-reworded'], 0],
    [['score', '--sample', broken, '--run-dir', runA, '--knowledge-data', w.knowledge], 2],
  ];
  for (const step of steps) {
    if (typeof step === 'function') await step();
    else assert.equal(await w.command(...step[0]), step[1], step[0].slice(0, 2).join(' '));
  }

  // The files hold the text (so its absence from the output means something), and the commands printed.
  assert.ok((await readFile(join(w.data, 'sample-reworded.jsonl'), 'utf8')).includes('Rephrased'));
  assert.ok((await readFile(join(runB, 'judgments-answers-question.jsonl'), 'utf8')).includes('Invented reason'));
  assert.ok(w.printed.length > 0);
  const output = w.printed.join('\n');
  // The one tracked file a command writes: evaluation/sample.json, by sample --record.
  const tracked = await readFile(settings, 'utf8');
  for (const marker of markers) assert.equal(output.includes(marker) || tracked.includes(marker), false, marker);
});
