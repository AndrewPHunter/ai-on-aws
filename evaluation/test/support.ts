// What the evaluation tests share: temporary folders, synthetic benchmark questions and manifests, contract
// responses built for a measure, one test double (labelled below): a stand-in agent, and the steps of reword.sh run
// with another (the stand-in rewriter, labelled in its own file). All text is invented.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { InvocationResponse, Step } from '../../shared/agent-contract.ts';
import type { Question, QuestionType } from '../src/benchmark.ts';
import type { CallRecord } from '../src/run.ts';

export async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'evaluation-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const SET_A = '00000000-0000-4000-8000-0000000000a1';
export const SET_B = '00000000-0000-4000-8000-0000000000b2';
export const SET_OUT = '00000000-0000-4000-8000-0000000000c3';

export function question(qid: string, type: QuestionType, overrides: Partial<Question> = {}): Question {
  return {
    qid,
    set_id: SET_A,
    question: `Invented question ${qid}?`,
    answer: type === 'refusal' ? 'Information not found!' : `Invented answer ${qid}.`,
    references: type === 'refusal' ? [] : ['2.1 Invented Dosing'],
    task: type === 'numeric' || type === 'list' ? 'factual' : type,
    question_type: type,
    ...overrides,
  };
}

// A benchmark line as the benchmark file holds it.
export const benchmarkLine = (q: Question): string => JSON.stringify({ ...q, drug_name: 'Examplamab', citations: [], context: [], source: 'invented' });

// A benchmark line with the passages it was written from, as the benchmark's `context` entries hold them.
export const benchmarkLineWith = (q: Question, context: readonly string[], drugName = 'Examplamab'): string =>
  JSON.stringify({ ...q, drug_name: drugName, citations: [], context: context.map((text, at) => ({ doc_id: 'invented', section_code: 'x', section_title: 'Invented', text, doc_chunk_index: at, section_chunk_index: at, has_answer: true })), source: 'invented' });

export function manifestText(setIds: readonly string[]): string {
  const hex = (n: number): string => n.toString(16).padStart(64, '0');
  return JSON.stringify({
    labels: setIds.map((setId, i) => ({
      setId,
      version: 1,
      documentId: `${setId.slice(0, 35)}${i}`,
      effectiveTime: '20240102',
      publishedDate: '2024-01-02',
      documentTypeCode: '34391-3',
      zipSha256: hex(i + 1),
      xmlSha256: hex(i + 100),
      xmlBytes: 100,
    })),
    notPinned: [],
  });
}

export type ResponseOptions = {
  outcome?: InvocationResponse['outcome'];
  labelAnswer?: InvocationResponse['label_answer'];
  reply?: string;
  citations?: { set_id?: string; passage: string }[];
  searches?: { strategy?: string; hits: { passage: string; shown: boolean }[] }[];
  corrections?: number;
  tokens?: { input: number; output: number }[];
  model?: string;
};

export function response(options: ResponseOptions = {}): InvocationResponse {
  const steps: Step[] = [];
  const started_at = '2026-03-01T10:00:00.000Z';
  for (const tokens of options.tokens ?? [{ input: 100, output: 10 }]) {
    steps.push({ kind: 'model', started_at, duration_ms: 1, model: options.model ?? 'test-model', finish_reason: 'toolUse', text: null, tool_calls: [], input_tokens: tokens.input, output_tokens: tokens.output });
  }
  for (const search of options.searches ?? []) {
    steps.push({
      kind: 'retrieval',
      started_at,
      duration_ms: 1,
      query: 'invented',
      strategy: search.strategy ?? 'keyword',
      hits: search.hits.map((hit, at) => ({ drug: 'Examplamab', section: 'Invented', score: 1, excerpt: 'Invented', passage: hit.passage, handle: `P${at + 1}`, shown: hit.shown })),
    });
  }
  for (let i = 0; i < (options.corrections ?? 0); i++) {
    steps.push({ kind: 'tool', started_at, duration_ms: 0, tool: 'answer', requested_by: 'model', arguments: {}, result: { error: 'answer_not_accepted' }, is_error: true });
  }
  const outcome = options.outcome ?? 'completed';
  return {
    agent: { id: 'expert', implementation: 'Strands' },
    outcome,
    stop_reason: outcome === 'completed' ? null : 'Invented stop reason.',
    reply: options.reply ?? 'Invented reply. [1]',
    citations: (options.citations ?? []).map((citation) => ({
      drug: 'Examplamab',
      section: 'Invented',
      quote: 'Invented quote',
      set_id: citation.set_id ?? SET_A,
      version: 1,
      effective_date: '20240102',
      source: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x',
      passage: citation.passage,
    })),
    ...(outcome === 'completed' && options.labelAnswer !== undefined ? { label_answer: options.labelAnswer } : {}),
    case_actions: [],
    steps,
  };
}

export function record(qid: string, body: InvocationResponse | null, fields: Partial<CallRecord> = {}): CallRecord {
  return {
    qid,
    sent_at: '2026-03-01T10:00:00.000Z',
    duration_ms: 2000,
    status: body === null ? null : 200,
    ok: body !== null,
    reason: body === null ? 'the connection failed' : null,
    response: body,
    body: null,
    ...fields,
  };
}

export async function writeLines(path: string, values: readonly unknown[]): Promise<void> {
  await writeFile(path, values.map((value) => `${typeof value === 'string' ? value : JSON.stringify(value)}\n`).join(''));
}

// --- Test double: a stand-in agent ------------------------------------------------------------------------------
// STAND-IN for the label expert's HTTP contract, for the runner's tests. NOT an agent. It records every request (the
// body parsed, the authorization header), the most requests it held at once, and answers with what the test gives.

export type AgentReply = { status: number; body?: unknown; raw?: string; delayMs?: number } | 'hold';
export type AgentRequest = { authorization: string | undefined; body: unknown; path: string; method: string };

export type AgentStandIn = { url: string; received: AgentRequest[]; mostAtOnce: () => number };

export async function startAgentStandIn(t: TestContext, answer: (request: AgentRequest) => AgentReply): Promise<AgentStandIn> {
  const received: AgentRequest[] = [];
  const held: ServerResponse[] = [];
  let open = 0;
  let most = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        body = undefined;
      }
      const recorded = { authorization: request.headers.authorization, body, path: request.url ?? '', method: request.method ?? '' };
      received.push(recorded);
      open++;
      most = Math.max(most, open);
      const reply = answer(recorded);
      if (reply === 'hold') {
        held.push(response);
        return;
      }
      const send = (): void => {
        open--;
        if (response.destroyed) return;
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(reply.raw ?? JSON.stringify(reply.body));
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  t.after(() => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${address.port}`, received, mostAtOnce: () => most };
}

// --- Rewording, with the labelled stand-in rewriter (evaluation/test/stand-in-rewriter.sh, a test double) ----------
// What evaluation/reword.sh does, step by step, with the stand-in in place of the Codex adapter: each command line step
// through `command`, each round of calls through evaluation/judge/call-all.sh. Returns each step's exit code.

const CALL_ALL = new URL('../judge/call-all.sh', import.meta.url).pathname;
export const STAND_IN_REWRITER = new URL('./stand-in-rewriter.sh', import.meta.url).pathname;
const REWRITE_SCHEMA = new URL('../reword/rewrite.schema.json', import.meta.url).pathname;
const SAME_SCHEMA = new URL('../reword/same.schema.json', import.meta.url).pathname;

export async function rewordWithStandIn(
  paths: { sample: string; qa: string; pending: string; calls: string },
  command: (argv: string[]) => Promise<number>,
): Promise<{ prepare: number; checkPrepare: number; collect: number }> {
  const run = promisify(execFile);
  const env = { ...process.env, STAND_IN_CALLS: paths.calls };
  const flags = ['--sample', paths.sample, '--qa', paths.qa, '--pending', paths.pending];
  const prepare = await command(['reword-prepare', ...flags]);
  const { stdout } = await run(STAND_IN_REWRITER, ['--describe'], { env });
  await writeFile(join(paths.pending, 'describe.json'), stdout);
  await run(CALL_ALL, [join(paths.pending, 'rewrite'), STAND_IN_REWRITER, '4', '20', REWRITE_SCHEMA], { env });
  const checkPrepare = await command(['reword-check-prepare', ...flags]);
  await run(CALL_ALL, [join(paths.pending, 'check'), STAND_IN_REWRITER, '4', '20', SAME_SCHEMA], { env });
  const collect = await command(['reword-collect', ...flags]);
  return { prepare, checkPrepare, collect };
}

// The command line's input and output, collected.
export function io(overrides: Partial<{ now: () => Date; signIn: () => Promise<{ token: string; expiresAt: number }>; env: Record<string, string> }> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      fetch: globalThis.fetch,
      now: overrides.now ?? (() => new Date('2026-03-01T10:00:00.000Z')),
      log: (line: string) => out.push(line),
      warn: (line: string) => err.push(line),
      env: overrides.env ?? {},
      signIn: overrides.signIn ?? (() => Promise.resolve({ token: 'token-1', expiresAt: Date.parse('2026-03-01T10:10:00.000Z') })),
    },
  };
}
