// The splitter's invariants ("Always true" 24 to 28 in docs/architecture/knowledge.md), one test each, on synthetic
// labels parsed by the real parser, and through the chunk command where the invariant is about the files it writes.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkChunks } from '../src/chunk/check.ts';
import { chunkPath, runChunk } from '../src/chunk/run.ts';
import { splitDocument } from '../src/chunk/split.ts';
import { readIfPresent } from '../src/files.ts';
import type { Paragraph, ParsedDocument, Table } from '../src/parse/model.ts';
import { parsedPath } from '../src/parse/run.ts';
import { cli, folders, guid, label, parsed, place, section, spl, writeCorpus } from './support.ts';

const bold = (text: string): string => `<content styleCode="bold">${text}</content>`;
const HEAD = '<thead><tr><th>Group</th><th>Dose</th></tr></thead>';
const LONG_WORDS = Array.from({ length: 20 }, (_, n) => `word${n}`).join(' ');

// A splittable table: a caption, a header, two group labels, and a row span.
const SPLIT =
  `<table><caption>Table 2: Invented</caption>${HEAD}<tbody>` +
  `<tr><td>${bold('Adults')}</td><td></td></tr><tr><td>alpha one</td><td>ten mg</td></tr>` +
  '<tr><td rowspan="2">beta two</td><td>twenty mg</td></tr><tr><td>thirty mg more words</td></tr>' +
  `<tr><td>${bold('Children')}</td><td></td></tr><tr><td>gamma three</td><td>five mg</td></tr><tr><td>delta four</td><td>six mg</td></tr>` +
  '</tbody></table>';
const LONG_ROW = `<table>${HEAD}<tbody><tr><td>a1</td><td>b1</td></tr><tr><td>${LONG_WORDS}</td><td>c</td></tr><tr><td>a2</td><td>b2</td></tr></tbody></table>`;
const NO_THEAD = `<table><tbody><tr><th>Group</th><th>Dose</th></tr>${'<tr><td>one two</td><td>three four</td></tr>'.repeat(5)}</tbody></table>`;
const ONE_BODY_ROW = `<table>${HEAD}<tbody><tr><td>${LONG_WORDS}</td><td>c</td></tr></tbody></table>`;
const PROSE = `<paragraph>${LONG_WORDS}. A second sentence here.</paragraph><list listType="unordered"><item>One item of words</item><item>${LONG_WORDS}</item></list>`;

const TIGHT = { textLimit: 5, tableLimit: 12 };

test('knowledge 24. the chunks depend only on the parsed document and the two named limits: byte-identical chunk files and report, whatever the clock or randomness', async (t) => {
  const outputs: string[][] = [];
  for (const [now, random] of [
    [0, 0.1],
    [1_900_000_000_000, 0.9],
  ] as const) {
    const where = await folders(t);
    const of = label(1, section('1 PROSE', PROSE) + section('2 TABLE', SPLIT));
    await writeCorpus(where.corpusDir, [of]);
    await place(where.dataDir, of);
    await cli(['parse', '--corpus', where.corpusDir, '--data', where.dataDir]);
    t.mock.timers.enable({ apis: ['Date'], now });
    t.mock.method(Math, 'random', () => random);
    const run = await cli(['chunk', '--corpus', where.corpusDir, '--data', where.dataDir, '--text-limit', '5', '--table-limit', '12']);
    assert.equal(run.code, 0);
    outputs.push(await Promise.all([chunkPath(where.dataDir, of.setId, 1), join(where.dataDir, 'chunk-report.json')].map((path) => readFile(path, 'utf8'))));
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
  assert.deepEqual(outputs[1], outputs[0]);
});

test('knowledge 25. every word of a label\'s blocks and Highlights is in exactly one chunk outside its repeated lines, or the label gets no chunk file: the check compares with the parsed document, not with what the splitter wrote', async (t) => {
  const where = await folders(t);
  const whole = label(1, section('1 PROSE', PROSE, { inner: '<excerpt><highlight><text><paragraph>Invented highlight words here.</paragraph></text></highlight></excerpt>' }) + section('2 TABLE', SPLIT));
  const uncovered = label(2, section('1 TABLE', `<table>${HEAD}<tbody><tr><td>Adults</td><td>ten mg</td></tr></tbody></table>`));
  await writeCorpus(where.corpusDir, [whole, uncovered]);
  const documents = [parsed(whole.xml.toString()), parsed(uncovered.xml.toString())];
  // A cell of the table that no grid position covers: the splitter cannot write it.
  const table = documents[1]?.sections[0]?.blocks[0] as Table;
  table.grid[1] = [table.grid[1]?.[0] ?? null, null];
  for (const document of documents) {
    const path = parsedPath(where.dataDir, document.setId, 1);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ document, warnings: [] }));
  }
  const stale = chunkPath(where.dataDir, uncovered.setId, 1);
  await mkdir(dirname(stale), { recursive: true });
  await writeFile(stale, '{"left": "by an earlier run"}\n');
  const report = await runChunk({ ...where, settings: TIGHT, log: () => {} });
  assert.deepEqual(report.labels.map((entry) => entry.status), ['chunked', 'not-chunked']);
  assert.deepEqual(report.notChunked.map((entry) => entry.reason), ['check-failed']);
  assert.equal(await readIfPresent(stale), undefined);
  const document = documents[0] as ParsedDocument;
  const { chunks } = splitDocument(document, TIGHT);
  assert.ok(checkChunks(document, [...chunks, ...chunks.slice(0, 1)]).extra > 0, 'a chunk written twice');
});

test('knowledge 26. a chunk id depends only on the set id, version, section, part and the chunk\'s place in its section and part', () => {
  const base = parsed(spl(guid(1), 1, section('1 A', '<paragraph>One invented paragraph.</paragraph>', { id: 's-a' }) + section('2 B', '<paragraph>Two words.</paragraph><paragraph>More words here.</paragraph>', { id: 's-b' })));
  const ids = (edit: (document: ParsedDocument) => void = () => {}): string[] => {
    const copy = structuredClone(base);
    edit(copy);
    return splitDocument(copy, { textLimit: 3, tableLimit: 300 }).chunks.filter((chunk) => chunk.section.id === 's-b').map((chunk) => chunk.id);
  };
  const paragraphs = (document: ParsedDocument, at: number): Paragraph[] => (document.sections[at]?.blocks ?? []) as Paragraph[];
  const rows: [string, (document: ParsedDocument) => void][] = [
    ['the effective time', (d) => void (d.effectiveTime = '20990101')],
    ['the kind', (d) => void (d.kind = 'otc')],
    ['the drug names', (d) => void (d.products = [{ name: 'Otherdrug', genericName: null, activeIngredients: [] }])],
    ['the section title', (d) => d.sections.slice(1, 2).forEach((s) => (s.title = '9 RENAMED'))],
    ['the words', (d) => paragraphs(d, 1).forEach((p, at) => (p.text = at === 0 ? 'Other words.' : 'Still other words.'))],
    ['an earlier section\'s chunks', (d) => void paragraphs(d, 0).push({ type: 'paragraph', text: 'Three more words.', indent: 0, marks: [], footnotes: [] })],
  ];
  const expected = ids();
  assert.equal(expected.length, 2);
  for (const [name, edit] of rows) assert.deepEqual(ids(edit), expected, name);
  assert.ok(ids((d) => void (d.version = 2)).every((id, at) => id !== expected[at] && id.includes('/2/')), 'the version');
});

test('knowledge 27. tables: one chunk when not splittable or with fewer than two body rows; a split repeats caption, header and group label, never ends on a group label or inside a row span, and a single row may pass the limit', () => {
  const document = parsed(spl(guid(1), 1, section('1 T', NO_THEAD, { id: 't1' }) + section('2 T', ONE_BODY_ROW, { id: 't2' }) + section('3 T', SPLIT, { id: 't3' }) + section('4 T', LONG_ROW, { id: 't4' })));
  const { chunks } = splitDocument(document, TIGHT);
  const of = (id: string) => chunks.filter((chunk) => chunk.section.id === id);
  assert.deepEqual(of('t1').map((chunk) => [chunk.type, chunk.words > TIGHT.tableLimit]), [['table', true]], 'not splittable');
  assert.deepEqual(of('t2').map((chunk) => [chunk.type, chunk.words > TIGHT.tableLimit]), [['table', true]], 'one body row');
  for (const id of ['t3', 't4']) {
    const table = document.sections.find((s) => s.id === id)?.blocks[0] as Table;
    const pieces = of(id);
    assert.ok(pieces.length > 1 && pieces.every((piece) => piece.type === 'table-rows'), `${id}: not split`);
    const head = pieces[0]?.text.split('\n').slice(0, (table.caption === null ? 0 : 1) + table.headerRows) ?? [];
    assert.ok(head.includes('Group | Dose'), `${id}: the header row`);
    const group = (row: number): boolean => table.rowFacts[row]?.wholeBold === true && table.rowFacts[row]?.filledCells === 1;
    pieces.forEach((piece, at) => {
      const { firstRow = 0, lastRow = 0 } = piece.position;
      assert.deepEqual(piece.text.split('\n').slice(0, head.length), head, `${id} piece ${at}: caption and header in front`);
      if (at > 0) assert.deepEqual(head.filter((line) => !piece.repeated.includes(line)), [], `${id} piece ${at}: repeated`);
      assert.ok(!group(lastRow) || lastRow === table.rows.length - 1, `${id} piece ${at}: ends on a group label`);
      assert.ok(table.grid[lastRow + 1]?.every((cell) => cell === null || cell[0] === lastRow + 1) ?? true, `${id} piece ${at}: ends inside a row span`);
      const inForce = Array.from({ length: firstRow - table.headerRows }, (_, n) => firstRow - 1 - n).find(group);
      if (at > 0 && !group(firstRow) && inForce !== undefined) {
        const text = table.rows[inForce]?.[0]?.text ?? '';
        assert.ok(piece.repeated.some((line) => line.includes(text)), `${id} piece ${at}: the group label in force`);
      }
    });
  }
  assert.ok(of('t3').some((piece) => piece.repeated.some((line) => line.includes('Adults'))), 'no group label was carried');
  assert.ok(of('t4').some((piece) => piece.position.firstRow === piece.position.lastRow && piece.words > TIGHT.tableLimit), 'a single row over the limit');
});

test('knowledge 28. a table chunk holds one table and no other text; a table inside a list item is written into the list\'s text chunk', () => {
  const document = parsed(
    spl(
      guid(1),
      1,
      section(
        '1 MIXED',
        '<paragraph>Words before the table.</paragraph><table><thead><tr><th>Cola</th></tr></thead><tbody><tr><td>Cellone</td></tr></tbody></table>' +
          '<paragraph>Words after the table.</paragraph><list listType="unordered"><item>Item words<table><tbody><tr><td>Nestedcell</td><td>Other</td></tr></tbody></table></item></list>',
      ),
    ),
  );
  const { chunks } = splitDocument(document, { textLimit: 300, tableLimit: 300 });
  assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'text').map((chunk) => chunk.text), ['Cola\nCellone']);
  const nested = chunks.filter((chunk) => chunk.text.includes('Nestedcell | Other'));
  assert.deepEqual(nested.map((chunk) => [chunk.type, chunk.text.includes('Item words')]), [['text', true]]);
});
