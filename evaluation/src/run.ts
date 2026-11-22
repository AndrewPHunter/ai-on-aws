// The runner: each sampled question, sent to an agent exactly as a client sends it (POST /invocations, the agent
// contract's request, a real bearer token), at most 4 at once. Every response is stored whole with its status, its
// duration and the time, in responses.jsonl. A failed call is recorded once with its reason and is not sent again
// unless the operator asks. A question already answered is never sent again. If the responses of one run report more
// than one search strategy, the run stops.

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { Question } from './benchmark.ts';
import { InputError } from './benchmark.ts';
import type { Variant } from './variant.ts';

export const CONCURRENCY = 4;
// The client waits 180 s for an agent; the runner waits a little longer, so an agent's own ending is what it records.
export const CALL_TIMEOUT_MS = 185_000;

// One call, as recorded. `response` is the parsed body whenever the body is JSON; `body` is the raw text when it is
// not. `ok` is true only for status 200 with a body that keeps to the agent contract.
export type CallRecord = {
  qid: string;
  sent_at: string;
  duration_ms: number;
  status: number | null;
  ok: boolean;
  reason: string | null;
  response: unknown;
  body: string | null;
};

export type RunFile = {
  // The variant of the sample the run was made on, and the SHA-256 of that variant's file. A run file from before
  // variants existed has no variant: it is a run on the original sample.
  variant?: Variant;
  sample_sha256: string;
  agent_id: string | null;
  models: string[];
  strategies: string[];
  started_at: string;
  ended_at: string | null;
};

export type RunOptions = {
  questions: readonly Question[];
  variant: Variant;
  sampleSha256: string;
  runDir: string;
  agentUrl: string;
  token: () => Promise<string>;
  retryFailed: boolean;
  now: () => Date;
  fetch: typeof fetch;
  callTimeoutMs?: number;
  concurrency?: number;
  log: (line: string) => void;
};

export type RunResult = { exitCode: 0 | 1 | 2; sent: number; failures: number };

export const RESPONSES = 'responses.jsonl';
export const RUN_FILE = 'run.json';

// Every record in a run's responses file, in order. The last record of a qid is the one that counts.
export async function readRecords(runDir: string): Promise<CallRecord[]> {
  let text: string;
  try {
    text = await readFile(join(runDir, RESPONSES), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new InputError(`${RESPONSES} could not be read`);
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, at) => {
      try {
        return JSON.parse(line) as CallRecord;
      } catch {
        throw new InputError(`${RESPONSES} line ${at + 1} is not JSON`);
      }
    });
}

export function latestByQid(records: readonly CallRecord[]): Map<string, CallRecord> {
  const latest = new Map<string, CallRecord>();
  for (const record of records) latest.set(record.qid, record);
  return latest;
}

// The strategies the retrieval steps of a response report, and the models its model steps name.
export function reported(response: InvocationResponse): { strategies: string[]; models: string[] } {
  const strategies = new Set<string>();
  const models = new Set<string>();
  for (const step of response.steps) {
    if (step.kind === 'retrieval') strategies.add(step.strategy);
    if (step.kind === 'model') models.add(step.model);
  }
  return { strategies: [...strategies], models: [...models] };
}

async function readRunFile(runDir: string): Promise<RunFile | null> {
  try {
    return JSON.parse(await readFile(join(runDir, RUN_FILE), 'utf8')) as RunFile;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new InputError(`${RUN_FILE} could not be read`);
  }
}

// One call: never throws. Each way it can fail is a record with its reason.
async function callOnce(options: RunOptions, question: Question): Promise<CallRecord> {
  const timeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const sentAt = options.now();
  const started = performance.now();
  const record = (fields: Partial<CallRecord>): CallRecord => ({
    qid: question.qid,
    sent_at: sentAt.toISOString(),
    duration_ms: Math.round(performance.now() - started),
    status: null,
    ok: false,
    reason: null,
    response: null,
    body: null,
    ...fields,
  });
  let token: string;
  try {
    token = await options.token();
  } catch {
    return record({ reason: 'no access token could be got' });
  }
  // The agent contract's request: the message's id, receipt time, sender and text. The id is the question's qid, so
  // each question is its own message.
  const body = JSON.stringify({ message: { id: `eval-${question.qid}`, received_at: sentAt.toISOString(), sender: 'evaluation harness', text: question.question } });
  let response: Response;
  let text: string;
  try {
    response = await options.fetch(`${options.agentUrl}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return record({ reason: timedOut ? `no answer within ${timeoutMs / 1000} s` : 'the connection failed' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return record({ status: response.status, reason: response.status === 200 ? 'the body is not JSON' : `status ${response.status}`, body: text });
  }
  if (response.status !== 200) return record({ status: response.status, reason: `status ${response.status}`, response: parsed });
  if (!invocationResponseSchema.safeParse(parsed).success) return record({ status: 200, reason: 'the answer is outside the agent contract', response: parsed });
  return record({ status: 200, ok: true, response: parsed });
}

export async function runQuestions(options: RunOptions): Promise<RunResult> {
  const previous = await readRecords(options.runDir);
  const prior = await readRunFile(options.runDir);
  if (prior !== null && (prior.variant ?? 'original') !== options.variant) {
    options.log(`could not run: this run was made on the ${prior.variant ?? 'original'} sample, not the ${options.variant} one`);
    return { exitCode: 2, sent: 0, failures: 0 };
  }
  if (prior !== null && prior.sample_sha256 !== options.sampleSha256) {
    options.log(`could not run: this run was made with another sample`);
    return { exitCode: 2, sent: 0, failures: 0 };
  }
  const latest = latestByQid(previous);
  const strategies = new Set(prior?.strategies ?? []);
  const models = new Set(prior?.models ?? []);
  let agentId = prior?.agent_id ?? null;
  const run: RunFile = {
    variant: options.variant,
    sample_sha256: options.sampleSha256,
    agent_id: agentId,
    models: [],
    strategies: [],
    started_at: prior?.started_at ?? options.now().toISOString(),
    ended_at: null,
  };

  const todo = options.questions.filter((question) => {
    const last = latest.get(question.qid);
    return last === undefined || (!last.ok && options.retryFailed);
  });
  options.log(`questions: ${options.questions.length}; to send: ${todo.length}`);

  let stopped: string | null = null;
  let sent = 0;
  let writing = Promise.resolve();
  const append = (record: CallRecord): Promise<void> => {
    writing = writing.then(() => appendFile(join(options.runDir, RESPONSES), `${JSON.stringify(record)}\n`));
    return writing;
  };

  const queue = [...todo];
  const worker = async (): Promise<void> => {
    for (let question = queue.shift(); question !== undefined && stopped === null; question = queue.shift()) {
      const record = await callOnce(options, question);
      sent++;
      latest.set(record.qid, record);
      await append(record);
      if (record.ok) {
        const response = record.response as InvocationResponse;
        agentId ??= response.agent.id;
        const found = reported(response);
        for (const model of found.models) models.add(model);
        for (const strategy of found.strategies) strategies.add(strategy);
        if (strategies.size > 1) stopped = `the responses report more than one strategy: ${[...strategies].sort().join(', ')}`;
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? CONCURRENCY }, () => worker()));
  await writing;

  run.agent_id = agentId;
  run.models = [...models].sort();
  run.strategies = [...strategies].sort();
  run.ended_at = options.now().toISOString();
  await writeFile(join(options.runDir, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);

  const failures = options.questions.filter((question) => latest.get(question.qid)?.ok !== true).length;
  if (stopped !== null) {
    options.log(`stopped: ${stopped}`);
    return { exitCode: 2, sent, failures };
  }
  options.log(`sent: ${sent}; questions with a response: ${options.questions.length - failures}; failures: ${failures}`);
  return { exitCode: failures === 0 ? 0 : 1, sent, failures };
}
