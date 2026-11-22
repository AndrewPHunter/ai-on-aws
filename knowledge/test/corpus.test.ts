// The corpus's invariants ("Always true" 2 to 15 in docs/architecture/knowledge.md), one test each: the tracked files,
// pinning, fetching, the census and the command line. DailyMed and the benchmark's host are an in-memory fetch
// function given to the production code; every label in it is invented.

import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCensus } from '../src/census.ts';
import { runChunk } from '../src/chunk/run.ts';
import { zipUrl, historyUrl } from '../src/dailymed.ts';
import { InputError, readBenchmarkPin, readManifest } from '../src/fetch.ts';
import { labelRecordPath, labelXmlPath, sha256 } from '../src/files.ts';
import { TransportError } from '../src/http.ts';
import { runParse } from '../src/parse/run.ts';
import { REASONS } from '../src/reasons.ts';
import { serialiseBenchmarkPin, serialiseManifest } from '../src/schema.ts';
import type { NotPinned, PinnedLabel } from '../src/schema.ts';
import { extractXml } from '../src/zip.ts';
import { parseLabel } from '../src/spl.ts';
import {
  BENCH,
  CAPS,
  DAILYMED,
  PLAIN,
  cli,
  client,
  clientFlags,
  entry,
  fetchRun,
  folders,
  guid,
  hosts,
  jsonl,
  label,
  listFiles,
  noResponse,
  pinFlags,
  pinOf,
  place,
  recorder,
  section,
  writeCorpus,
  zip,
} from './support.ts';
import type { Folders } from './support.ts';

const corpusFlags = (where: Folders): string[] => ['--corpus', where.corpusDir, '--data', where.dataDir];
const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

test('knowledge 2. the manifest and the pin are written sorted and in one key order: the same inputs give the same bytes', () => {
  const [one, two] = [entry(label(2)), entry(label(1))];
  const notPinned: NotPinned[] = [
    { setId: '', drugId: 'd9', reason: 'set-id-not-a-guid' },
    { setId: '', drugId: 'd3', reason: 'set-id-not-a-guid' },
  ];
  const written = serialiseManifest({ labels: [one, two], notPinned });
  assert.equal(written, serialiseManifest({ labels: [reversed(two), reversed(one)], notPinned: [...notPinned].reverse() }));
  assert.deepEqual((JSON.parse(written) as { labels: PinnedLabel[] }).labels.map((l) => l.setId), [guid(1), guid(2)]);
  const pin = pinOf(BENCH);
  assert.equal(serialiseBenchmarkPin(pin), serialiseBenchmarkPin(reversed(pin)));
});

test('knowledge 3. the manifest and the pin are read only through their schema: each way of breaking it is refused, saying where', async (t) => {
  const where = await folders(t);
  const good = entry(label(171));
  const { xmlSha256: _left, ...missing } = good;
  const pin = pinOf(BENCH);
  const rows: { name: string; file: string; value: unknown; at: string }[] = [
    { name: 'a missing field', file: 'manifest.json', value: { labels: [missing], notPinned: [] }, at: 'labels[0].xmlSha256' },
    { name: 'a checksum not lowercase hex', file: 'manifest.json', value: { labels: [{ ...good, zipSha256: good.zipSha256.toUpperCase() }], notPinned: [] }, at: 'labels[0].zipSha256' },
    { name: 'a set id not a lowercase GUID', file: 'manifest.json', value: { labels: [{ ...good, setId: good.setId.toUpperCase() }], notPinned: [] }, at: 'labels[0].setId' },
    { name: 'a duplicated set id', file: 'manifest.json', value: { labels: [good, good], notPinned: [] }, at: 'labels[1].setId' },
    { name: 'a pin checksum of 63 characters', file: 'benchmark.json', value: { ...pin, files: { ...pin.files, qa: { ...pin.files.qa, sha256: pin.files.qa.sha256.slice(1) } } }, at: 'files.qa.sha256' },
  ];
  for (const row of rows) {
    await writeFile(join(where.corpusDir, row.file), JSON.stringify(row.value));
    const read = row.file === 'manifest.json' ? readManifest : readBenchmarkPin;
    await assert.rejects(read(where.corpusDir), (error) => error instanceof InputError && error.message.includes(row.at), row.name);
  }
});

test('knowledge 4. a file name on disk is built only from a GUID set id and a positive version, never from a name inside an archive', async (t) => {
  for (const [setId, version] of [['../escape', 1], [guid(171).toUpperCase(), 1], [guid(1), 0], [guid(1), 1.5]] as const) {
    assert.throws(() => labelXmlPath('/data', setId, version), `${setId} version ${version}`);
  }
  const where = await folders(t);
  const labels = [label(1, PLAIN, { member: '../../escape.xml' }), label(2, PLAIN, { member: '/absolute/escape.xml' })];
  await writeCorpus(where.corpusDir, labels);
  assert.equal((await fetchRun(where, recorder(hosts(labels)).fetch)).exitCode, 0);
  const own = (n: number): string[] => [`data/labels/${guid(n)}/1.download.json`, `data/labels/${guid(n)}/1.xml`];
  assert.deepEqual(await listFiles(where.root), [
    'corpus/benchmark.json', 'corpus/manifest.json', 'data/benchmark/labels.jsonl', 'data/benchmark/qa.jsonl', 'data/fetch-report.json', ...own(1), ...own(2),
  ]);
});

test('knowledge 5. of each zip only the one member ending in .xml is read; none, or more than one, and the zip is refused', async () => {
  const xml = Buffer.from('<document/>');
  const rows = [
    { name: 'no .xml member', members: [{ name: 'label.txt', data: xml }], reason: 'zip-no-xml-member' },
    { name: 'two .xml members', members: [{ name: 'a.xml', data: xml }, { name: 'b.XML', data: xml }], reason: 'zip-several-xml-members' },
  ];
  for (const row of rows) await assert.rejects(extractXml(zip(row.members), CAPS.xmlBytes), { reason: row.reason }, row.name);
  const among = zip([{ name: 'picture.jpg', data: 'not xml' }, { name: 'label.xml', data: xml }, { name: 'notes.xml.txt', data: 'not xml' }]);
  assert.deepEqual(await extractXml(among, CAPS.xmlBytes), xml);
});

test('knowledge 6. the XML is capped on the bytes the decompressor produces; the size the archive declares only refuses earlier', async () => {
  const lying = zip([{ name: 'label.xml', data: 'x'.repeat(CAPS.xmlBytes + 1), declaredSize: 10 }]);
  await assert.rejects(extractXml(lying, CAPS.xmlBytes), { reason: 'xml-too-large' }, 'a member declaring less than it produces');
  const within = 'y'.repeat(1000);
  const read = await extractXml(zip([{ name: 'label.xml', data: within, declaredSize: 10 }]), CAPS.xmlBytes);
  assert.equal(read.toString(), within, 'a member declaring less, within the cap, is read whole');
});

test('knowledge 7. the XML reader fetches and expands no entity: a DOCTYPE declaring one is refused for that, even when the entity is used; a document not well-formed is xml-not-well-formed', () => {
  const document = (prolog: string, body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${prolog}<document xmlns="urn:hl7-org:v3">${body}</document>`);
  const rows = [
    { name: 'an internal entity, used', xml: document('<!DOCTYPE document [<!ENTITY e "INVENTED-ENTITY-TEXT">]>', '<p>&e;</p>'), reason: 'xml-doctype-declares-entities' },
    { name: 'an external entity, used', xml: document('<!DOCTYPE document [<!ENTITY e SYSTEM "file:///etc/hostname">]>', '<p>&e;</p>'), reason: 'xml-doctype-declares-entities' },
    { name: 'an element never closed', xml: document('', '<p>'), reason: 'xml-not-well-formed' },
  ];
  for (const row of rows) assert.throws(() => parseLabel(row.xml), { reason: row.reason }, row.name);
});

test('knowledge 8. a label is written only if its XML matches the manifest; a file that does not, or a download record missing, unreadable or for another XML, is replaced', async (t) => {
  const good = label(1);
  const record = (where: Folders): string => labelRecordPath(where.dataDir, good.setId, 1);
  const rows: { name: string; spoil: (where: Folders) => Promise<void> }[] = [
    { name: 'an XML that does not match', spoil: (where) => place(where.dataDir, good, Buffer.from('<other/>')) },
    { name: 'no download record', spoil: async (where) => (await place(where.dataDir, good), await rm(record(where))) },
    { name: 'a download record not readable', spoil: async (where) => (await place(where.dataDir, good), await writeFile(record(where), '{not json')) },
    { name: 'a download record for another XML', spoil: async (where) => (await place(where.dataDir, good), await writeFile(record(where), JSON.stringify({ zipSha256: sha256(good.zip), xmlSha256: sha256(Buffer.from('other')) }))) },
  ];
  for (const row of rows) {
    const where = await folders(t);
    await writeCorpus(where.corpusDir, [good]);
    await row.spoil(where);
    const web = recorder(hosts([good]));
    assert.equal((await fetchRun(where, web.fetch)).exitCode, 0, row.name);
    assert.ok(web.sent.some((sent) => sent.url === zipUrl(DAILYMED, good.setId, 1)), `${row.name}: not fetched again`);
    assert.deepEqual(await readFile(labelXmlPath(where.dataDir, good.setId, 1)), good.xml, row.name);
    assert.equal((JSON.parse(await readFile(record(where), 'utf8')) as { xmlSha256: string }).xmlSha256, sha256(good.xml), row.name);
  }
  const where = await folders(t);
  await writeCorpus(where.corpusDir, [good]);
  const other = label(1, section('1 USES', '<paragraph>Other invented words.</paragraph>'));
  const { exitCode, report } = await fetchRun(where, recorder(hosts([other])).fetch);
  assert.deepEqual([exitCode, report.refused.map((r) => r.reason)], [1, ['xml-checksum-mismatch']]);
  assert.deepEqual((await listFiles(where.dataDir)).filter((path) => path.startsWith('labels/')), []);
});

test('knowledge 9. the fetch report and the census describe the data folder: a run on complete data sends no request and changes no file', async (t) => {
  const where = await folders(t);
  const plain = label(1);
  const repackaged = label(2);
  await writeCorpus(where.corpusDir, [plain, repackaged]);
  const served = { ...repackaged, zip: zip([{ name: 'renamed.xml', data: repackaged.xml }]) };
  const snapshot = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const path of await listFiles(where.dataDir)) {
      const file = join(where.dataDir, path);
      const { ino, mtimeMs } = await stat(file);
      out.push(`${path} ${ino} ${mtimeMs} ${sha256(await readFile(file))}`);
    }
    return out;
  };
  const first = await fetchRun(where, recorder(hosts([plain, served])).fetch);
  assert.deepEqual(first.report.repackaged.map((r) => r.setId), [repackaged.setId]);
  await runCensus({ ...where, log: () => {}, warn: () => {} });
  const before = await snapshot();
  const again = recorder(hosts([plain, served]));
  const second = await fetchRun(where, again.fetch);
  await runCensus({ ...where, log: () => {}, warn: () => {} });
  assert.equal(again.sent.length, 0);
  assert.deepEqual(second.report, first.report);
  assert.deepEqual(await snapshot(), before);
});

test('knowledge 10. reasons written to a file are fixed codes, never a parser\'s message', async (t) => {
  const where = await folders(t);
  const MARK = 'Quillfeather';
  const good = label(1);
  const broken = label(2, section('1 USES', `<paragraph>${MARK} words <unclosed></paragraph>`));
  const unserved = label(3);
  const mismatched = label(4);
  await writeCorpus(where.corpusDir, [good, broken, unserved, mismatched]);
  const changed = label(4, section('1 USES', '<paragraph>Other invented words.</paragraph>'));
  await fetchRun(where, recorder(hosts([good, broken, changed])).fetch);
  await place(where.dataDir, mismatched, changed.xml);
  await runCensus({ ...where, log: () => {}, warn: () => {} });
  await place(where.dataDir, broken);
  await runParse({ ...where, log: () => {} });
  await runChunk({ ...where, settings: { textLimit: 300, tableLimit: 300 }, log: () => {} });
  const allowed = new Set<string>([...REASONS, 'missing', 'checksum-mismatch', 'no-parsed-file', 'check-failed', 'other']);
  const found = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) key === 'reason' ? found.add(String(inner)) : collect(inner);
    }
  };
  for (const report of ['fetch-report.json', 'census.json', 'parse-report.json', 'chunk-report.json']) {
    const text = await readFile(join(where.dataDir, report), 'utf8');
    assert.equal(text.includes(MARK), false, report);
    collect(JSON.parse(text));
  }
  assert.deepEqual([...found].filter((reason) => !allowed.has(reason)), []);
  for (const expected of ['xml-not-well-formed', 'version-not-served', 'xml-checksum-mismatch', 'missing', 'checksum-mismatch', 'no-parsed-file']) assert.ok(found.has(expected), expected);
});

test('knowledge 11. requests in flight never pass the cap, which may not be set above 4; only no answer, a body cut short, 408, 429 and 5xx are tried again, 3 attempts in all, with the waits given', async () => {
  let inFlight = 0;
  let peak = 0;
  const slow = recorder(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    return new Response('x');
  });
  const shared = client(slow.fetch, { maxConcurrent: 2 });
  await Promise.all(Array.from({ length: 6 }, (_, n) => shared.get(`https://dailymed.test/${n}`, 100, new Error('big'))));
  assert.equal(peak, 2);

  const refused = recorder(() => new Response('x'));
  const run = await cli(['fetch', '--corpus', '/nowhere', '--data', '/nowhere', ...clientFlags('5')], refused.fetch);
  assert.deepEqual([run.code, refused.sent.length], [2, 0], 'a cap of 5');

  const status = (code: number) => (): Response => new Response('', { status: code });
  const cut = (): Response =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.error(new Error('cut'));
        },
      }),
    );
  const retried = { requests: 3, waits: [10, 20], outcome: 'failed' };
  const rows = [
    { name: '408', answer: status(408), expected: retried },
    { name: '429', answer: status(429), expected: retried },
    { name: '503', answer: status(503), expected: retried },
    { name: 'no answer', answer: noResponse, expected: retried },
    { name: 'a body cut short', answer: cut, expected: retried },
    { name: '404', answer: status(404), expected: { requests: 1, waits: [], outcome: 'not-found' } },
    { name: '403', answer: status(403), expected: { requests: 1, waits: [], outcome: 'failed' } },
  ];
  for (const row of rows) {
    const waits: number[] = [];
    const web = recorder(row.answer);
    const outcome = await client(web.fetch, { sleep: async (ms) => void waits.push(ms) })
      .get('https://dailymed.test/x', 100, new Error('big'))
      .then(
        (result) => result.status,
        (error: unknown) => (error instanceof TransportError ? 'failed' : 'other'),
      );
    assert.deepEqual({ requests: web.sent.length, waits, outcome }, row.expected, row.name);
  }
});

test('knowledge 12. every request carries the User-Agent it is given and nothing else that identifies who sent it', async (t) => {
  const where = await folders(t);
  const labels = [label(1), label(2)];
  await writeCorpus(where.corpusDir, labels);
  const web = recorder(hosts(labels));
  const run = await cli(['fetch', ...corpusFlags(where), ...clientFlags()], web.fetch);
  assert.equal(run.code, 0);
  assert.equal(web.sent.length, 4);
  for (const sent of web.sent) assert.deepEqual(sent.headers, { 'user-agent': 'test-agent/1' }, sent.url);
});

test('knowledge 13. a request that fails during pinning fails the run: every set id is still tried, each failure named, and nothing is written', async (t) => {
  const where = await folders(t);
  const [fine, failing] = [label(1), label(2)];
  const files = { labels: jsonl([failing, fine].map((of, n) => ({ set_id: of.setId, drug_name: 'Examplamab', drug_id: `d${n}`, chunks: [] }))), qa: jsonl([]) };
  const serve = hosts([fine, failing], files);
  const web = recorder((sent, signal) => (sent.url === historyUrl(DAILYMED, failing.setId, 1) ? new Response('', { status: 503 }) : serve(sent, signal)));
  const run = await cli(['pin', ...pinFlags(where), ...clientFlags('2', '1')], web.fetch);
  assert.equal(run.code, 1);
  assert.ok(web.sent.some((sent) => sent.url === zipUrl(DAILYMED, fine.setId, 1)), 'the other set id was not tried');
  assert.ok(run.err.some((line) => line.includes(failing.setId)), 'the failing set id is not named');
  assert.deepEqual(await listFiles(where.root), []);
});

test('knowledge 14. the census runs with no network and writes counts and codes only', async (t) => {
  const where = await folders(t);
  const MARK = 'Zanzibarine';
  const of = label(1, section('1 USES', `<paragraph>${MARK} invented words.</paragraph>`));
  const files = {
    labels: jsonl([{ set_id: of.setId, drug_name: MARK, drug_id: 'd1', chunks: [`${MARK} invented words.`] }]),
    qa: jsonl([{ qid: 1, task: 'dosage', source: 'body', set_id: of.setId, context: [{ text: `${MARK} invented`, has_answer: true }] }]),
  };
  await writeCorpus(where.corpusDir, [of], files);
  await fetchRun(where, recorder(hosts([of], files)).fetch);
  const run = await cli(['census', ...corpusFlags(where)]);
  const census = await readFile(join(where.dataDir, 'census.json'), 'utf8');
  assert.equal(run.code, 0);
  assert.equal((JSON.parse(census) as { labels: { drugNamePresent: boolean }[] }).labels[0]?.drugNamePresent, true, 'the label text was not read');
  assert.equal([census, ...run.out, ...run.err].some((text) => text.includes(MARK)), false);
});

test('knowledge 15. every setting is a named flag with no default, and no command reads the environment but embed, for its six model settings', async (t) => {
  const where = await folders(t);
  const commands: Record<string, string[]> = {
    pin: [...pinFlags(where), ...clientFlags()],
    fetch: [...corpusFlags(where), ...clientFlags()],
    census: corpusFlags(where),
    parse: corpusFlags(where),
    chunk: [...corpusFlags(where), '--text-limit', '300', '--table-limit', '300'],
    embed: ['--data', where.dataDir, '--batch-size', '32', '--attempts', '3', '--waits-ms', '10,20', '--timeout-ms', '1000'],
    index: ['--data', where.dataDir, '--search-url', 'http://search.test', '--alias', 'labels', '--batch-bytes', '1000', '--timeout-ms', '1000'],
  };
  const reads: string[] = [];
  let running = '';
  const env = new Proxy({ MODEL_EMBED_BASE_URL: 'http://embed.test/v1', UNRELATED_SETTING: 'set' } as Record<string, string | undefined>, {
    get: (target, name) => (reads.push(`${running} ${String(name)}`), Reflect.get(target, name)),
  });
  for (const [command, flags] of Object.entries(commands)) {
    running = command;
    const web = recorder(() => new Response('', { status: 404 }));
    for (let at = 0; at < flags.length; at += 2) {
      const short = await cli([command, ...flags.slice(0, at), ...flags.slice(at + 2)], web.fetch, env);
      assert.deepEqual([short.code, web.sent.length], [2, 0], `${command} without ${flags[at] ?? ''}`);
    }
    const whole = await cli([command, ...flags], web.fetch, env);
    if (command === 'embed') assert.ok(whole.code === 2 && whole.err.join('\n').includes('MODEL_API_KEY'), 'embed names the missing setting');
  }
  const six = ['MODEL_EMBED_BASE_URL', 'MODEL_API_KEY', 'EMBED_MODEL_ID', 'EMBED_MODEL_REPO', 'EMBED_MODEL_REVISION', 'EMBED_DIMENSIONS'];
  assert.deepEqual(reads.filter((read) => !six.some((name) => read === `embed ${name}`)), []);
});
