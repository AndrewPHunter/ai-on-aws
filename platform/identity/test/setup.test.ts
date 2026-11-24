// The identity piece's invariants 1 and 5 ("Always true" in platform/identity/README.md).
//
// setup.sh is run for real, from a copy in a temporary directory: it writes .env beside itself, so the live
// platform/identity/.env is never touched or read. It makes each random value with `docker run <pinned node> node -e ...`;
// the check has no Docker, so the copy is sourced by a shell that first defines a stand-in `docker` function,
// labelled as one, which runs the command setup.sh hands to `docker run` with this process's own Node.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const IDENTITY = fileURLToPath(new URL('..', import.meta.url))
const read = (relative: string): string => readFileSync(join(IDENTITY, relative), 'utf8')

// A stand-in for the docker CLI. With `refuseRun`, `docker run` fails, so a run that needs no random value is shown
// to make no Docker call for one.
const standInDocker = (refuseRun: boolean): string => `
# A stand-in for the docker CLI, for platform/identity/test/setup.test.ts only.
docker() {
  case "$1" in
    version) return 0 ;;
    run) ${refuseRun ? 'return 3' : 'while [ "$#" -gt 0 ]; do case "$1" in node@sha256:*) shift; "$@"; return ;; *) shift ;; esac; done; return 3'} ;;
    *) return 3 ;;
  esac
}
`

/** Runs a copy of setup.sh in a new directory, over `existing` as its .env when given; returns its exit and the .env after. */
function runSetup(existing: string | null, refuseRun = false): { status: number | null; stderr: string; env: string } {
  const root = mkdtempSync(join(tmpdir(), 'identity-setup-'))
  try {
    const dir = join(root, 'identity')
    mkdirSync(dir)
    copyFileSync(join(IDENTITY, 'setup.sh'), join(dir, 'setup.sh'))
    copyFileSync(join(IDENTITY, '.env.example'), join(dir, '.env.example'))
    if (existing !== null) writeFileSync(join(dir, '.env'), existing, { mode: 0o600 })
    // $0 is the copy's path, which setup.sh reads to find its directory.
    const result = spawnSync('sh', ['-c', `${standInDocker(refuseRun)}\n. "$0"\n`, join(dir, 'setup.sh')], {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
    let env = ''
    try {
      env = readFileSync(join(dir, '.env'), 'utf8')
    } catch {
      env = ''
    }
    return { status: result.status, stderr: result.stderr, env }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const valueOf = (text: string, name: string): string => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? ''

test('identity 1. every secret and password in the realm file is a placeholder that setup.sh knows, .env.example names and compose passes', () => {
  const realmText = read('realm/lab-realm.json')

  // Every secret and credential value, wherever it sits, is a ${NAME} placeholder.
  const values: unknown[] = []
  const walk = (node: unknown, inCredentials: boolean): void => {
    if (Array.isArray(node)) node.forEach((entry) => walk(entry, inCredentials))
    else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'secret' || (inCredentials && key === 'value')) values.push(value)
        walk(value, key === 'credentials')
      }
    }
  }
  walk(JSON.parse(realmText), false)
  assert.ok(values.length > 0, 'the realm file holds no secret')
  for (const value of values) assert.match(String(value), /^\$\{[A-Z][A-Z0-9_]*\}$/, 'a secret in the realm file is not a placeholder')

  const names = [...new Set([...realmText.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1] ?? ''))]
  const fresh = runSetup(null)
  assert.equal(fresh.status, 0, `setup.sh exited ${String(fresh.status)}: ${fresh.stderr}`)
  const written = fresh.env
  const example = read('.env.example')
  const compose = read('compose.yaml')
  for (const name of names) {
    assert.notEqual(valueOf(written, name), '', `setup.sh writes no value for ${name}`)
    assert.match(example, new RegExp(`^${name}=`, 'm'), `.env.example does not name ${name}`)
    assert.match(compose, new RegExp(`^\\s+${name}: \\$\\{${name}[:}]`, 'm'), `compose.yaml does not pass ${name} to the provider`)
  }
})

const PEOPLE: Record<string, string> = {
  IDENTITY_DANA_PASSWORD: 'dana.desk',
  IDENTITY_MORGAN_PASSWORD: 'morgan.medinfo',
  IDENTITY_RILEY_PASSWORD: 'riley.reviewer',
  IDENTITY_AVERY_PASSWORD: 'avery.auditor',
}

test("identity 5. running set-up again changes no value that is already set, and writes a value for each variable that has none; the four people's passwords are always their usernames", () => {
  const names = [...read('.env.example').matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? '')
  // The file as compose reads it: each name's lines, the last of which gives its value.
  const linesOf = (text: string, name: string): string[] =>
    [...text.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].map((match) => match[1] ?? '')
  const runAgainOver = (before: string): string => {
    const after = runSetup(before).env
    assert.ok(after.startsWith(before), 'a line that was already in .env was changed or moved')
    for (const name of names) {
      const lines = linesOf(after, name)
      assert.equal(lines.length, 1, `.env has ${String(lines.length)} lines for ${name}`)
      assert.notEqual(lines.at(-1) ?? '', '', `set-up wrote no value for ${name}`)
      const set = linesOf(before, name).at(-1)
      if (set) assert.equal(lines.at(-1), set, `set-up changed the value of ${name}`)
    }
    return after
  }

  const whole = runSetup(null).env
  assert.notEqual(whole, '', 'setup.sh wrote no .env')
  for (const [name, username] of Object.entries(PEOPLE)) assert.equal(valueOf(whole, name), username, `${name} is not ${username}`)
  assert.equal(runAgainOver(whole), whole)

  // The same file holding another value for one person's password: that line alone becomes the username, in place,
  // with `docker run` refused.
  const other = whole.replace(/^IDENTITY_MORGAN_PASSWORD=.*$/m, 'IDENTITY_MORGAN_PASSWORD=another-value')
  assert.notEqual(other, whole)
  const replaced = runSetup(other, true)
  assert.equal(replaced.status, 0, `setup.sh exited ${String(replaced.status)}: ${replaced.stderr}`)
  assert.equal(replaced.env, whole)

  // The same file lacking two variables, as a checkout from before they were added is.
  const lacking = ['IDENTITY_DANA_PASSWORD', 'IDENTITY_ORCHESTRATOR_CLIENT_SECRET']
  const partial = lacking.reduce((text, name) => text.replace(new RegExp(`^${name}=.*\\n`, 'm'), ''), whole)
  assert.notEqual(partial, whole)
  runAgainOver(partial)
})
