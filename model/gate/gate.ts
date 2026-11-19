// Gate test for the model server.
//
// Answers one question: does this OpenAI-compatible server meet what the lab needs from it?
//   1. It rejects missing and wrong API keys.
//   2. It completes tool-calling conversations correctly while several run at once,
//      both streaming and non-streaming.
//   3. It holds several long prompts in context at the same time.
//
// Zero dependencies: Node 22 built-ins only, so it runs in a stock Node image with no install step.
// Usage: node gate.ts <config.json>   (MODEL_BASE_URL, MODEL_ID and MODEL_API_KEY must be set)
// Exit codes: 0 = gate passed, 1 = gate failed, 2 = the test itself could not run.
// The JSON report goes to stdout; progress goes to stderr.

import { readFileSync } from 'node:fs'

// ---------- configuration ----------

type GateConfig = {
  temperature: number
  seed: number
  requestTimeoutMs: number
  toolCalling: { rounds: number; concurrency: number; maxTokens: number; minCorrectRate: number }
  context: { concurrency: number; minPromptTokens: number; maxTokens: number }
}

class UsageError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new UsageError(`Missing required environment variable ${name}`)
  return value
}

function numberAt(source: unknown, path: string[]): number {
  let cursor: unknown = source
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null || !(key in cursor)) {
      throw new UsageError(`Config is missing ${path.join('.')}`)
    }
    cursor = (cursor as Record<string, unknown>)[key]
  }
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) {
    throw new UsageError(`Config value ${path.join('.')} must be a number`)
  }
  return cursor
}

function loadConfig(path: string): GateConfig {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return {
    temperature: numberAt(raw, ['temperature']),
    seed: numberAt(raw, ['seed']),
    requestTimeoutMs: numberAt(raw, ['requestTimeoutMs']),
    toolCalling: {
      rounds: numberAt(raw, ['toolCalling', 'rounds']),
      concurrency: numberAt(raw, ['toolCalling', 'concurrency']),
      maxTokens: numberAt(raw, ['toolCalling', 'maxTokens']),
      minCorrectRate: numberAt(raw, ['toolCalling', 'minCorrectRate']),
    },
    context: {
      concurrency: numberAt(raw, ['context', 'concurrency']),
      minPromptTokens: numberAt(raw, ['context', 'minPromptTokens']),
      maxTokens: numberAt(raw, ['context', 'maxTokens']),
    },
  }
}

// ---------- deterministic test data ----------

// mulberry32: a small seeded generator, so every run issues the same codes and filler text.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hexCode(random: () => number, prefix: string): string {
  let hex = ''
  for (let i = 0; i < 10; i++) hex += Math.floor(random() * 16).toString(16)
  return `${prefix}-${hex}`
}

const FILLER_WORDS = [
  'amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper',
  'kelp', 'lantern', 'meadow', 'nickel', 'orchard', 'pebble', 'quartz', 'river', 'saffron', 'timber',
]

function fillerLine(random: () => number, lineNumber: number): string {
  const words: string[] = []
  for (let i = 0; i < 12; i++) words.push(FILLER_WORDS[Math.floor(random() * FILLER_WORDS.length)])
  return `Log entry ${lineNumber}: ${words.join(' ')}.`
}

// ---------- OpenAI-compatible client ----------

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type Completion = {
  content: string
  toolCalls: ToolCall[]
  finishReason: string | null
  promptTokens: number | null
  reasoningChars: number
}

type ChatOptions = { stream: boolean; maxTokens: number; seed: number; tools?: unknown[] }

class HttpError extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
    this.status = status
  }
}

type Client = {
  status(path: string, apiKey: string | null): Promise<number>
  getJson(path: string): Promise<unknown>
  chat(messages: ChatMessage[], options: ChatOptions): Promise<Completion>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function createClient(baseUrl: string, modelId: string, apiKey: string, config: GateConfig): Client {
  const root = baseUrl.replace(/\/+$/, '')
  const headers = (key: string | null): Record<string, string> =>
    key === null
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
  const timeout = (): AbortSignal => AbortSignal.timeout(config.requestTimeoutMs)

  async function status(path: string, key: string | null): Promise<number> {
    const response = await fetch(`${root}${path}`, { headers: headers(key), signal: timeout() })
    await response.arrayBuffer()
    return response.status
  }

  async function getJson(path: string): Promise<unknown> {
    const response = await fetch(`${root}${path}`, { headers: headers(apiKey), signal: timeout() })
    const text = await response.text()
    if (!response.ok) throw new HttpError(response.status, text)
    return JSON.parse(text)
  }

  async function chat(messages: ChatMessage[], options: ChatOptions): Promise<Completion> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: config.temperature,
      seed: options.seed,
      max_tokens: options.maxTokens,
      stream: options.stream,
    }
    if (options.tools) body.tools = options.tools
    if (options.stream) body.stream_options = { include_usage: true }

    const response = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: timeout(),
    })
    if (!response.ok) throw new HttpError(response.status, await response.text())
    return options.stream ? readStream(response) : readWhole(asRecord(await response.json()))
  }

  return { status, getJson, chat }
}

function readWhole(payload: Record<string, unknown>): Completion {
  const choice = asRecord(asArray(payload.choices)[0])
  const message = asRecord(choice.message)
  const toolCalls = asArray(message.tool_calls).map((entry): ToolCall => {
    const call = asRecord(entry)
    const fn = asRecord(call.function)
    return { id: asString(call.id), type: 'function', function: { name: asString(fn.name), arguments: asString(fn.arguments) } }
  })
  const usage = asRecord(payload.usage)
  return {
    content: asString(message.content),
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    reasoningChars: (asString(message.reasoning) || asString(message.reasoning_content)).length,
  }
}

async function readStream(response: Response): Promise<Completion> {
  if (!response.body) throw new Error('Streaming response has no body')
  const result: Completion = { content: '', toolCalls: [], finishReason: null, promptTokens: null, reasoningChars: 0 }
  const decoder = new TextDecoder()
  let buffered = ''

  const consume = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') return
    const chunk = asRecord(JSON.parse(data))
    const usage = asRecord(chunk.usage)
    if (typeof usage.prompt_tokens === 'number') result.promptTokens = usage.prompt_tokens
    const choice = asRecord(asArray(chunk.choices)[0])
    if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason
    const delta = asRecord(choice.delta)
    result.content += asString(delta.content)
    result.reasoningChars += (asString(delta.reasoning) || asString(delta.reasoning_content)).length
    for (const entry of asArray(delta.tool_calls)) {
      const part = asRecord(entry)
      const index = typeof part.index === 'number' ? part.index : 0
      while (result.toolCalls.length <= index) {
        result.toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
      }
      const fn = asRecord(part.function)
      const target = result.toolCalls[index]
      target.id += asString(part.id)
      target.function.name += asString(fn.name)
      target.function.arguments += asString(fn.arguments)
    }
  }

  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(bytes, { stream: true })
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      consume(buffered.slice(0, newline).trimEnd())
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
  consume(buffered.trimEnd())
  return result
}

// ---------- check 1: authentication ----------

type AuthResult = { missingKeyStatus: number; wrongKeyStatus: number; validKeyStatus: number; passed: boolean }

async function checkAuth(client: Client, apiKey: string): Promise<AuthResult> {
  const missingKeyStatus = await client.status('/models', null)
  const wrongKeyStatus = await client.status('/models', `${apiKey}-wrong`)
  const validKeyStatus = await client.status('/models', apiKey)
  return {
    missingKeyStatus,
    wrongKeyStatus,
    validKeyStatus,
    passed: missingKeyStatus === 401 && wrongKeyStatus === 401 && validKeyStatus === 200,
  }
}

// ---------- check 2: tool calling under concurrency ----------

type ToolOutcome =
  | 'ok'
  | 'http_error' // the server refused or failed the request
  | 'truncated' // a reply was cut off by the token limit
  | 'unparsed_tool_markup' // tool-call markup came back as plain text instead of a tool call
  | 'cross_talk' // a reply used another conversation's service or code
  | 'no_tool_call'
  | 'wrong_tool'
  | 'bad_arguments'
  | 'repeated_tool_call'
  | 'wrong_answer'

// Outcomes that indicate a server or parser fault rather than a model mistake. None are tolerated.
const SERVER_FAULTS: ToolOutcome[] = ['http_error', 'truncated', 'unparsed_tool_markup', 'cross_talk']

type Conversation = { index: number; round: number; stream: boolean; service: string; code: string }

type ConversationResult = {
  index: number
  round: number
  stream: boolean
  outcome: ToolOutcome
  detail: string
  latencyMs: number
  reasoningChars: number // how much thinking text the model produced; 0 means thinking was off
}

const LOOKUP_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_deployment',
    description: 'Look up the current status of a deployment.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name' },
        environment: { type: 'string', description: 'Deployment environment' },
      },
      required: ['service', 'environment'],
      additionalProperties: false,
    },
  },
}

const TOOL_SYSTEM_PROMPT =
  'Use the lookup_deployment tool for deployment information. ' +
  'Report the exact verification code returned by the tool; never invent one.'

const TOOL_MARKUP = /<tool_call|<function=|<\/tool_call>/

function classifyToolRequest(reply: Completion, own: Conversation, all: Conversation[]): { outcome: ToolOutcome; detail: string } {
  if (reply.finishReason === 'length') return { outcome: 'truncated', detail: 'tool request cut off by the token limit' }
  if (reply.toolCalls.length === 0) {
    return TOOL_MARKUP.test(reply.content)
      ? { outcome: 'unparsed_tool_markup', detail: reply.content.slice(0, 200) }
      : { outcome: 'no_tool_call', detail: reply.content.slice(0, 200) }
  }
  if (reply.toolCalls.length !== 1 || reply.toolCalls[0].function.name !== 'lookup_deployment') {
    return { outcome: 'wrong_tool', detail: reply.toolCalls.map((call) => call.function.name).join(',') }
  }
  let args: Record<string, unknown>
  try {
    args = asRecord(JSON.parse(reply.toolCalls[0].function.arguments))
  } catch {
    return { outcome: 'bad_arguments', detail: reply.toolCalls[0].function.arguments.slice(0, 200) }
  }
  if (args.service === own.service && args.environment === 'local') return { outcome: 'ok', detail: '' }
  const borrowed = all.some((other) => other.index !== own.index && other.service === args.service)
  return { outcome: borrowed ? 'cross_talk' : 'bad_arguments', detail: JSON.stringify(args).slice(0, 200) }
}

function classifyFinalAnswer(reply: Completion, own: Conversation, all: Conversation[]): { outcome: ToolOutcome; detail: string } {
  if (reply.finishReason === 'length') return { outcome: 'truncated', detail: 'final answer cut off by the token limit' }
  if (reply.toolCalls.length > 0) return { outcome: 'repeated_tool_call', detail: '' }
  if (reply.content.includes(own.code)) return { outcome: 'ok', detail: '' }
  if (all.some((other) => other.index !== own.index && reply.content.includes(other.code))) {
    return { outcome: 'cross_talk', detail: reply.content.slice(0, 200) }
  }
  if (TOOL_MARKUP.test(reply.content)) return { outcome: 'unparsed_tool_markup', detail: reply.content.slice(0, 200) }
  return { outcome: 'wrong_answer', detail: reply.content.slice(0, 200) }
}

async function runToolConversation(client: Client, config: GateConfig, own: Conversation, all: Conversation[]): Promise<ConversationResult> {
  const started = performance.now()
  let reasoningChars = 0
  const finish = (outcome: ToolOutcome, detail: string): ConversationResult => ({
    index: own.index,
    round: own.round,
    stream: own.stream,
    outcome,
    detail,
    latencyMs: Math.round(performance.now() - started),
    reasoningChars,
  })
  const options: ChatOptions = {
    stream: own.stream,
    maxTokens: config.toolCalling.maxTokens,
    seed: config.seed + own.index,
    tools: [LOOKUP_TOOL],
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: TOOL_SYSTEM_PROMPT },
    { role: 'user', content: `Look up the service "${own.service}" in the "local" environment. Report its status and exact verification code.` },
  ]
  try {
    const request = await client.chat(messages, options)
    reasoningChars += request.reasoningChars
    const first = classifyToolRequest(request, own, all)
    if (first.outcome !== 'ok') return finish(first.outcome, first.detail)

    messages.push({ role: 'assistant', content: request.content === '' ? null : request.content, tool_calls: request.toolCalls })
    messages.push({
      role: 'tool',
      tool_call_id: request.toolCalls[0].id,
      content: JSON.stringify({ status: 'ready', verification_code: own.code }),
    })
    const answer = await client.chat(messages, options)
    reasoningChars += answer.reasoningChars
    const second = classifyFinalAnswer(answer, own, all)
    return finish(second.outcome, second.detail)
  } catch (error) {
    return finish('http_error', error instanceof Error ? error.message : String(error))
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

type ToolCallingResult = {
  conversations: number
  concurrency: number
  outcomes: Record<string, number>
  correctRate: number
  serverFaults: number
  conversationsWithReasoning: number
  latencyMs: { p50: number; p95: number; max: number }
  roundWallMs: { p50: number; max: number }
  failures: ConversationResult[]
  passed: boolean
}

async function checkToolCalling(client: Client, config: GateConfig, random: () => number): Promise<ToolCallingResult> {
  const { rounds, concurrency, minCorrectRate } = config.toolCalling
  const all: Conversation[] = []
  for (let index = 0; index < rounds * concurrency; index++) {
    all.push({
      index,
      round: Math.floor(index / concurrency),
      stream: index % 2 === 1, // alternate, so streaming and non-streaming run side by side
      service: `svc-${hexCode(random, 'gate')}`,
      code: hexCode(random, 'CODE'),
    })
  }

  const results: ConversationResult[] = []
  const roundWall: number[] = []
  for (let round = 0; round < rounds; round++) {
    const started = performance.now()
    const batch = all.filter((conversation) => conversation.round === round)
    results.push(...(await Promise.all(batch.map((own) => runToolConversation(client, config, own, all)))))
    roundWall.push(Math.round(performance.now() - started))
    process.stderr.write(`tool calling: round ${round + 1}/${rounds} done\n`)
  }

  const outcomes: Record<string, number> = {}
  for (const result of results) outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1
  const correct = outcomes.ok ?? 0
  const serverFaults = results.filter((result) => SERVER_FAULTS.includes(result.outcome)).length
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b)
  const walls = [...roundWall].sort((a, b) => a - b)
  const correctRate = correct / results.length
  return {
    conversations: results.length,
    concurrency,
    outcomes,
    correctRate,
    serverFaults,
    conversationsWithReasoning: results.filter((result) => result.reasoningChars > 0).length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies[latencies.length - 1] ?? 0 },
    roundWallMs: { p50: percentile(walls, 0.5), max: walls[walls.length - 1] ?? 0 },
    failures: results.filter((result) => result.outcome !== 'ok'),
    passed: serverFaults === 0 && correctRate >= minCorrectRate,
  }
}

// ---------- check 3: long prompts held at the same time ----------

type ContextRequestResult = { index: number; promptTokens: number | null; found: boolean; detail: string; latencyMs: number }

type ContextResult = {
  concurrency: number
  minPromptTokens: number
  requests: ContextRequestResult[]
  wallMs: number
  passed: boolean
}

async function checkContext(client: Client, config: GateConfig, random: () => number): Promise<ContextResult> {
  const { concurrency, minPromptTokens, maxTokens } = config.context
  const question = 'What is the verification code stated in the log above? Reply with the code only.'
  const plain: ChatOptions = { stream: false, maxTokens, seed: config.seed }

  // Measure how many tokens the server counts per filler line, then size each prompt from that.
  const sampleLines = 200
  const sample: string[] = []
  for (let line = 0; line < sampleLines; line++) sample.push(fillerLine(random, line))
  const probe = await client.chat([{ role: 'user', content: `${sample.join('\n')}\n\n${question}` }], { ...plain, maxTokens: 1 })
  if (probe.promptTokens === null) throw new Error('Server did not report prompt token usage')
  const lineCount = Math.ceil((minPromptTokens / (probe.promptTokens / sampleLines)) * 1.03)

  // Each request gets its own filler text, so the server cannot share cached context between them.
  const prompts: { index: number; code: string; text: string }[] = []
  for (let index = 0; index < concurrency; index++) {
    const code = hexCode(random, 'CTX')
    const lines: string[] = []
    for (let line = 0; line < lineCount; line++) {
      lines.push(fillerLine(random, line))
      if (line === Math.floor(lineCount / 2)) lines.push(`The verification code for this log is ${code}.`)
    }
    prompts.push({ index, code, text: `${lines.join('\n')}\n\n${question}` })
  }

  const started = performance.now()
  const requests = await Promise.all(
    prompts.map(async (prompt): Promise<ContextRequestResult> => {
      const requestStarted = performance.now()
      try {
        const reply = await client.chat([{ role: 'user', content: prompt.text }], plain)
        const leaked = prompts.some((other) => other.index !== prompt.index && reply.content.includes(other.code))
        return {
          index: prompt.index,
          promptTokens: reply.promptTokens,
          found: reply.content.includes(prompt.code) && !leaked,
          detail: reply.content.slice(0, 120),
          latencyMs: Math.round(performance.now() - requestStarted),
        }
      } catch (error) {
        return {
          index: prompt.index,
          promptTokens: null,
          found: false,
          detail: error instanceof Error ? error.message : String(error),
          latencyMs: Math.round(performance.now() - requestStarted),
        }
      }
    }),
  )
  const wallMs = Math.round(performance.now() - started)
  const passed = requests.every((request) => request.found && request.promptTokens !== null && request.promptTokens >= minPromptTokens)
  return { concurrency, minPromptTokens, requests, wallMs, passed }
}

// ---------- entry point ----------

async function main(): Promise<number> {
  const configPath = process.argv[2]
  if (!configPath) throw new UsageError('Usage: node gate.ts <config.json>')
  const config = loadConfig(configPath)
  const baseUrl = requiredEnv('MODEL_BASE_URL')
  const modelId = requiredEnv('MODEL_ID')
  const apiKey = requiredEnv('MODEL_API_KEY')
  const client = createClient(baseUrl, modelId, apiKey, config)
  const random = seededRandom(config.seed)

  process.stderr.write('auth: checking key handling\n')
  const auth = await checkAuth(client, apiKey)

  const served = asArray(asRecord(await client.getJson('/models')).data).map((entry) => {
    const model = asRecord(entry)
    return { id: asString(model.id), maxModelLen: typeof model.max_model_len === 'number' ? model.max_model_len : null }
  })
  const modelListed = served.some((model) => model.id === modelId)

  const toolCalling = await checkToolCalling(client, config, random)
  process.stderr.write('context: sending long prompts together\n')
  const context = await checkContext(client, config, random)

  const failures: string[] = []
  if (!auth.passed) failures.push('authentication')
  if (!modelListed) failures.push('model not listed')
  if (!toolCalling.passed) failures.push('tool calling')
  if (!context.passed) failures.push('context')

  const report = {
    gate: failures.length === 0 ? 'pass' : 'fail',
    failures,
    modelId,
    served,
    config,
    auth,
    toolCalling,
    context,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.stderr.write(`gate: ${report.gate}${failures.length ? ` (${failures.join(', ')})` : ''}\n`)
  return failures.length === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`gate could not run: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  },
)
