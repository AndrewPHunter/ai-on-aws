// Gate for the retrieval path (knowledge/README.md, "The gate").
//
// Runs on the stack's network, as one of its containers would, with the data folder and the tracked files mounted
// read-only. It signs in as dana.desk through the desk client, as the identity gate does, then checks the retrieval
// service and the index against the data the index was built from. Every statement is checked even after one fails.
//
// Usage: node knowledge/src/gate/gate.ts   (IDENTITY_DESK_CLIENT_SECRET and IDENTITY_DANA_PASSWORD must be set)
// Exit codes: 0 every statement holds, 1 one does not, 2 the gate could not run. The JSON report goes to standard
// output, progress to standard error. Neither carries a password, a token or label text: statements name
// identifiers, codes and counts only.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { signInFormAction } from '../../../platform/identity/src/login-form.ts';
import { codeChallengeS256, codeVerifier } from '../../../platform/identity/src/pkce.ts';

const KNOWLEDGE = 'http://knowledge:8000';
const SEARCH = 'http://search:9200';
const ALIAS = 'labels';
const IDENTITY = 'http://identity:8080';
const BROWSER_IDENTITY = 'http://localhost:8090';
const REALM = '/realms/lab';
const CLIENT_ID = 'desk';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';
const USER = 'dana.desk';
const TIMEOUT_MS = 20_000;
const QUESTIONS = 200;
const TOP = 5;
const ABSENT_SET_ID = '00000000-0000-4000-8000-000000000000';
const DATA = '/data';
const CORPUS = '/corpus';

class CouldNotRun extends Error {}

const held: string[] = [];
const failed: string[] = [];

function statement(ok: boolean, what: string, detail = ''): boolean {
  if (ok) {
    held.push(what);
    process.stderr.write(`knowledge-gate: holds: ${what}\n`);
  } else {
    const line = detail === '' ? what : `${what}: ${detail}`;
    failed.push(line);
    process.stderr.write(`knowledge-gate: does not hold: ${line}\n`);
  }
  return ok;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new CouldNotRun(`missing required environment variable ${name}`);
  return value;
}

const request = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });

// ---------- sign-in, as the identity gate does it ----------

function toTransport(url: string): string {
  const parsed = new URL(url);
  if (parsed.origin === BROWSER_IDENTITY || parsed.origin === IDENTITY) return `${IDENTITY}${parsed.pathname}${parsed.search}`;
  throw new CouldNotRun(`an identity URL on an unexpected origin: ${parsed.origin}`);
}

async function accessToken(): Promise<string> {
  const secret = requiredEnv('IDENTITY_DESK_CLIENT_SECRET');
  const password = requiredEnv('IDENTITY_DANA_PASSWORD');
  const cookies = new Map<string, string>();
  const take = (response: Response): void => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  };
  const cookie = (): string => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

  const verifier = codeVerifier(randomBytes(32));
  const state = randomBytes(16).toString('base64url');
  const authorize = new URL(`${IDENTITY}${REALM}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: 'S256',
  }).toString();
  const page = await request(authorize.toString());
  take(page);
  if (page.status !== 200) throw new CouldNotRun(`the sign-in page answered ${page.status}`);
  const action = toTransport(signInFormAction(await page.text()));
  const posted = await request(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
    body: new URLSearchParams({ username: USER, password, credentialId: '' }).toString(),
  });
  await posted.arrayBuffer();
  const callback = new URL(posted.headers.get('location') ?? '', action);
  const code = callback.searchParams.get('code');
  if ((posted.status !== 302 && posted.status !== 303) || code === null || callback.searchParams.get('state') !== state) {
    throw new CouldNotRun(`signing in as ${USER} did not return a code (status ${posted.status})`);
  }
  const exchange = await request(`${IDENTITY}${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      client_secret: secret,
    }).toString(),
  });
  const tokens: unknown = await exchange.json();
  const token = typeof tokens === 'object' && tokens !== null ? Reflect.get(tokens, 'access_token') : undefined;
  if (exchange.status !== 200 || typeof token !== 'string') throw new CouldNotRun(`the token exchange answered ${exchange.status}`);
  return token;
}

// ---------- the data the index was built from ----------

type Chunk = { id: string; setId: string; drug: string[]; text: string };

function readData(): { totalChunks: number; indexed: Set<string>; firstSetId: string; manifestOrder: string[]; chunksBySetId: Map<string, Chunk[]> } {
  const report = JSON.parse(readFileSync(`${DATA}/chunk-report.json`, 'utf8')) as {
    chunks: { total: number };
    labels: { setId: string; version: number; status: string }[];
  };
  const manifest = JSON.parse(readFileSync(`${CORPUS}/manifest.json`, 'utf8')) as { labels: { setId: string }[] };
  const chunksBySetId = new Map<string, Chunk[]>();
  for (const label of report.labels) {
    if (label.status !== 'chunked') continue;
    const lines = readFileSync(`${DATA}/chunks/${label.setId}/${label.version}.jsonl`, 'utf8').split('\n').filter((line) => line !== '');
    chunksBySetId.set(label.setId, lines.map((line) => JSON.parse(line) as Chunk));
  }
  const firstSetId = manifest.labels.find((label) => (chunksBySetId.get(label.setId)?.[0]?.drug.length ?? 0) > 0)?.setId;
  if (firstSetId === undefined) throw new CouldNotRun('no label in the manifest has chunks with a drug name');
  const manifestOrder = manifest.labels.map((label) => label.setId).filter((id) => chunksBySetId.has(id));
  return { totalChunks: report.chunks.total, indexed: new Set(chunksBySetId.keys()), firstSetId, manifestOrder, chunksBySetId };
}

// ---------- the service ----------

type Reply = { isError: boolean; payload: Record<string, unknown> };

const timings: number[] = [];

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const started = process.hrtime.bigint();
  let result: Awaited<ReturnType<Client['callTool']>>;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch {
    // The MCP layer refused the call outright (for example, arguments outside the input schema).
    return { isError: true, payload: { error: 'refused_by_protocol' } };
  }
  if (name === 'search_label') timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  const content: unknown = result.content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined;
  let payload: Record<string, unknown> = {};
  try {
    payload = typeof text === 'string' ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = { unparsed: true };
  }
  return { isError: result.isError === true, payload };
}

type Passage = {
  chunk_id: unknown;
  text: unknown;
  score: unknown;
  part: unknown;
  type: unknown;
  section: { number: unknown; title: unknown; path: unknown };
  position: unknown;
  label: { set_id: unknown; version: unknown; effective_date: unknown; kind: unknown; source: unknown };
};

const passagesOf = (reply: Reply): Passage[] => (Array.isArray(reply.payload.passages) ? (reply.payload.passages as Passage[]) : []);

function hasEveryField(passage: Passage): boolean {
  const s = passage.section as Record<string, unknown> | undefined;
  const l = passage.label as Record<string, unknown> | undefined;
  return (
    typeof passage.chunk_id === 'string' &&
    typeof passage.text === 'string' &&
    typeof passage.score === 'number' &&
    (passage.part === 'body' || passage.part === 'highlights') &&
    typeof passage.type === 'string' &&
    s !== undefined &&
    'number' in s &&
    'title' in s &&
    Array.isArray(s.path) &&
    typeof passage.position === 'object' &&
    passage.position !== null &&
    l !== undefined &&
    typeof l.set_id === 'string' &&
    typeof l.version === 'number' &&
    typeof l.effective_date === 'string' &&
    typeof l.kind === 'string' &&
    typeof l.source === 'string'
  );
}

const onlyFrom = (reply: Reply, setId: string): boolean => !reply.isError && passagesOf(reply).every((passage) => passage.label.set_id === setId);

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : Math.round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0);
};

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

async function main(): Promise<number> {
  const data = readData();
  const token = await accessToken();

  // 1. The token check, and /ping.
  const bare = await request(`${KNOWLEDGE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const bareBody: unknown = await bare.json().catch(() => ({}));
  const reason = typeof bareBody === 'object' && bareBody !== null ? Reflect.get(bareBody, 'reason') : undefined;
  statement(
    bare.status === 401 && reason === 'missing' && (bare.headers.get('www-authenticate') ?? '').startsWith('Bearer'),
    '1. the retrieval service answers 401 with reason missing and a WWW-Authenticate header to a request with no token',
    `status ${bare.status}, reason ${String(reason)}`,
  );
  const ping = await request(`${KNOWLEDGE}/ping`);
  statement(ping.status === 200, '1. the retrieval service answers 200 on /ping', `status ${ping.status}`);

  // 2. The alias, and its count.
  const alias = await request(`${SEARCH}/_alias/${ALIAS}`);
  const aliasBody: unknown = await alias.json().catch(() => ({}));
  const targets = alias.status === 200 && typeof aliasBody === 'object' && aliasBody !== null ? Object.keys(aliasBody) : [];
  statement(alias.status === 200 && targets.length === 1, `2. the alias ${ALIAS} exists and points at one index`, `status ${alias.status}, ${targets.length} indexes`);
  const counted = await request(`${SEARCH}/${ALIAS}/_count`);
  const countBody: unknown = await counted.json().catch(() => ({}));
  const count = typeof countBody === 'object' && countBody !== null ? Reflect.get(countBody, 'count') : undefined;
  statement(count === data.totalChunks, `2. ${ALIAS} holds as many documents as the chunk report counts (${data.totalChunks})`, `it holds ${String(count)}`);

  const client = new Client({ name: 'knowledge-gate', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${KNOWLEDGE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

  // 3. find_labels: the first manifest label's name shared by the fewest labels, and a name no label has.
  const setId = data.firstSetId;
  const own = data.chunksBySetId.get(setId) ?? [];
  const names = own[0]?.drug ?? [];
  const sharing = (name: string): number =>
    [...data.chunksBySetId.values()].filter((chunks) => chunks[0]?.drug.some((other) => other.toLowerCase() === name.toLowerCase())).length;
  const name = [...names].sort((a, b) => sharing(a) - sharing(b))[0] ?? '';
  const found = await call(client, 'find_labels', { drug: name });
  const labels = Array.isArray(found.payload.labels) ? (found.payload.labels as { set_id: unknown }[]) : [];
  statement(
    !found.isError && labels.some((label) => label.set_id === setId),
    `3. find_labels for a name of the manifest's first label (shared by ${sharing(name)} labels) returns its set id ${setId}`,
    found.isError ? `error ${String(found.payload.error)}` : `${labels.length} labels, not among them`,
  );
  // The same name in other case, with spaces around it: the exact keyword ignores both.
  const swapped = [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  const recased = await call(client, 'find_labels', { drug: `   ${swapped}  ` });
  const recasedLabels = Array.isArray(recased.payload.labels) ? (recased.payload.labels as { set_id: unknown }[]) : [];
  statement(
    !recased.isError && recased.payload.matched_by === 'exact_name' && recasedLabels.some((label) => label.set_id === setId),
    `3. find_labels for the same name in another case, with spaces around it, returns the same set id ${setId} by exact match`,
    recased.isError ? `error ${String(recased.payload.error)}` : `matched by ${String(recased.payload.matched_by)}, ${recasedLabels.length} labels`,
  );

  // A multi-word name from the manifest with its words in another order, matching no name exactly: found by the
  // every-word fallback. Chosen by a fixed rule: the first such name, in manifest order, whose words together match
  // at most 10 labels (so the 10-label cut cannot hide it).
  const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
  const allNames = new Set([...data.chunksBySetId.values()].flatMap((chunks) => (chunks[0]?.drug ?? []).map((n) => n.toLowerCase().trim())));
  const labelWords = new Map([...data.chunksBySetId].map(([id, chunks]) => [id, new Set((chunks[0]?.drug ?? []).flatMap(words))]));
  let reordered: { setId: string; query: string } | undefined;
  for (const candidate of data.manifestOrder) {
    for (const drugName of data.chunksBySetId.get(candidate)?.[0]?.drug ?? []) {
      const parts = words(drugName);
      if (parts.length < 2 || new Set(parts).size < 2) continue;
      const query = [...parts].reverse().join(' ');
      if (allNames.has(query)) continue;
      const matching = [...labelWords.values()].filter((set) => parts.every((part) => set.has(part))).length;
      if (matching > 10) continue;
      reordered = { setId: candidate, query };
      break;
    }
    if (reordered !== undefined) break;
  }
  if (reordered === undefined) {
    statement(false, '3. a multi-word name with its words reordered is found by the every-word fallback', 'no name in the manifest fits the rule');
  } else {
    const fallback = await call(client, 'find_labels', { drug: reordered.query });
    const fallbackLabels = Array.isArray(fallback.payload.labels) ? (fallback.payload.labels as { set_id: unknown }[]) : [];
    statement(
      !fallback.isError && fallback.payload.matched_by === 'every_word' && fallbackLabels.some((label) => label.set_id === reordered.setId),
      `3. find_labels for the words of a multi-word name of ${reordered.setId} in another order, matching no name exactly, returns that label by the every-word fallback`,
      fallback.isError ? `error ${String(fallback.payload.error)}` : `matched by ${String(fallback.payload.matched_by)}, ${fallbackLabels.length} labels`,
    );
  }

  const none = await call(client, 'find_labels', { drug: 'zzqx no such drug name' });
  statement(
    !none.isError && Array.isArray(none.payload.labels) && none.payload.labels.length === 0,
    '3. find_labels for a name no label has returns an empty list',
    none.isError ? `error ${String(none.payload.error)}` : 'labels were returned',
  );

  // 4. search_label with a word from one of the label's own chunks.
  const word = own.flatMap((chunk) => chunk.text.split(/[^\p{L}]+/u)).find((candidate) => candidate.length >= 6) ?? 'dosage';
  const searched = await call(client, 'search_label', { set_id: setId, query: word });
  const passages = passagesOf(searched);
  const scores = passages.map((passage) => (typeof passage.score === 'number' ? passage.score : Number.NaN));
  statement(!searched.isError && passages.length >= 1, `4. search_label on ${setId} with a word from one of its chunks returns at least one passage`, `${passages.length} passages`);
  statement(passages.every((passage) => passage.label.set_id === setId), `4. every passage carries the set id ${setId}`);
  statement(passages.every(hasEveryField), '4. every passage carries every field the contract lists');
  statement(scores.every((score, i) => i === 0 || score <= (scores[i - 1] ?? Number.NaN)), '4. the scores do not increase down the list');

  // 5. Query-language characters, and a query that names another field and another set id.
  const operators = await call(client, 'search_label', { set_id: setId, query: '+ - = && || > < ! ( ) { } [ ] ^ " ~ * ? : \\ / AND OR NOT' });
  statement(onlyFrom(operators, setId), '5. a query of query-language characters returns only passages from the one label, or none, and no error', operators.isError ? `error ${String(operators.payload.error)}` : '');
  const other = [...data.indexed].find((candidate) => candidate !== setId) ?? ABSENT_SET_ID;
  const injected = await call(client, 'search_label', { set_id: setId, query: `setId:${other} OR part:highlights OR _id:* ${word}` });
  statement(onlyFrom(injected, setId), '5. a query naming another field and another set id returns only passages from the one label, and no error', injected.isError ? `error ${String(injected.payload.error)}` : '');

  // 6. A set id not in the index.
  const absent = await call(client, 'search_label', { set_id: ABSENT_SET_ID, query: word });
  statement(absent.isError && absent.payload.error === 'label_not_found', '6. search_label on a GUID not in the index returns the error result label_not_found', `isError ${absent.isError}, error ${String(absent.payload.error)}`);

  // 7. max_results.
  const one = await call(client, 'search_label', { set_id: setId, query: word, max_results: 1 });
  statement(!one.isError && passagesOf(one).length === 1, '7. max_results 1 returns one passage', `${passagesOf(one).length} passages`);
  const ten = await call(client, 'search_label', { set_id: setId, query: word, max_results: 10 });
  statement(!ten.isError && passagesOf(ten).length <= 10, '7. max_results 10 returns at most 10 passages', `${passagesOf(ten).length} passages`);
  const eleven = await call(client, 'search_label', { set_id: setId, query: word, max_results: 11 });
  statement(eleven.isError, '7. max_results 11 is refused');

  // 8. A rough measure: is a passage from a referenced section among the first five?
  type Question = { qid: string | number; set_id: string; question: string; references: unknown };
  const questions = readFileSync(`${DATA}/benchmark/qa.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Question)
    .filter((q) => data.indexed.has(q.set_id) && Array.isArray(q.references) && q.references.length > 0 && q.references.every((r) => typeof r === 'string'))
    .sort((a, b) => (String(a.qid) < String(b.qid) ? -1 : String(a.qid) > String(b.qid) ? 1 : 0));
  const chosen = Array.from({ length: Math.min(QUESTIONS, questions.length) }, (_, i) => questions[Math.floor((i * questions.length) / Math.min(QUESTIONS, questions.length))]).filter(
    (q): q is Question => q !== undefined,
  );
  let hits = 0;
  let errors = 0;
  for (const q of chosen) {
    const query = q.question.length > 1000 ? q.question.slice(0, 1000) : q.question;
    const reply = await call(client, 'search_label', { set_id: q.set_id, query, max_results: TOP });
    if (reply.isError) {
      errors++;
      continue;
    }
    const references = (q.references as string[]).map(normalise);
    const numbers = references.map((r) => /^(\d+(?:\.\d+)*)\b/.exec(r)?.[1]).filter((n): n is string => n !== undefined);
    const hit = passagesOf(reply).some((passage) => {
      const number = typeof passage.section.number === 'string' ? passage.section.number : null;
      const title = typeof passage.section.title === 'string' ? normalise(passage.section.title) : null;
      return (number !== null && numbers.includes(number)) || (title !== null && references.includes(title));
    });
    if (hit) hits++;
  }
  statement(errors === 0, `8. every one of the ${chosen.length} benchmark searches answered without an error`, `${errors} errors`);
  await client.close();

  const report = {
    passed: failed.length === 0,
    held,
    failed,
    measures: {
      referencedSectionInTop5: {
        questions: chosen.length,
        eligible: questions.length,
        hits,
        share: chosen.length === 0 ? null : Math.round((hits / chosen.length) * 1000) / 1000,
        rule: 'questions whose label is indexed and whose references are a list, sorted by qid, every n-th to make 200; a hit is a passage among the first 5 whose section number equals the number a reference starts with, or whose title equals a reference, ignoring case and spacing',
      },
      searchLabelMilliseconds: { calls: timings.length, median: percentile(timings, 50), p95: percentile(timings, 95) },
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`knowledge-gate: could not run: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 2;
  },
);
