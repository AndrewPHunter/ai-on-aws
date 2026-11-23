// The attack runner: plays the committed cases through the web client, each as the signed-in person it names, reads
// each run's trace as avery.auditor and the truth from the case system as riley.reviewer, judges each case (judge.ts)
// and writes one line per case to <run-dir>/results.jsonl. Started by evaluation/attacks.sh, inside the stack's network.
//
// It acts as a person only through ../../../platform/identity/src/desk.ts, as the stack gate does. It changes the
// stack: it enters about 60 inquiries and opens cases, so it is for a trial stack.
//
// Parts: `main` enters the victim's report, then plays every attack and control case and the sent-twice faults;
// `case-system` and `knowledge` play only the faults run while that service is stopped (attacks.sh stops and starts
// it). With the case system stopped the truth cannot be read, so those cases are judged on the responses alone.
//
// The record and the trace: the client returns a run to the person who started it without its steps. That run as the
// person received it is what the judge searches as the record. Once the run has ended, avery.auditor reads its trace,
// the run with the agent's whole response, steps included; the judge reads the response (its reply, outcome, steps,
// delegated responses and claims) from the trace. A case with a run that ended but whose trace could not be read is
// not run, and never judged on a response without its steps.
//
// The truth: the client's case list holds the 50 newest cases and no message ids, so the runner keeps every case id
// it has seen with its version, and after each case reads, as riley.reviewer, every case that is new, whose version
// rose, or that is no longer on the list; the cases with a version naming the inquiry's id are the case's truth.
//
// Standard output carries case ids, verdicts, counts and kinds; never the text of a message, a reply or a case.

import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readCase, readCaseList, readInquiry, readTrace, sendAgain, sendInquiry, signIn, signOut, waitForRun } from '../../../platform/identity/src/desk.ts';
import type { DeskAddresses, Reply, RunView } from '../../../platform/identity/src/desk.ts';
import type { Http } from '../../../platform/identity/src/provider.ts';
import { invocationResponseSchema } from '../../../shared/agent-contract.ts';
import type { CaseRecord, FoundCases } from '../../../shared/case-contract.ts';
import { judgeCase } from './judge.ts';
import type { CaseSeen, Judgment, Observed, RunSeen, VictimSeen } from './judge.ts';
import { exitCodeOf, formatTable } from './report.ts';
import type { Judged } from './report.ts';
import { PEOPLE, fillText, needsVictim, sendsOf } from './set.ts';
import type { AttackCase, CaseSet, Person } from './set.ts';

export const PARTS = ['main', 'case-system', 'knowledge'] as const;
export type RunPart = (typeof PARTS)[number];
export const isPart = (value: string): value is RunPart => (PARTS as readonly string[]).includes(value);

// How long a case's run is waited for at the client: longer than the client's 295 s for the orchestrator.
export const RUN_WAIT_MS = 300_000;
const HTTP: Http = { timeoutMs: 20_000 };
const POLL_MS = 500;
export const RESULTS_FILE = 'results.jsonl';

export type AttackRunOptions = {
  set: CaseSet;
  part: RunPart;
  addresses: DeskAddresses;
  passwords: Record<Person, string>;
  runDir: string;
  log: (line: string) => void;
  warn: (line: string) => void;
};

class CouldNotRun extends Error {}

const playsIn = (attack: AttackCase, part: RunPart): boolean =>
  part === 'main' ? attack.fault === undefined || attack.fault === 'sent-twice' : attack.fault === part;

const idOf = (value: unknown): string | null => {
  const id = (value as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id !== '' ? id : null;
};

/** A run as the judge sees it: `raw` is the run as the client returned it to the person, `response` the trace's. */
function seen(run: RunView | undefined, ended: boolean, traced: unknown): RunSeen {
  if (!ended || run === undefined) return { ended: false, state: run?.state ?? null, raw: run ?? null, response: null, outside_contract: false };
  const parsed = traced === null || traced === undefined ? null : invocationResponseSchema.safeParse(traced);
  return {
    ended: true,
    state: run.state ?? null,
    raw: run,
    response: parsed?.success === true ? parsed.data : null,
    outside_contract: parsed !== null && !parsed.success,
  };
}

// Why a case is not run when a run of it ended and its trace could not be read: a fixed sentence that quotes nothing.
const TRACE_NOT_READ = "a run that ended has no trace avery.auditor could read";
const traceNotRead = (): Judgment => ({ verdict: 'not_run', why: [TRACE_NOT_READ], expectations: [], failed: [], findings: [] });

const caseSeen = (record: CaseRecord): CaseSeen => ({
  case_id: record.case.case_id,
  status: record.case.status,
  elements: record.case.elements,
  versions: record.versions.map((v) => ({ version: v.version, message_id: v.message_id })),
});

export async function runAttacks(options: AttackRunOptions): Promise<number> {
  const { addresses, log, warn } = options;
  const resultsPath = join(options.runDir, RESULTS_FILE);
  try {
    await access(resultsPath);
    warn(`the run folder holds ${RESULTS_FILE} already: an attack run changes the stack and is made once, on a fresh stack, under a new name`);
    return 2;
  } catch {
    await mkdir(options.runDir, { recursive: true });
  }

  const sessions = new Map<Person, string>();
  const signInAs = async (person: Person): Promise<boolean> => {
    const result = await signIn(HTTP, addresses, person, options.passwords[person]);
    if (result.ok) sessions.set(person, result.session);
    else {
      sessions.delete(person);
      warn(`${person} could not sign in: ${result.why}`);
    }
    return result.ok;
  };
  // A request as the person. A 401 means the client ended the session (a failed refresh) and nothing was done:
  // the person signs in again once and the request is made once more.
  const asPerson = async (person: Person, request: (session: string) => Promise<Reply>): Promise<Reply | null> => {
    const session = sessions.get(person);
    if (session === undefined) return null;
    const reply = await request(session);
    if (reply.status !== 401) return reply;
    warn(`${person}'s session ended; signing in again`);
    const again = sessions.get(person) === session && (await signInAs(person));
    const next = sessions.get(person);
    return again && next !== undefined ? request(next) : reply;
  };

  for (const person of PEOPLE) await signInAs(person);
  try {
    if (!sessions.has('riley.reviewer')) throw new CouldNotRun('riley.reviewer could not sign in, so the truth cannot be read');
    const asRiley = (request: (session: string) => Promise<Reply>): Promise<Reply | null> => asPerson('riley.reviewer', request);

    // ---------- the truth ----------
    const known = new Map<string, number>();
    const startTruth = async (): Promise<void> => {
      const list = await asRiley((s) => readCaseList(HTTP, addresses, s));
      if (list?.status !== 200) throw new CouldNotRun(`riley.reviewer's case list answered status ${list?.status ?? 'none'}`);
      const found = list.body as Partial<FoundCases>;
      if (options.part === 'main' && found.truncated === true) throw new CouldNotRun('the stack holds more cases than the case list shows: an attack run is made on a fresh stack');
      for (const c of found.cases ?? []) known.set(c.case_id, c.version);
    };
    // The cases with a version naming the message, or null when a read was not answered 200 or more cases changed than the list shows.
    const casesFor = async (messageId: string): Promise<CaseSeen[] | null> => {
      const list = await asRiley((s) => readCaseList(HTTP, addresses, s));
      if (list?.status !== 200) return null;
      const found = list.body as Partial<FoundCases>;
      const listed = found.cases ?? [];
      if (found.truncated === true && known.size > 0 && !listed.some((c) => known.has(c.case_id))) return null;
      const listedIds = new Set(listed.map((c) => c.case_id));
      const toRead = [...listed.filter((c) => known.get(c.case_id) !== c.version).map((c) => c.case_id), ...[...known.keys()].filter((id) => !listedIds.has(id))];
      const mine: CaseSeen[] = [];
      for (const id of toRead) {
        const answer = await asRiley((s) => readCase(HTTP, addresses, s, id));
        if (answer?.status !== 200) return null;
        const record = answer.body as unknown as CaseRecord;
        if (known.get(id) === record.case.version) continue;
        known.set(id, record.case.version);
        if (record.versions.some((v) => v.message_id === messageId)) mine.push(caseSeen(record));
      }
      return mine;
    };
    const readVictim = async (caseId: string): Promise<VictimSeen | null> => {
      const answer = await asRiley((s) => readCase(HTTP, addresses, s, caseId));
      if (answer?.status !== 200) return null;
      const record = answer.body as unknown as CaseRecord;
      return { status: record.case.status, versions: record.versions.map((v) => ({ version: v.version, message_id: v.message_id })) };
    };
    const truthReadable = options.part !== 'case-system';
    if (truthReadable) await startTruth();

    // ---------- the victim ----------
    let victimCase: string | null = null;
    if (options.part === 'main') {
      const { victim } = options.set;
      const sent = await asPerson(victim.person, (s) => sendInquiry(HTTP, addresses, s, { sender: victim.sender, text: victim.text, agent_id: victim.target }));
      const inquiry = sent?.status === 202 ? idOf(sent.body.inquiry) : null;
      const session = sessions.get(victim.person);
      if (inquiry !== null && session !== undefined) {
        const waited = await waitForRun(HTTP, addresses, session, inquiry, RUN_WAIT_MS);
        const cases = await casesFor(inquiry);
        if (cases?.length === 1) victimCase = cases[0]?.case_id ?? null;
        await writeFile(join(options.runDir, 'victim.json'), `${JSON.stringify({ inquiry, case_id: victimCase, run: waited.ended ? waited.run : waited.lastRead })}\n`);
      }
      if (victimCase === null) warn("the victim's report did not open exactly one case: the cases that need it are not run");
      else log(`victim: case ${victimCase}`);
    }

    // ---------- the cases ----------
    const waitForRunId = async (session: string, inquiry: string, runId: string): Promise<{ ended: boolean; run: RunView | undefined }> => {
      let run: RunView | undefined;
      const deadline = Date.now() + RUN_WAIT_MS;
      while (Date.now() < deadline) {
        const read = (await readInquiry(HTTP, addresses, session, inquiry)).body.inquiry as { runs?: (RunView & { id?: string })[] } | undefined;
        run = read?.runs?.find((r) => r.id === runId);
        if (run !== undefined && run.state !== 'running') return { ended: true, run };
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return { ended: false, run };
    };

    // The run's trace as avery.auditor read it: the trace whole, as the client returned it, or null when it was not
    // answered 200 with a trace of that run.
    const traceOf = async (runId: string | undefined): Promise<{ trace: { run?: RunView } } | null> => {
      if (runId === undefined) return null;
      const reply = await asPerson('avery.auditor', (s) => readTrace(HTTP, addresses, s, runId));
      const trace = reply?.status === 200 ? (reply.body.trace as { run?: RunView } | undefined) : undefined;
      return trace?.run?.id === runId ? { trace } : null;
    };

    type Played = { observed: Observed; clientRuns: (RunView | undefined)[]; traces: unknown[]; traceUnread: boolean };
    const play = async (attack: AttackCase): Promise<Played> => {
      const observed: Observed = { signed_in: sessions.has(attack.person), accepted: [], victim_case: victimCase, message_id: null, runs: [], truth: null };
      const played: Played = { observed, clientRuns: [], traces: [], traceUnread: false };
      // Each run as the person received it, and, once it has ended, its trace.
      const keep = async (run: RunView | undefined, ended: boolean, runId: string | undefined): Promise<void> => {
        const read = ended && run !== undefined ? await traceOf(runId) : null;
        if (ended && run !== undefined && read === null) played.traceUnread = true;
        played.clientRuns.push(run);
        played.traces.push(read?.trace ?? null);
        observed.runs.push(seen(run, ended, read?.trace.run?.response));
      };
      if (!observed.signed_in || (needsVictim(attack) && victimCase === null)) return played;
      const victimBefore = truthReadable && victimCase !== null && needsVictim(attack) ? await readVictim(victimCase) : null;
      const text = fillText(attack, victimCase);
      const sent = await asPerson(attack.person, (s) => sendInquiry(HTTP, addresses, s, { sender: attack.sender, text, agent_id: attack.target }));
      observed.signed_in = sessions.has(attack.person);
      observed.accepted.push(sent?.status === 202);
      const inquiry = sent?.status === 202 ? idOf(sent.body.inquiry) : null;
      const session = sessions.get(attack.person);
      if (inquiry === null || session === undefined) return played;
      observed.message_id = inquiry;
      const first = await waitForRun(HTTP, addresses, session, inquiry, RUN_WAIT_MS);
      const firstRun = first.ended ? first.run : first.lastRead;
      await keep(firstRun, first.ended, firstRun?.id);
      if (sendsOf(attack) === 2) {
        const again = await asPerson(attack.person, (s) => sendAgain(HTTP, addresses, s, inquiry, attack.target));
        observed.accepted.push(again?.status === 202);
        const runId = again?.status === 202 ? idOf(again.body.run) : null;
        const now = sessions.get(attack.person);
        if (runId !== null && now !== undefined) {
          const second = await waitForRunId(now, inquiry, runId);
          await keep(second.run, second.ended, runId);
        }
      }
      if (truthReadable) {
        const cases = await casesFor(inquiry);
        const victimAfter = victimBefore === null || victimCase === null ? null : await readVictim(victimCase);
        observed.truth = cases === null ? null : { cases, victim_before: victimBefore, victim_after: victimAfter };
      }
      return played;
    };

    const judged: Judged[] = [];
    for (const attack of options.set.cases.filter((c) => playsIn(c, options.part))) {
      const { observed, clientRuns, traces, traceUnread } = await play(attack);
      const judgment = traceUnread ? traceNotRead() : judgeCase(attack, observed);
      const line = {
        id: attack.id,
        class: attack.class,
        target: attack.target,
        person: attack.person,
        decided_by: attack.decided_by,
        verdict: judgment.verdict,
        failed: judgment.failed,
        why: judgment.why,
        findings: judgment.findings,
        expectations: judgment.expectations,
        observed,
        client_runs: clientRuns.map((run) => ({ state: run?.state ?? null, error: run?.error ?? null })),
        // Each run's trace as avery.auditor read it, steps included, or null when it was not read.
        traces,
      };
      await appendFile(resultsPath, `${JSON.stringify(line)}\n`);
      log(`${attack.id}: ${judgment.verdict}`);
      judged.push({ attack, judgment });
    }
    for (const line of formatTable(judged)) log(line);
    return exitCodeOf(judged);
  } catch (error) {
    if (!(error instanceof CouldNotRun)) throw error;
    warn(error.message);
    return 2;
  } finally {
    // A failed sign-out is said, and never changes the result.
    for (const [person, session] of sessions) {
      try {
        const out = await signOut(HTTP, addresses, session);
        if (out.status !== 200) warn(`${person}: signing out answered status ${out.status}`);
      } catch (error) {
        warn(`${person}: signing out failed (${error instanceof Error ? error.name : 'error'})`);
      }
    }
  }
}
