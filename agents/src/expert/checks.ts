// What code checks about the model's final answer, as pure functions over what the run has shown the model.
// Nothing here calls anything or reads a clock: the same answer and the same passages always give the same
// verdict.
//
// A statement is accepted only when, in this order:
//   1. its text is not empty, it cites at least one passage, and every passage it cites was shown to the model;
//   2. its quote is 15 to 600 characters and is found in one cited passage, after footnote marks are removed,
//      white space is collapsed and case is ignored;
//   3. every number in its text is a number in a cited passage;
//   4. every unit written directly after one of those numbers is in a cited passage.
// Only the passage's text is compared, never its handle, its label's names or its section path.

import type { AnswerSettings } from './settings.ts';

// ---------- Text as compared ----------

const FOOTNOTE_MARK = /\[\^[^\]]*\]/g;

export function withoutFootnoteMarks(text: string): string {
  return text.replace(FOOTNOTE_MARK, '');
}

// A text as a quote is compared: footnote marks removed, each run of white space one space, lower case.
export function quoteForm(text: string): string {
  return withoutFootnoteMarks(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function quoteFoundIn(quote: string, passageText: string): boolean {
  const wanted = quoteForm(quote);
  return wanted !== '' && quoteForm(passageText).includes(wanted);
}

// A text as its numbers are read: footnote marks removed, then ^{x} and _{x} written as x, then thousands
// separators removed. So 10^{6} reads as 106, on both sides alike.
export function numberForm(text: string): string {
  return withoutFootnoteMarks(text)
    .replace(/\^\{([^}]*)\}/g, '$1')
    .replace(/_\{([^}]*)\}/g, '$1')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
}

const NUMBER = /\d+(?:\.\d+)?/g;

// Every number in a text: a run of digits with an optional decimal part, as written.
export function numbersIn(text: string): string[] {
  return numberForm(text).match(NUMBER) ?? [];
}

// The closed list of units. Each is matched without regard to case, and µ (micro sign) and μ (Greek mu) are
// the same letter.
const UNITS = ['mcg', 'μg', 'mg', 'kg', 'g', 'ml', 'l', '%', 'iu', 'units', 'unit', 'meq', 'mmol'] as const;
type Unit = (typeof UNITS)[number];

function unitForm(text: string): string {
  return text.replace(/µ/g, 'μ').toLowerCase();
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNIT_AFTER_NUMBER = new RegExp(`(\\d+(?:\\.\\d+)?) ?(${UNITS.map(escaped).join('|')})(?!\\p{L})`, 'gu');

// Each number in a text written directly after by a unit from the list (one space between is allowed).
export function numbersWithUnits(text: string): Array<{ number: string; unit: Unit }> {
  const found: Array<{ number: string; unit: Unit }> = [];
  for (const match of unitForm(numberForm(text)).matchAll(UNIT_AFTER_NUMBER)) {
    const unit = UNITS.find((candidate) => candidate === match[2]);
    const number = match[1];
    if (unit !== undefined && number !== undefined) found.push({ number, unit });
  }
  return found;
}

// Whether a unit is anywhere in a passage, as a unit and not as part of a word. "%" is also found as "percent";
// "unit" and "units" find each other.
export function unitIn(unit: Unit, passageText: string): boolean {
  const text = unitForm(passageText);
  if (unit === '%') return text.includes('%') || /(?<!\p{L})percent(?!\p{L})/u.test(text);
  const spelled = unit === 'unit' || unit === 'units' ? 'units?' : escaped(unit);
  return new RegExp(`(?<!\\p{L})${spelled}(?!\\p{L})`, 'u').test(text);
}

// ---------- The answer ----------

// A passage the model has been shown, and what a citation of it carries.
export type ShownPassage = {
  handle: string;
  passageId: string;
  text: string;
  names: string[];
  section: string;
  setId: string;
  version: number;
  effectiveDate: string;
  source: string;
};

export type CheckedStatement = { text: string; quote: string; foundIn: ShownPassage };

export type AnswerVerdict = { accepted: true; statements: CheckedStatement[] } | { accepted: false; problems: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(items: readonly string[]): string {
  return items.join(', ');
}

// Checks one call of `answer` against the passages shown in this run (by handle). Every problem is returned,
// each naming its statement, so the model can be told all of them at once.
export function checkAnswer(input: unknown, shown: ReadonlyMap<string, ShownPassage>, settings: AnswerSettings): AnswerVerdict {
  const statements = isRecord(input) ? input['statements'] : undefined;
  if (!Array.isArray(statements)) {
    return { accepted: false, problems: ['The answer has no list of statements: give "statements" as a list.'] };
  }
  if (statements.length === 0) {
    return { accepted: false, problems: ['The answer has no statements.'] };
  }
  const problems: string[] = [];
  if (statements.length > settings.maxStatements) {
    problems.push(`The answer has ${statements.length} statements; at most ${settings.maxStatements} are allowed.`);
  }

  const checked: CheckedStatement[] = [];
  statements.forEach((statement: unknown, index) => {
    const label = `Statement ${index + 1}`;
    const text = isRecord(statement) ? statement['text'] : undefined;
    const cited = isRecord(statement) ? statement['passages'] : undefined;
    const quote = isRecord(statement) ? statement['quote'] : undefined;
    if (typeof text !== 'string' || !Array.isArray(cited) || !cited.every((h): h is string => typeof h === 'string') || typeof quote !== 'string') {
      problems.push(`${label}: give "text" as words, "passages" as a list of passage handles such as P1, and "quote" as words.`);
      return;
    }

    // 1. Text, citations, and that every citation is a passage shown.
    const own: string[] = [];
    if (text.trim() === '') own.push('its text is empty');
    if (cited.length === 0) own.push('it cites no passage');
    const unknown = cited.filter((handle) => !shown.has(handle));
    if (unknown.length > 0) own.push(`it cites ${list(unknown)}, which ${unknown.length === 1 ? 'is not a passage' : 'are not passages'} shown to you`);
    if (own.length > 0) {
      problems.push(`${label}: ${own.join('; ')}.`);
      return;
    }
    const passages = cited.map((handle) => shown.get(handle)).filter((p): p is ShownPassage => p !== undefined);

    // 2. The quote.
    const length = quote.length;
    let foundIn: ShownPassage | undefined;
    let quoteProblem: string | undefined;
    if (length < settings.quoteMinCharacters || length > settings.quoteMaxCharacters) {
      quoteProblem = `its quote is ${length} characters; a quote must be ${settings.quoteMinCharacters} to ${settings.quoteMaxCharacters}.`;
    } else {
      foundIn = passages.find((passage) => quoteFoundIn(quote, passage.text));
      if (foundIn === undefined) quoteProblem = whereTheQuoteFails(quote, passages, shown, cited);
    }

    // 3. Numbers.
    const passageNumbers = new Set(passages.flatMap((passage) => numbersIn(passage.text)));
    const missing = [...new Set(numbersIn(text).filter((number) => !passageNumbers.has(number)))];
    if (missing.length > 0) own.push(`${list(missing)} ${missing.length === 1 ? 'is' : 'are'} not written in ${list(cited)}`);

    // 4. Units.
    const missingUnits = [
      ...new Set(numbersWithUnits(text).filter(({ unit }) => !passages.some((passage) => unitIn(unit, passage.text))).map(({ unit }) => unit)),
    ];
    if (missingUnits.length > 0) own.push(`the unit ${list(missingUnits)} is not written in ${list(cited)}`);

    if (quoteProblem !== undefined) problems.push(`${label}: ${quoteProblem}`);
    if (own.length > 0) problems.push(`${label}: ${own.join('; ')}.`);
    if (quoteProblem !== undefined || own.length > 0 || foundIn === undefined) return;
    checked.push({ text: text.trim(), quote, foundIn });
  });

  return problems.length === 0 ? { accepted: true, statements: checked } : { accepted: false, problems };
}

// What the model is told after the problems with an answer, whatever they were.
export const ANSWER_CORRECTION_CLOSING =
  'Send the whole answer again, by calling answer, with these corrected. A statement that cannot be supported from the passages shown may be left out.';

// The most words a correction quotes back of where a quote stops matching.
const MATCHED_WORDS_TOLD = 12;

// How many of a quote's words, from its first, are in a passage, compared as a quote is (and whole words only).
function wordsMatching(quoteWords: readonly string[], passageText: string): number {
  const passage = quoteForm(passageText);
  const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[\p{L}\p{N}]/u.test(character);
  const found = (span: string): boolean => {
    for (let at = passage.indexOf(span); at !== -1; at = passage.indexOf(span, at + 1)) {
      if (!isWordCharacter(passage[at - 1]) && !isWordCharacter(passage[at + span.length])) return true;
    }
    return false;
  };
  for (let count = quoteWords.length; count > 0; count--) {
    if (found(quoteWords.slice(0, count).join(' '))) return count;
  }
  return 0;
}

// Why a quote of the right length was not accepted, said so that the next answer can be different. Nothing of a
// passage's text is put in the message: only the model's own quote words that matched, and handles.
function whereTheQuoteFails(
  quote: string,
  cited: readonly ShownPassage[],
  shown: ReadonlyMap<string, ShownPassage>,
  citedHandles: readonly string[],
): string {
  const elsewhere = [...shown.values()].filter((passage) => !citedHandles.includes(passage.handle) && quoteFoundIn(quote, passage.text));
  if (elsewhere.length > 0) {
    const handles = list(elsewhere.map((passage) => passage.handle));
    return `its quote is in ${handles}, which the statement does not cite. Cite ${handles} as well, or quote from a passage it cites.`;
  }
  // The quote's own words as written, with footnote marks removed and white space collapsed: the same words, in
  // the same number, as the form it is compared in.
  const written = withoutFootnoteMarks(quote).replace(/\s+/g, ' ').trim().split(' ');
  const compared = quoteForm(quote).split(' ');
  let best: { passage: ShownPassage; words: number } | undefined;
  for (const passage of cited) {
    const words = wordsMatching(compared, passage.text);
    if (best === undefined || words > best.words) best = { passage, words };
  }
  const gap = /\.\.\.|…/.test(quote) ? ' A quote is one continuous span: nothing left out and no "...".' : '';
  if (best === undefined || best.words === 0) {
    const where = cited.length === 1 ? 'that passage' : 'any of them';
    return `its quote is not in ${list(citedHandles)} word for word. Its first words are not in ${where}.${gap}`;
  }
  const matched = written.slice(Math.max(0, best.words - MATCHED_WORDS_TOLD), best.words).join(' ');
  return `its quote is not in ${best.passage.handle} word for word. It matches as far as "${matched}" and then the passage differs.${gap}`;
}

// ---------- cannot_answer ----------

export const CANNOT_ANSWER_REASONS = ['no_label', 'label_does_not_answer', 'not_a_label_question'] as const;
export type CannotAnswerReason = (typeof CANNOT_ANSWER_REASONS)[number];

// What the run knows that decides whether a reason is accepted. Only calls the retrieval service answered count.
export type RetrievalHistory = {
  // Each find_labels call answered, with how many labels it returned.
  finds: Array<{ labels: number }>;
  // Each label a search was answered for, once, in the order first searched.
  searched: Array<{ names: string[]; version: number; effectiveDate: string }>;
};

export type CannotAnswerVerdict = { accepted: true; reason: CannotAnswerReason; reply: string } | { accepted: false; problem: string };

function dated(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : yyyymmdd;
}

export function checkCannotAnswer(input: unknown, history: RetrievalHistory): CannotAnswerVerdict {
  const given = isRecord(input) ? input['reason'] : undefined;
  const reason = CANNOT_ANSWER_REASONS.find((candidate) => candidate === given);
  if (reason === undefined) {
    return { accepted: false, problem: `The reason must be one of ${CANNOT_ANSWER_REASONS.join(', ')}.` };
  }

  if (reason === 'not_a_label_question') {
    return { accepted: true, reason, reply: 'The message does not ask what a drug label says, so it was not answered from the labels.' };
  }

  if (reason === 'no_label') {
    if (history.finds.length === 0) {
      return { accepted: false, problem: 'Reason "no_label" needs find_labels to have been called in this run. Call find_labels first.' };
    }
    if (history.finds.some((find) => find.labels > 0)) {
      return { accepted: false, problem: 'Reason "no_label" is not accepted: find_labels returned a label in this run. Search that label.' };
    }
    // The name searched is not repeated here: the model wrote it, and a message can steer what the model writes.
    // It is in the find_labels tool step.
    return {
      accepted: true,
      reason,
      reply: 'No approved label was found for the drug named in the message, so the question cannot be answered from a label.',
    };
  }

  if (history.searched.length === 0) {
    return { accepted: false, problem: 'Reason "label_does_not_answer" needs at least one search of a label in this run. Call search_label first.' };
  }
  const labels = history.searched.map((label) => `${label.names.join(', ')} (version ${label.version}, dated ${dated(label.effectiveDate)})`);
  return {
    accepted: true,
    reason,
    reply:
      labels.length === 1
        ? `The label searched, ${labels[0] ?? ''}, does not answer this question.`
        : `The labels searched, ${labels.join('; ')}, do not answer this question.`,
  };
}

// ---------- The reply ----------

// The reply for an accepted answer: each statement as a paragraph, followed by the number of its citation.
export function replyFor(statements: readonly CheckedStatement[]): string {
  return statements.map((statement, index) => `${statement.text} [${index + 1}]`).join('\n\n');
}

// A reply as replyFor writes it, with the citation number at the end of each paragraph moved on by `by`, for a
// reply placed after others whose citations come first in one list. Nothing else in the reply changes.
export function withCitationsMovedBy(reply: string, by: number): string {
  return reply
    .split('\n\n')
    .map((paragraph) => paragraph.replace(/ \[(\d+)\]$/, (_whole, number: string) => ` [${Number(number) + by}]`))
    .join('\n\n');
}
