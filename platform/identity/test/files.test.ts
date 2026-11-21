// I3 to I5: what the tracked files of platform/identity/ promise about images, secrets and variables.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (relative: string): string => readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8')

const REALM = 'platform/identity/realm/lab-realm.json'

test('I3. Keycloak is referenced only by digest, and the gate uses the toolchain Node digest', () => {
  const compose = read('platform/identity/compose.yaml')
  const images = [...compose.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.ok(images.length >= 1, 'platform/identity/compose.yaml names no image')
  for (const image of images) {
    assert.match(image ?? '', /^quay\.io\/keycloak\/keycloak@sha256:[0-9a-f]{64}$/, `not pinned by digest: ${image}`)
  }

  const nodePins = (text: string): string[] => [...new Set(text.match(/node@sha256:[0-9a-f]{64}/g) ?? [])]
  const inToolchain = nodePins(read('toolchain/Dockerfile'))
  const inGate = nodePins(read('platform/identity/gate/compose.yaml'))
  assert.equal(inToolchain.length, 1, `toolchain/Dockerfile pins: ${inToolchain.join(', ')}`)
  assert.deepEqual(inGate, inToolchain)
  assert.doesNotMatch(read('platform/identity/gate/compose.yaml'), /FROM\s+node(?!@sha256:)/, 'the gate names an unpinned Node image')
})

test('I7. setup.sh references Node only by the toolchain Node digest', () => {
  const setup = read('platform/identity/setup.sh')
  const inToolchain = [...new Set(read('toolchain/Dockerfile').match(/node@sha256:[0-9a-f]{64}/g) ?? [])]
  const inSetup = [...new Set(setup.match(/node@sha256:[0-9a-f]{64}/g) ?? [])]
  assert.equal(inToolchain.length, 1, `toolchain/Dockerfile pins: ${inToolchain.join(', ')}`)
  assert.deepEqual(inSetup, inToolchain)
  // A Node image by tag (node:22, node:lts-slim, node:latest, ...). node:crypto and the like are modules, not images.
  const byTag = setup.match(/\bnode:(?:\d[\w.-]*|lts[\w.-]*|current[\w.-]*|latest|bookworm[\w.-]*|bullseye[\w.-]*|alpine[\w.-]*|slim[\w.-]*)/g) ?? []
  assert.deepEqual(byTag, [], `setup.sh names a Node image by tag: ${byTag.join(', ')}`)
  const otherDigests = setup.match(/\bnode@(?!sha256:[0-9a-f]{64}\b)\S+/g) ?? []
  assert.deepEqual(otherDigests, [], `setup.sh names a Node image by a malformed digest: ${otherDigests.join(', ')}`)
})

test('I4. every user credential value and every client secret in the realm file is a ${NAME} placeholder', () => {
  type Realm = {
    clients?: { clientId: string; secret?: unknown }[]
    users?: { username: string; credentials?: { value?: unknown }[] }[]
  }
  const realm = JSON.parse(read(REALM)) as Realm
  const placeholder = /^\$\{[A-Z][A-Z0-9_]*\}$/
  const values: [string, unknown][] = []
  for (const client of realm.clients ?? []) {
    if ('secret' in client) values.push([`client ${client.clientId} secret`, client.secret])
  }
  for (const user of realm.users ?? []) {
    for (const credential of user.credentials ?? []) values.push([`user ${user.username} credential`, credential.value])
  }
  assert.ok(values.length >= 3, 'expected the desk client secret and both users\' passwords')
  for (const [where, value] of values) {
    assert.ok(typeof value === 'string' && placeholder.test(value), `${where} is not a \${NAME} placeholder`)
  }
})

test('I5. the variables used by compose.yaml and the realm file are exactly those in .env.example', () => {
  const used = new Set<string>()
  for (const match of read('platform/identity/compose.yaml').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(match[1] ?? '')
  for (const match of read(REALM).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(match[1] ?? '')

  const documented = new Set<string>()
  for (const match of read('platform/identity/.env.example').matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)) documented.add(match[1] ?? '')

  assert.deepEqual([...used].sort(), [...documented].sort())
})
