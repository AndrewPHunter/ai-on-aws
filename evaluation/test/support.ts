// What the evaluation tests share: temporary folders, invented questions, responses and call records, an in-memory
// agent (a fetch function), and the step judge.sh and reword.sh run on the operator's machine, with the labelled
// stand-in adapter (stand-in-adapter.sh, a test double) in place of the model. All text is invented.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { Question, QuestionType } from '../src/benchmark.ts';
import type { CallRecord } from '../src/run.ts';

export async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'evaluation-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const SET_A = '00000000-0000-4000-8000-0000000000a1';

export function question(qid: string, type: QuestionType, overrides: Partial<Question> = {}): Question {
  return {
    qid,
    set_id: SET_A,
    question: `Invented question ${qid}?`,
    answer: type === 'refusal' ? 'Information not found!' : `Invented answer ${qid}.`,
    references: type === 'refusal' ? [] : ['2.1 Invented Dosing'],
    task: type,
    question_type: type,
    ...overrides,
  };
}

// A benchmark line, with the drug's name and the passage the question was written from.
export const benchmarkLine = (q: Question, context = 'Invented passage.'): string => JSON.stringify({ ...q, drug_name: 'Examplamab', context: [{ text: context }] });

export function response(options: { labelAnswer?: InvocationResponse['label_answer']; reply?: string; strategy?: string } = {}): InvocationResponse {
  const started_at = '2026-03-01T10:00:00.000Z';
  return {
    agent: { id: 'expert', implementation: 'Strands' },
    outcome: 'completed',
    stop_reason: null,
    reply: options.reply ?? 'Invented reply. [1]',
    citations: [{ drug: 'Examplamab', section: 'Invented', quote: 'Invented quote', set_id: SET_A, version: 1, effective_date: '20240102', source: 'https://dailymed.nlm.nih.gov/x', passage: 'passage-zz1' }],
    ...(options.labelAnswer === undefined ? {} : { label_answer: options.labelAnswer }),
    case_actions: [],
    steps: [
      { kind: 'model', started_at, duration_ms: 1, model: 'test-model', finish_reason: 'toolUse', text: null, tool_calls: [], input_tokens: 100, output_tokens: 10 },
      { kind: 'retrieval', started_at, duration_ms: 1, query: 'invented', strategy: options.strategy ?? 'keyword', hits: [] },
    ],
  };
}

export const record = (qid: string, body: InvocationResponse): CallRecord => ({ qid, sent_at: '2026-03-01T10:00:00.000Z', duration_ms: 2000, status: 200, ok: true, reason: null, response: body, body: null });

// --- An in-memory agent: a fetch function the runner is given in place of the network --------------------------------
// It keeps what each call sent (URL, method, authorization header, parsed body) and answers with what the test returns
// for the message's text: a status and a body, or an error to throw.

export type Answer = { status: number; body: string } | Error;
export type Sent = { url: string; method: string | undefined; authorization: string | null; body: { message: { text: string } } };

export const answered = (body: InvocationResponse = response({ labelAnswer: 'answered' })): Answer => ({ status: 200, body: JSON.stringify(body) });

export function agent(answer: (text: string) => Answer | Promise<Answer>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Sent['body'];
    sent.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get('authorization'), body });
    const reply = await answer(body.message.text);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  };
  return { fetch: fake as typeof fetch, sent };
}

// --- The model calls, as judge.sh and reword.sh make them on the operator's machine ----------------------------------
// The labelled stand-in adapter describes itself into a folder, and call-all.sh calls it once per request file in a
// folder with the schema file given, as the scripts do.

const run = promisify(execFile);
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const STAND_IN = here('./stand-in-adapter.sh');

export async function describeAdapter(into: string): Promise<void> {
  await writeFile(join(into, 'describe.json'), (await run(STAND_IN, ['--describe'])).stdout);
}

export async function callAdapter(pending: string, schema: string, log: string): Promise<void> {
  await run(here('../judge/call-all.sh'), [pending, STAND_IN, '4', '20', here(`../${schema}`)], { env: { ...process.env, STAND_IN_LOG: log } });
}

// Every request the stand-in adapter was given, parsed.
export async function requests(log: string): Promise<Record<string, string>[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, string>);
}
