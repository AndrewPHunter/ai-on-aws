// Q22. No new command prints a question, a rewrite, an answer or a reply: rewording (each step, and its check file),
// a run on the reworded variant, judging under the answers-question rubric and its check file, scoring with both
// rubrics and wording overlap, and compare across variants with --only-reworded, each run through the command line on
// synthetic data with the labelled stand-in adapters (test doubles), and the captured output searched for the text.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { runCommand } from '../src/cli.ts';
import { benchmarkLineWith, folder, io, question, response, rewordWithStandIn, startAgentStandIn } from './support.ts';

const run = promisify(execFile);
const CALL_ALL = new URL('../judge/call-all.sh', import.meta.url).pathname;
// The labelled stand-in judge adapter (evaluation/test/stand-in-adapter.sh, a test double, not a judge).
const STAND_IN_JUDGE = new URL('./stand-in-adapter.sh', import.meta.url).pathname;
const ANSWERS_SCHEMA = new URL('../judge/answers-question.schema.json', import.meta.url).pathname;

// Words only the question, the answer, the reply, the judge's reason and the rewrite hold.
const SECRET_WORDS = ['Zyxquestion', 'Zyxanswer', 'Zyxreply', 'Invented reason', 'Rephrased', 'Zyxpassage'];

test('Q22. no new command prints a question, a rewrite, an answer or a reply', async (t) => {
  const dir = await folder(t);
  const data = join(dir, 'data');
  await mkdir(data, { recursive: true });
  const questions = ['factual', 'numeric', 'list', 'multihop', 'refusal'].flatMap((type) =>
    Array.from({ length: 2 }, (_, i) => question(`${type}-${i}`, type as 'factual', { question: `Zyxquestion Examplamab ${type} ${i} ${i === 1 ? 'DIFF' : 'GOOD'}?`, answer: `Zyxanswer ${i} 12 mg.` })),
  );
  const sample = join(data, 'sample.jsonl');
  await writeFile(sample, questions.map((q) => `${JSON.stringify(q)}\n`).join(''));
  const knowledge = join(dir, 'knowledge');
  await mkdir(join(knowledge, 'benchmark'), { recursive: true });
  await writeFile(join(knowledge, 'chunk-report.json'), JSON.stringify({ labels: [] }));
  const qa = join(knowledge, 'benchmark', 'qa.jsonl');
  await writeFile(qa, `${questions.map((q) => benchmarkLineWith(q, ['Zyxpassage about the factual numeric dose.'])).join('\n')}\n`);

  const outputs: string[] = [];
  const command = async (argv: string[]): Promise<number> => {
    const captured = io();
    const code = await runCommand(argv, captured.io);
    outputs.push(...captured.out, ...captured.err);
    return code;
  };

  // Rewording, each step, and the pairs for a person.
  const reworded = await rewordWithStandIn({ sample, qa, pending: join(data, 'reword-pending'), calls: join(dir, 'rewriter-calls') }, command);
  assert.deepEqual(reworded, { prepare: 0, checkPrepare: 0, collect: 0 });
  assert.equal(await command(['reword-check', '--sample', sample, '--count', '3']), 0);

  // Two runs, one on each variant.
  const agent = await startAgentStandIn(t, (request) => {
    const text = (request.body as { message: { text: string } }).message.text;
    return { status: 200, body: response({ labelAnswer: 'answered', reply: `Zyxreply ${text.includes('GOOD') ? 'GOOD' : 'HALF'} 12 mg. [1]` }) };
  });
  const runO = join(data, 'runs', 'orig');
  const runR = join(data, 'runs', 'rew');
  assert.equal(await command(['run', '--sample', sample, '--variant', 'original', '--run-dir', runO, '--agent-url', agent.url]), 0);
  assert.equal(await command(['run', '--sample', sample, '--variant', 'reworded', '--run-dir', runR, '--agent-url', agent.url]), 0);

  // Judged under answers-question on the reworded run, as judge.sh does, and the check file written.
  const env = { ...process.env, STAND_IN_CALLS: join(dir, 'judge-calls') };
  assert.equal(await command(['judge-prepare', '--sample', sample, '--run-dir', runR, '--rubric', 'answers-question']), 0);
  const { stdout } = await run(STAND_IN_JUDGE, ['--describe'], { env });
  await writeFile(join(runR, 'judge-pending-answers-question', 'describe.json'), stdout);
  await run(CALL_ALL, [join(runR, 'judge-pending-answers-question'), STAND_IN_JUDGE, '4', '20', ANSWERS_SCHEMA], { env });
  assert.equal(await command(['judge-collect', '--run-dir', runR, '--rubric', 'answers-question']), 0);
  assert.equal(await command(['judge-check', '--sample', sample, '--run-dir', runR, '--rubric', 'answers-question', '--count', '2']), 0);
  // Completeness judgments too, written by hand with the reason text, so both rubrics are scored.
  await writeFile(join(runR, 'judgments-completeness.jsonl'), `${JSON.stringify({ qid: 'factual-0', ok: true, verdict: 'correct', reason: 'Invented reason Zyxreply.' })}\n`);

  assert.equal(await command(['score', '--sample', sample, '--run-dir', runO, '--knowledge-data', knowledge]), 0);
  assert.equal(await command(['score', '--sample', sample, '--run-dir', runR, '--knowledge-data', knowledge]), 0);
  assert.equal(await command(['compare', '--run-a', runO, '--run-b', runR]), 0);
  assert.equal(await command(['compare', '--run-a', runO, '--run-b', runR, '--only-reworded']), 0);

  const printed = outputs.join('\n');
  // The commands said something: counts, the rubric, the thirds.
  assert.ok(printed.includes('rubric answers-question (judged 8, judge failures 0):'));
  assert.ok(printed.includes('restricted to the 4 questions actually reworded'));
  for (const word of SECRET_WORDS) assert.equal(printed.includes(word), false, word);
});
