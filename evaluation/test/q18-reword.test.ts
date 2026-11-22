// Q18 and Q19. Rewording through the labelled stand-in rewriter (a test double): a rewrite judged the same is used;
// one judged different, one whose rewrite call failed and one whose check call failed keep the original and are
// counted with the reason; refusal questions are copied; a rewrite missing the drug's name is not the same, and the
// checker is not asked; nor is it for a rewrite that is the original again, ignoring case and white space. The
// rewriter's request holds the question and the drug's name and nothing else; the checker's the two questions and
// nothing else.

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCommand } from '../src/cli.ts';
import { CHECK_INSTRUCTIONS, KEPT, REWRITE_INSTRUCTIONS, checkRequest, keepsName, nameAsWritten, rewriteRequest } from '../src/reword.ts';
import type { RewordedQuestion } from '../src/reword.ts';
import { benchmarkLineWith, folder, io, question, rewordWithStandIn } from './support.ts';

async function fixture(dir: string, questions: ReturnType<typeof question>[]) {
  const data = join(dir, 'data');
  await mkdir(data, { recursive: true });
  const sample = join(data, 'sample.jsonl');
  const qa = join(dir, 'qa.jsonl');
  await writeFile(sample, questions.map((q) => `${JSON.stringify(q)}\n`).join(''));
  await writeFile(qa, `${questions.map((q) => benchmarkLineWith(q, ['Invented passage about the dose.'])).join('\n')}\n`);
  return { data, sample, qa, pending: join(data, 'reword-pending'), calls: join(dir, 'calls') };
}

test('Q18. rewrites used, kept with their reasons, refusal questions copied, and a lost drug name or an unchanged rewrite never sent to the checker', async (t) => {
  const dir = await folder(t);
  const questions = [
    question('good', 'factual', { question: 'What Examplamab dose, GOOD?' }),
    question('diff', 'factual', { question: 'What Examplamab dose, DIFF?' }),
    question('rwfail', 'numeric', { question: 'What Examplamab dose, RWFAIL?' }),
    question('ckfail', 'list', { question: 'What Examplamab doses, CKFAIL?' }),
    question('noname', 'factual', { question: 'What Examplamab dose, NONAME?' }),
    question('same', 'factual', { question: 'What Examplamab dose, SAMEAGAIN?' }),
    question('nodrug', 'multihop', { question: 'What dose is used, with no drug named?' }),
    question('refuse', 'refusal', { question: 'Invented refusal question?' }),
  ];
  const paths = await fixture(dir, questions);
  const out: string[] = [];
  const command = async (argv: string[]): Promise<number> => {
    const captured = io();
    const code = await runCommand(argv, captured.io);
    out.push(...captured.out, ...captured.err);
    return code;
  };

  const codes = await rewordWithStandIn(paths, command);
  // Two model calls failed (a rewrite, a check): the file is written, and the exit code says so.
  assert.deepEqual(codes, { prepare: 0, checkPrepare: 0, collect: 1 });

  // Seven rewrites asked (not the refusal question); four checks: not the failed rewrite, not the one that lost the
  // name, not the one that is the original again.
  const calls = (await readFile(paths.calls, 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual([calls.filter((c) => c === 'rewrite').length, calls.filter((c) => c === 'check').length], [7, 4]);

  const lines = (await readFile(join(paths.data, 'sample-reworded.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as RewordedQuestion);
  assert.deepEqual(lines.map((line) => line.qid), questions.map((q) => q.qid));
  const by = new Map(lines.map((line) => [line.qid, line]));
  assert.deepEqual([by.get('good')?.reworded, by.get('good')?.question, by.get('good')?.kept_because], [true, 'Rephrased Examplamab query?', null]);
  assert.deepEqual([by.get('nodrug')?.reworded, by.get('nodrug')?.kept_because], [true, null]);
  for (const [qid, because] of [
    ['diff', KEPT.notSame],
    ['rwfail', KEPT.rewriteFailed],
    ['ckfail', KEPT.checkFailed],
    ['noname', KEPT.nameMissing],
    ['same', KEPT.unchanged],
    ['refuse', KEPT.refusal],
  ] as const) {
    const line = by.get(qid);
    const original = questions.find((q) => q.qid === qid);
    assert.deepEqual([line?.reworded, line?.kept_because, line?.question], [false, because, original?.question], qid);
  }
  // Everything but the text is the sample's.
  for (const q of questions) {
    const { reworded: _r, kept_because: _k, question: _q, ...rest } = by.get(q.qid) as RewordedQuestion;
    const { question: _o, ...expected } = q;
    assert.deepEqual(rest, expected);
  }

  // The counts, with each reason; the record beside the file; the pending folder gone.
  assert.ok(out.includes('wrote evaluation/data/sample-reworded.jsonl: 8 questions; reworded 2; refusal questions copied 1'));
  for (const because of [KEPT.notSame, KEPT.rewriteFailed, KEPT.checkFailed, KEPT.nameMissing, KEPT.unchanged]) assert.ok(out.includes(`  kept the original, 1: ${because}`), because);
  assert.ok(out.includes('model calls that failed: 2'));
  assert.ok(out.some((line) => line.startsWith('wording overlap before: median')));
  const record = JSON.parse(await readFile(join(paths.data, 'sample-reworded.json'), 'utf8')) as { rewriter: unknown; counts: { reworded: number } };
  assert.deepEqual([record.rewriter, record.counts.reworded], [{ rewriter: 'stand-in', model: 'none', effort: 'none' }, 2]);
  assert.equal((await readdir(paths.data)).includes('reword-pending'), false);

  // Started again with the file in place: refused, the file untouched.
  const before = await readFile(join(paths.data, 'sample-reworded.jsonl'), 'utf8');
  assert.equal(await command(['reword-prepare', '--sample', paths.sample, '--qa', paths.qa, '--pending', paths.pending]), 2);
  assert.equal(await readFile(join(paths.data, 'sample-reworded.jsonl'), 'utf8'), before);
});

test('Q18. the drug\'s name is kept as the original writes it; a question that does not name the drug has none to keep', () => {
  assert.equal(nameAsWritten('Dose of Examplamab?', 'Examplamab'), 'Examplamab');
  assert.equal(nameAsWritten('Dose of EXAMPLAMAB?', 'Examplamab'), 'EXAMPLAMAB');
  assert.equal(nameAsWritten('Dose for adults?', 'Examplamab'), null);
  assert.equal(keepsName('Dose of EXAMPLAMAB?', 'How much EXAMPLAMAB?', 'Examplamab'), true);
  assert.equal(keepsName('Dose of EXAMPLAMAB?', 'How much Examplamab?', 'Examplamab'), false);
  assert.equal(keepsName('Dose of Examplamab?', 'How much of it?', 'Examplamab'), false);
  assert.equal(keepsName('Dose for adults?', 'How much for grown-ups?', 'Examplamab'), true);
});

test('Q19. the rewriter\'s request holds the question and the drug\'s name, the checker\'s the two questions, and nothing else', async (t) => {
  const rewrite = rewriteRequest('Invented question?', 'Examplamab');
  assert.deepEqual(rewrite, { instructions: REWRITE_INSTRUCTIONS, question: 'Invented question?', drug_name: 'Examplamab' });
  const check = checkRequest('Invented question?', 'Invented rewrite?');
  assert.deepEqual(check, { instructions: CHECK_INSTRUCTIONS, original: 'Invented question?', rewrite: 'Invented rewrite?' });

  // The request files reword-prepare writes hold the same, and no qid, set id, answer or reference.
  const dir = await folder(t);
  const q = question('qid-zz', 'factual', { question: 'Invented Examplamab question?', answer: 'Invented answer text.', references: ['9.9 Invented Section'] });
  const paths = await fixture(dir, [q]);
  assert.equal(await runCommand(['reword-prepare', '--sample', paths.sample, '--qa', paths.qa, '--pending', paths.pending], io().io), 0);
  const files = (await readdir(join(paths.pending, 'rewrite'))).filter((name) => name !== 'index.json');
  assert.equal(files.length, 1);
  const written = await readFile(join(paths.pending, 'rewrite', files[0] ?? ''), 'utf8');
  assert.deepEqual(JSON.parse(written), { instructions: REWRITE_INSTRUCTIONS, question: 'Invented Examplamab question?', drug_name: 'Examplamab' });
  for (const absent of ['qid-zz', '00000000-0000-4000-8000', 'Invented answer text', '9.9 Invented Section', 'passage']) assert.equal(written.includes(absent), false, absent);
});
