// The parser's invariants ("Always true" 16 to 23 in docs/architecture/knowledge.md), one test each, on synthetic
// labels in memory, and through the parse command where the invariant is about the files it writes.

import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkConservation } from '../src/parse/conserve.ts';
import type { Paragraph, Table } from '../src/parse/model.ts';
import { parseDocument } from '../src/parse/parser.ts';
import { parsedPath, runParse } from '../src/parse/run.ts';
import { readIfPresent } from '../src/files.ts';
import { parseLabel } from '../src/spl.ts';
import { cli, folders, guid, label, parsed, place, section, spl, writeCorpus } from './support.ts';

const RICH =
  section(
    '1 INDICATIONS',
    '<paragraph>Exam<content styleCode="bold">pla</content>mab treats invented H<sub>2</sub>O conditions<footnote ID="f1">An invented footnote.</footnote>.</paragraph>' +
      '<list listType="ordered"><item><caption>a.</caption>First invented item</item><item>Second <footnoteRef IDREF="f1"/> item</item></list>',
    { id: 's1', inner: '<excerpt><highlight><text><paragraph>Invented highlight words.</paragraph></text></highlight></excerpt>' },
  ) +
  section(
    '2 DOSAGE',
    '<table><caption>Table 1: Invented doses</caption><thead><tr><th>Group</th><th>Dose</th></tr></thead>' +
      '<tbody><tr><td>Adults</td><td>10 mg<sup>*</sup></td></tr><tr><td>Children</td><td>5 mg</td></tr></tbody>' +
      '<tfoot><tr><td colspan="2"><sup>*</sup> Invented note.</td></tr></tfoot></table>',
    { id: 's2' },
  );

const xmlOf = (body: string): Buffer => Buffer.from(spl(guid(1), 1, body));
const tableOf = (rows: string) => parseDocument(xmlOf(section('1 TABLE', `<table><tbody>${rows}</tbody></table>`)));

test('knowledge 16. the parsed document depends only on the XML: the same label gives byte-identical parsed file and report, whatever the clock or randomness', async (t) => {
  const outputs: string[][] = [];
  for (const [now, random] of [
    [0, 0.1],
    [1_900_000_000_000, 0.9],
  ] as const) {
    t.mock.timers.enable({ apis: ['Date'], now });
    t.mock.method(Math, 'random', () => random);
    const where = await folders(t);
    const of = label(1, RICH);
    await writeCorpus(where.corpusDir, [of]);
    await place(where.dataDir, of);
    assert.equal((await cli(['parse', '--corpus', where.corpusDir, '--data', where.dataDir])).code, 0);
    outputs.push(await Promise.all([parsedPath(where.dataDir, of.setId, 1), join(where.dataDir, 'parse-report.json')].map((path) => readFile(path, 'utf8'))));
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
  assert.deepEqual(outputs[1], outputs[0]);
});

test('knowledge 17. no text is lost or doubled without text-not-conserved: the check compares the document with every text node of the XML body, not with what the parser read', () => {
  const conserved = (body: string) => parseDocument(xmlOf(body)).problems.filter((problem) => problem.code === 'text-not-conserved');
  assert.deepEqual(conserved(RICH), [], 'a clean label');
  const unread = section('1 USES', '<paragraph>Invented words.</paragraph>').replace('<code code="34067-9"/>', '<code code="34067-9">words the parser never reads</code>');
  assert.deepEqual(conserved(unread).map((problem) => [problem.severity, problem.missing, problem.extra]), [['error', 5, 0]], 'text the parser left out');
  const document = parsed(spl(guid(1), 1, RICH));
  const first = document.sections[0]?.blocks[0] as Paragraph;
  first.text += ' treats';
  assert.deepEqual(checkConservation(parseLabel(xmlOf(RICH)), document), { missing: 0, extra: 1 }, 'a doubled word');
});

test('knowledge 18. a label with any error has no parsed file in the data folder, and one left by an earlier run is removed', async (t) => {
  const where = await folders(t);
  const failing = label(1, section('1 USES', '<table><tbody><tr><td rowspan="3">a</td><td>b</td></tr></tbody></table>'));
  const warned = label(2, section('', '<paragraph>Untitled invented words.</paragraph>'));
  await writeCorpus(where.corpusDir, [failing, warned]);
  await place(where.dataDir, failing);
  await place(where.dataDir, warned);
  const stale = parsedPath(where.dataDir, failing.setId, 1);
  await mkdir(dirname(stale), { recursive: true });
  await writeFile(stale, '{"left": "by an earlier run"}');
  const report = await runParse({ ...where, log: () => {} });
  assert.deepEqual(report.labels.map((entry) => entry.status), ['excluded', 'parsed']);
  assert.equal(await readIfPresent(stale), undefined);
  assert.notEqual(await readIfPresent(parsedPath(where.dataDir, warned.setId, 1)), undefined);
});

test('knowledge 19. Highlights text is only ever in a section\'s Highlights blocks, never in its own blocks', () => {
  const inner = '<excerpt><highlight><text><paragraph>Wrapped highlight words.</paragraph></text></highlight></excerpt><excerpt><highlight><paragraph>Bare highlight words.</paragraph></highlight></excerpt>';
  const own = parsed(spl(guid(1), 1, section('1 USES', '<paragraph>Own invented words.</paragraph>', { inner }))).sections[0];
  assert.equal(JSON.stringify(own?.blocks).includes('highlight'), false);
  for (const words of ['Wrapped highlight words.', 'Bare highlight words.']) assert.ok(JSON.stringify(own?.highlights).includes(words), words);
});

test('knowledge 20. each grid position is covered by at most one cell and empty only at the end of a short row, or the label is excluded; no cell is moved', () => {
  const rows = [
    { name: 'two cells claim one position', xml: '<tr><td>a</td><td rowspan="2">b</td></tr><tr><td colspan="2">c</td></tr>' },
    { name: 'a span past the last row', xml: '<tr><td rowspan="2">a</td><td>b</td></tr>' },
    { name: 'an empty position before a covered one', xml: '<tr><td>a</td><td>b</td><td rowspan="2">c</td></tr><tr><td>d</td></tr>' },
  ];
  for (const row of rows) {
    const errors = tableOf(row.xml).problems.filter((problem) => problem.severity === 'error').map((problem) => problem.code);
    assert.deepEqual(errors, ['table-not-rectangular'], row.name);
  }
  const short = tableOf('<tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td></tr>');
  assert.deepEqual(short.problems.filter((problem) => problem.severity === 'error'), [], 'a short row');
  const table = short.document?.sections[0]?.blocks[0] as Table;
  assert.deepEqual(table.grid[1], [[1, 0], [1, 1], null]);
});

test('knowledge 21. the parse report holds identifiers, codes, element names and numbers only', async (t) => {
  const where = await folders(t);
  const MARK = 'Marmalade';
  const of = label(
    1,
    section('1 USES', `<paragraph>Invented <inventedElement>${MARK} words</inventedElement> text.</paragraph>`) +
      section('', '<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table>', { id: `${MARK} words in an id` }),
  );
  const missing = label(2);
  await writeCorpus(where.corpusDir, [of, missing]);
  await place(where.dataDir, of);
  await runParse({ ...where, log: () => {} });
  const text = await readFile(join(where.dataDir, 'parse-report.json'), 'utf8');
  const strings: string[] = [];
  JSON.parse(text, (_key, value: unknown) => (typeof value === 'string' && strings.push(value), value));
  assert.deepEqual(strings.filter((value) => !/^[A-Za-z0-9._:-]+$/.test(value)), []);
  assert.equal(text.includes(MARK), false);
});

test('knowledge 22. text the parser does not understand is kept where it sits, and its element is reported by name and count', () => {
  const result = parseDocument(xmlOf(section('1 USES', '<paragraph>Before <inventedTag>kept one</inventedTag> middle <inventedTag>kept two</inventedTag> after.</paragraph>')));
  assert.equal((result.document?.sections[0]?.blocks[0] as Paragraph).text, 'Before kept one middle kept two after.');
  const unknown = result.problems.filter((problem) => problem.code === 'element-unknown').map(({ element, count }) => ({ element, count }));
  assert.deepEqual(unknown, [{ element: 'inventedTag', count: 2 }]);
});

test('knowledge 23. for every table row the parsed document records whether it is wholly bold and how many of its cells have text', () => {
  const bold = (text: string): string => `<content styleCode="bold">${text}</content>`;
  const result = tableOf(
    '<tr><th>Group</th><th>Dose</th></tr>' +
      `<tr><td>${bold('Adults')}</td><td></td></tr>` +
      `<tr><td>${bold('Half')} plain</td><td>x</td></tr>` +
      '<tr><td>a</td><td>b</td></tr>' +
      '<tr><td></td><td></td></tr>',
  );
  const table = result.document?.sections[0]?.blocks[0] as Table;
  assert.deepEqual(table.rowFacts, [
    { wholeBold: true, filledCells: 2 },
    { wholeBold: true, filledCells: 1 },
    { wholeBold: false, filledCells: 2 },
    { wholeBold: false, filledCells: 2 },
    { wholeBold: false, filledCells: 0 },
  ]);
});
