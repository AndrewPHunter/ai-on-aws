import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseArgs } from '../lib/args.ts'

const TIERS = ['large', 'medium', 'small']
const HOST = 'ssh://user@machine'

test('1. each invalid flag combination is a usage error whose message names the flag', () => {
  const cases: { argv: string[]; flag: string }[] = [
    { argv: ['--no-such-flag'], flag: '--no-such-flag' },
    { argv: ['--cache-dir', '/c', 'stray'], flag: 'stray' },
    { argv: ['--cache-dir'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '--check'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/c', '--bind'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--port'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--host'], flag: '--host' },
    { argv: ['--cache-dir', '/c', '--tier'], flag: '--tier' },
    { argv: ['--cache-dir', '/a', '--cache-dir', '/b'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/c', '--port', '1', '--port', '2'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--check', '--check'], flag: '--check' },
    { argv: ['--keep-env', '--keep-env'], flag: '--keep-env' },
    { argv: [], flag: '--cache-dir' },
    { argv: ['--check'], flag: '--cache-dir' },
    { argv: ['--cache-dir', 'relative/dir'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '~/models'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/srv/my models'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/srv/tab\there'], flag: '--cache-dir' },
    { argv: ['--cache-dir', "/srv/it's"], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/srv/"x"'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/srv/a#b'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/srv/$HOME'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/srv/a\\b'], flag: '--cache-dir' },
    { argv: ['--cache-dir', '/c', '--host', HOST], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--host', HOST, '--bind', '127.0.0.1'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--host', HOST, '--bind', '127.20.30.40'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--bind', 'localhost'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--bind', '256.1.1.1'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--bind', '192.0.2'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--bind', '192.0.2.1.5'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--bind', '::1'], flag: '--bind' },
    { argv: ['--cache-dir', '/c', '--port', '0'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--port', '65536'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--port', 'http'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--port', '80.5'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--port', '-1'], flag: '--port' },
    { argv: ['--keep-env', '--cache-dir', '/c'], flag: '--cache-dir' },
    { argv: ['--keep-env', '--bind', '192.0.2.5'], flag: '--bind' },
    { argv: ['--keep-env', '--port', '8000'], flag: '--port' },
    { argv: ['--cache-dir', '/c', '--tier', 'huge'], flag: '--tier' },
    { argv: ['--keep-env', '--tier', 'Large'], flag: '--tier' },
  ]
  for (const { argv, flag } of cases) {
    const result = parseArgs(argv, TIERS)
    assert.equal(result.ok, false, `accepted: ${argv.join(' ')}`)
    if (!result.ok) assert.ok(result.message.includes(flag), `"${result.message}" does not name ${flag} (argv: ${argv.join(' ')})`)
  }
})

test('2. valid flag sets give the exact options, with the defaults when not given', () => {
  const cases: { argv: string[]; options: object }[] = [
    {
      argv: ['--cache-dir', '/srv/models'],
      options: { cacheDir: '/srv/models', bind: '127.0.0.1', port: 8000, embedPort: 8001, rerankPort: 8002, host: null, tier: null, check: false, keepEnv: false },
    },
    {
      argv: ['--check', '--port', '1', '--cache-dir', '/c'],
      options: { cacheDir: '/c', bind: '127.0.0.1', port: 1, embedPort: 8001, rerankPort: 8002, host: null, tier: null, check: true, keepEnv: false },
    },
    {
      argv: ['--cache-dir', '/c', '--bind', '0.0.0.0', '--port', '65535', '--tier', 'medium'],
      options: { cacheDir: '/c', bind: '0.0.0.0', port: 65535, embedPort: 8001, rerankPort: 8002, host: null, tier: 'medium', check: false, keepEnv: false },
    },
    {
      argv: ['--cache-dir', '/data/models', '--bind', '192.0.2.20', '--port', '8443', '--host', HOST, '--tier', 'small', '--check'],
      options: { cacheDir: '/data/models', bind: '192.0.2.20', port: 8443, embedPort: 8001, rerankPort: 8002, host: HOST, tier: 'small', check: true, keepEnv: false },
    },
    {
      argv: ['--keep-env'],
      options: { cacheDir: null, bind: null, port: null, embedPort: null, rerankPort: null, host: null, tier: null, check: false, keepEnv: true },
    },
    {
      argv: ['--tier', 'large', '--keep-env', '--host', HOST, '--check'],
      options: { cacheDir: null, bind: null, port: null, embedPort: null, rerankPort: null, host: HOST, tier: 'large', check: true, keepEnv: true },
    },
  ]
  for (const { argv, options } of cases) {
    assert.deepEqual(parseArgs(argv, TIERS), { ok: true, options }, argv.join(' '))
  }
})

test('M5. --embed-port and --rerank-port are parsed with their defaults; equal ports are refused; neither is accepted with --keep-env', () => {
  const parsed = (argv: string[]): object => {
    const result = parseArgs(argv, TIERS)
    if (!result.ok) throw new Error(result.message)
    const { port, embedPort, rerankPort } = result.options
    return { port, embedPort, rerankPort }
  }
  assert.deepEqual(parsed(['--cache-dir', '/c']), { port: 8000, embedPort: 8001, rerankPort: 8002 })
  assert.deepEqual(parsed(['--cache-dir', '/c', '--embed-port', '9001', '--rerank-port', '9002']), { port: 8000, embedPort: 9001, rerankPort: 9002 })
  assert.deepEqual(parsed(['--cache-dir', '/c', '--port', '7000', '--embed-port', '7001']), { port: 7000, embedPort: 7001, rerankPort: 8002 })

  const refused: { argv: string[]; names: string[] }[] = [
    { argv: ['--cache-dir', '/c', '--embed-port', '8000'], names: ['--port', '--embed-port'] },
    { argv: ['--cache-dir', '/c', '--rerank-port', '8000'], names: ['--port', '--rerank-port'] },
    { argv: ['--cache-dir', '/c', '--embed-port', '8002'], names: ['--embed-port', '--rerank-port'] },
    { argv: ['--cache-dir', '/c', '--port', '8001'], names: ['--port', '--embed-port'] },
    { argv: ['--cache-dir', '/c', '--port', '9000', '--embed-port', '9001', '--rerank-port', '9001'], names: ['--embed-port', '--rerank-port'] },
    { argv: ['--cache-dir', '/c', '--embed-port', '0'], names: ['--embed-port'] },
    { argv: ['--cache-dir', '/c', '--rerank-port', '65536'], names: ['--rerank-port'] },
    { argv: ['--cache-dir', '/c', '--embed-port'], names: ['--embed-port'] },
    { argv: ['--keep-env', '--embed-port', '9001'], names: ['--embed-port'] },
    { argv: ['--keep-env', '--rerank-port', '9002'], names: ['--rerank-port'] },
  ]
  for (const { argv, names } of refused) {
    const result = parseArgs(argv, TIERS)
    assert.equal(result.ok, false, `accepted: ${argv.join(' ')}`)
    if (!result.ok) for (const name of names) assert.ok(result.message.includes(name), `"${result.message}" does not name ${name}`)
  }
})
