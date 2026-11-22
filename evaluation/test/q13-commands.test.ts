// Q13. The commands' exit codes, and that no command prints a question, an answer, a reply or a judge's reason:
// every command is run through the command line on synthetic data, and its captured output is searched for the text.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import { SET_A, benchmarkLine, folder, io, manifestText, question, response, startAgentStandIn } from './support.ts';

const SECRET_WORDS = ['Zyxquestion', 'Zyxanswer', 'Zyxreply', 'Zyxreason'];

test('Q13. exit codes, and no question, answer, reply or reason in any output', async (t) => {
  const dir = await folder(t);
  const questions = ['refusal', 'factual', 'multihop', 'numeric', 'list'].flatMap((type) =>
    Array.from({ length: 3 }, (_, i) => question(`${type}-${i}`, type as 'factual', { question: `Zyxquestion ${type} ${i}?`, answer: `Zyxanswer ${i} 12 mg.` })),
  );
  const qa = join(dir, 'qa.jsonl');
  const manifest = join(dir, 'manifest.json');
  const settings = join(dir, 'sample.json');
  const sample = join(dir, 'data', 'sample.jsonl');
  await writeFile(qa, `${questions.map(benchmarkLine).join('\n')}\n`);
  await writeFile(manifest, manifestText([SET_A]));
  await writeFile(settings, JSON.stringify({ seed: 1, strata: { refusal: 1, factual: 2, multihop: 1, numeric: 1, list: 1 }, drawnFrom: null, qids: null }));
  const knowledge = join(dir, 'knowledge');
  await mkdir(knowledge, { recursive: true });
  await writeFile(join(knowledge, 'chunk-report.json'), JSON.stringify({ labels: [] }));

  const outputs: string[] = [];
  const command = async (argv: string[]): Promise<number> => {
    const captured = io();
    const code = await runCommand(argv, captured.io);
    outputs.push(...captured.out, ...captured.err);
    return code;
  };

  assert.equal(await command(['sample', '--qa', qa, '--manifest', manifest, '--settings', settings, '--out', sample, '--record']), 0);
  assert.equal(await command(['sample', '--qa', qa, '--manifest', manifest, '--settings', settings, '--out', sample]), 0);

  // A run where one question's call fails: exit 1.
  let n = 0;
  const agent = await startAgentStandIn(t, () => (n++ === 0 ? { status: 500, body: { error: 'Zyxreply in an error' } } : { status: 200, body: response({ labelAnswer: 'answered', reply: 'Zyxreply 12 mg. [1]' }) }));
  const runA = join(dir, 'runs', 'a');
  assert.equal(await command(['run', '--sample', sample, '--run-dir', runA, '--agent-url', agent.url]), 1);
  // Retried: every question has a response: exit 0.
  assert.equal(await command(['run', '--sample', sample, '--run-dir', runA, '--agent-url', agent.url, '--retry-failed']), 0);

  // Judged by hand-written verdicts that carry the reason text.
  await writeFile(join(runA, 'judgments.jsonl'), `${JSON.stringify({ qid: 'factual-0', ok: true, verdict: 'correct', reason: 'Zyxreason.' })}\n`);
  await writeFile(join(runA, 'judge.json'), '{}');
  assert.equal(await command(['score', '--sample', sample, '--run-dir', runA, '--knowledge-data', knowledge]), 0);
  assert.equal(await command(['judge-check', '--sample', sample, '--run-dir', runA, '--count', '1']), 0);

  const runB = join(dir, 'runs', 'b');
  assert.equal(await command(['run', '--sample', sample, '--run-dir', runB, '--agent-url', agent.url]), 0);
  assert.equal(await command(['score', '--sample', sample, '--run-dir', runB, '--knowledge-data', knowledge]), 0);
  assert.equal(await command(['compare', '--run-a', runA, '--run-b', runB]), 0);
  assert.equal(await command(['judge-prepare', '--sample', sample, '--run-dir', runB]), 0);

  // Could not run: an unknown command, a missing flag, a run that does not exist, a sample that is not JSON.
  assert.equal(await command(['nonsense']), 2);
  assert.equal(await command(['score', '--sample', sample]), 2);
  assert.equal(await command(['score', '--sample', sample, '--run-dir', join(dir, 'runs', 'none'), '--knowledge-data', knowledge]), 2);
  await writeFile(join(dir, 'broken.jsonl'), '{"qid": "Zyxquestion not json\n');
  assert.equal(await command(['score', '--sample', join(dir, 'broken.jsonl'), '--run-dir', runA, '--knowledge-data', knowledge]), 2);
  // The runner with no identity secrets and no injected sign-in.
  const bare = io();
  const { signIn: _unused, ...withoutSignIn } = bare.io;
  assert.equal(await runCommand(['run', '--sample', sample, '--run-dir', join(dir, 'runs', 'c'), '--agent-url', agent.url], withoutSignIn), 2);
  assert.match(bare.err.join('\n'), /IDENTITY_DESK_CLIENT_SECRET and IDENTITY_DANA_PASSWORD must be set/);

  const printed = outputs.join('\n');
  assert.ok(printed.length > 0);
  for (const word of SECRET_WORDS) assert.equal(printed.includes(word), false, word);
});
