// The committed set of attack, control and fault cases (evaluation/attacks/cases.json), and its reader.
//
// The reader is pure: it is given the file's text and returns the set, or throws an InputError that names every
// problem by case id and rule, quoting no message. "Well formed" is invariant 14 of docs/architecture/evaluation.md:
// every case keeps to the schema below; ids are unique; every attack names a control that is a control case for the
// same target, so every attack class has a control for each of its targets; every placeholder in a message is one
// the runner fills; no word an "absent" expectation of the record looks for is in the case's own message; and the
// victim's words are in no case.

import { z } from 'zod';

import { LABEL_ANSWERS } from '../../../shared/agent-contract.ts';
import { ELEMENTS } from '../../../shared/case-contract.ts';
import { InputError } from '../benchmark.ts';

export const ATTACK_CLASSES = ['suppress', 'plant', 'work', 'false-label', 'other-case', 'authority', 'read-as-sender', 'advice'] as const;
export const CLASSES = [...ATTACK_CLASSES, 'control', 'fault'] as const;
export const TARGETS = ['intake-strands', 'intake-handwritten', 'expert', 'orchestrator'] as const;
// Who sends a case. riley.reviewer reads the truth; avery.auditor is signed in and out and sends nothing.
export const SENDERS = ['dana.desk', 'morgan.medinfo'] as const;
export const PEOPLE = ['dana.desk', 'morgan.medinfo', 'riley.reviewer', 'avery.auditor'] as const;
export const OUTCOMES = ['completed', 'stopped', 'failed'] as const;
// What a fault case does: which service of the stack is stopped while it is played, or that it is sent twice.
export const FAULTS = ['case-system', 'knowledge', 'sent-twice'] as const;
// The one placeholder the runner fills: the victim's case id, found after the victim's report is entered.
export const VICTIM_CASE = '{victim_case}';
export const PLACEHOLDERS = [VICTIM_CASE] as const;

export type AttackClass = (typeof ATTACK_CLASSES)[number];
export type CaseClass = (typeof CLASSES)[number];
export type Target = (typeof TARGETS)[number];
export type Person = (typeof PEOPLE)[number];
export type Fault = (typeof FAULTS)[number];
export type Decider = 'code' | 'model';

const decider = z.enum(['code', 'model']);
const words = z.array(z.string().min(1)).min(1);
// An expectation's decider when it differs from the case's, as for the two scopes of `work`.
const own = { decided_by: decider.optional() };

export const expectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('case_exists'), ...own }).strict(),
  z.object({ kind: z.literal('no_case'), ...own }).strict(),
  z.object({ kind: z.literal('case_field'), element: z.enum(ELEMENTS), words, present: z.boolean(), ...own }).strict(),
  z.object({ kind: z.literal('victim_unchanged'), ...own }).strict(),
  z.object({ kind: z.literal('follow_up_on_victim'), ...own }).strict(),
  z.object({ kind: z.literal('absent'), scope: z.enum(['reply', 'record']), words, ...own }).strict(),
  z.object({ kind: z.literal('no_dose'), ...own }).strict(),
  z.object({ kind: z.literal('answered_with_citations'), ...own }).strict(),
  z.object({ kind: z.literal('outcome'), outcomes: z.array(z.enum(OUTCOMES)).min(1), ...own }).strict(),
  z.object({ kind: z.literal('claims_no_case'), ...own }).strict(),
  z.object({ kind: z.literal('claims_no_answer'), ...own }).strict(),
]);
export type Expectation = z.infer<typeof expectationSchema>;
export type ExpectationKind = Expectation['kind'];

export const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    class: z.enum(CLASSES),
    target: z.enum(TARGETS),
    person: z.enum(SENDERS),
    sender: z.string().min(1),
    text: z.string().min(1),
    decided_by: decider,
    // How far the run must get for the case to mean anything: the client's run finished (always), its outcome is
    // one of these, and, when named, the label answer (through the orchestrator, a delegated expert's) is one of these.
    precondition: z.object({ outcomes: z.array(z.enum(OUTCOMES)).min(1), label_answers: z.array(z.enum(LABEL_ANSWERS)).min(1).optional() }).strict(),
    expectations: z.array(expectationSchema).min(1),
    // For an attack: the id of its control.
    control: z.string().optional(),
    // For a fault: the service stopped while it is played, or that it is sent twice.
    fault: z.enum(FAULTS).optional(),
  })
  .strict();
export type AttackCase = z.infer<typeof caseSchema>;

const victimSchema = z
  .object({
    // The victim's report is entered first, as dana.desk through intake-strands.
    person: z.literal('dana.desk'),
    target: z.literal('intake-strands'),
    sender: z.string().min(1),
    text: z.string().min(1),
    // Words of the victim's patient and event found nowhere else in the set.
    words: z.array(z.string().min(1)).min(2),
  })
  .strict();
export type Victim = z.infer<typeof victimSchema>;

const setSchema = z.object({ victim: victimSchema, cases: z.array(caseSchema).min(1) }).strict();
export type CaseSet = z.infer<typeof setSchema>;

const isAttack = (value: CaseClass): value is AttackClass => (ATTACK_CLASSES as readonly string[]).includes(value);

/** The decider of one expectation of a case: its own, or the case's. */
export const deciderOf = (attack: AttackCase, expectation: Expectation): Decider => expectation.decided_by ?? attack.decided_by;

/** Whether a case needs the victim's case to exist: it names it, or expects something of it. */
export const needsVictim = (attack: AttackCase): boolean =>
  attack.text.includes(VICTIM_CASE) || attack.expectations.some((e) => e.kind === 'victim_unchanged' || e.kind === 'follow_up_on_victim');

/** How many times a case's message is sent. */
export const sendsOf = (attack: AttackCase): number => (attack.fault === 'sent-twice' ? 2 : 1);

/** A case's message with its placeholder filled. */
export const fillText = (attack: AttackCase, victimCase: string | null): string => attack.text.split(VICTIM_CASE).join(victimCase ?? VICTIM_CASE);

/** Whether `word` stands in `text` as a whole: ignoring case, with no letter or digit next to it. */
export function holdsWord(text: string, word: string): boolean {
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1] ?? ' ';
    const after = haystack[at + needle.length] ?? ' ';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/** The set's problems beyond its schema, each naming the case and the rule. */
function problemsOf(set: CaseSet): string[] {
  const problems: string[] = [];
  const byId = new Map<string, AttackCase>();
  for (const attack of set.cases) {
    if (byId.has(attack.id)) problems.push(`${attack.id}: the id is used twice`);
    byId.set(attack.id, attack);
  }
  for (const attack of set.cases) {
    const where = attack.id;
    // Each attack's own control, for its target: so every attack class has a control for each of its targets.
    if (isAttack(attack.class)) {
      const control = attack.control === undefined ? undefined : byId.get(attack.control);
      if (control === undefined) problems.push(`${where}: an attack names no control, or one that is not in the set`);
      else if (control.class !== 'control' || control.target !== attack.target) problems.push(`${where}: its control is not a control case for the same target`);
    } else if (attack.control !== undefined) problems.push(`${where}: only an attack names a control`);
    if ((attack.class === 'fault') !== (attack.fault !== undefined)) problems.push(`${where}: a fault case, and only a fault case, says what is stopped or sent twice`);
    for (const placeholder of `${attack.sender} ${attack.text}`.match(/\{[^}]*\}/g) ?? []) {
      if (!(PLACEHOLDERS as readonly string[]).includes(placeholder)) problems.push(`${where}: a placeholder the runner does not fill`);
    }
    if (attack.sender.includes(VICTIM_CASE)) problems.push(`${where}: a placeholder in the sender`);
    for (const expectation of attack.expectations) {
      // The record carries the message itself (an orchestrator's delegation step holds it), so such a word could never be absent.
      if (expectation.kind === 'absent' && expectation.scope === 'record' && expectation.words.some((word) => holdsWord(attack.text, word))) {
        problems.push(`${where}: a word an absent expectation of the record looks for is in the case's own message`);
      }
    }
    if (set.victim.words.some((word) => holdsWord(`${attack.sender} ${attack.text}`, word))) problems.push(`${where}: holds one of the victim's words`);
  }
  for (const word of set.victim.words) {
    if (!holdsWord(set.victim.text, word)) problems.push(`victim: a victim's word is not in the victim's report`);
  }
  return problems;
}

/** Reads the set from the file's text, or throws an InputError naming every problem. */
export function readCaseSet(text: string): CaseSet {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError('evaluation/attacks/cases.json is not JSON');
  }
  const parsed = setSchema.safeParse(value);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`);
    throw new InputError(`evaluation/attacks/cases.json does not keep to the schema: ${where.join('; ')}`);
  }
  const problems = problemsOf(parsed.data);
  if (problems.length > 0) throw new InputError(`evaluation/attacks/cases.json is not well formed: ${problems.join('; ')}`);
  return parsed.data;
}
