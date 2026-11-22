// I3 to I8: what the tracked files of platform/identity/ promise about images, secrets and variables, and (I8) that
// the gates of platform/identity/ and knowledge/ run images named for the checkout they were built from.
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

test('I8. no gate compose file names an image with a fixed tag, and each gate script derives the tag from the checkout', () => {
  for (const file of ['platform/identity/gate/compose.yaml', 'knowledge/gate/compose.yaml']) {
    const images = [...read(file).matchAll(/^\s*image:\s*(.+?)\s*$/gm)].map((match) => match[1] ?? '')
    assert.ok(images.length >= 1, `${file} names no image`)
    for (const image of images) {
      // The tag (or the whole name) comes from a variable the script must set; there is no default to fall back on.
      assert.match(image, /\$\{[A-Z_]+:\?/, `${file} names an image with a fixed tag: ${image}`)
    }
  }

  // Both identity gate scripts name the image and the compose project from the checkout's path, as toolchain/check.sh does.
  for (const script of ['platform/identity/gate.sh', 'platform/identity/stack-gate.sh']) {
    const text = read(script)
    assert.match(text, /checkout=\$\(printf '%s' "\$repo_dir" \| cksum \| cut -d ' ' -f 1\)/, `${script} must derive the checkout from its path`)
    assert.match(text, /IDENTITY_GATE_IMAGE_TAG="checkout-\$checkout"/, `${script} must name the tag for the checkout`)
    assert.match(text, /gate_project="ai-on-aws-identity-gate-\$checkout"/, `${script} must name the project for the checkout`)
    assert.match(text, /say "image ai-on-aws-identity-gate:\$IDENTITY_GATE_IMAGE_TAG"/, `${script} must print the image it uses`)
    const runs = [...text.matchAll(/docker compose (?:-p "\$gate_project" )?-f "\$identity_dir\/gate\/compose\.yaml"/g)].map((match) => match[0])
    assert.ok(runs.length >= 1 && runs.every((run) => run.includes('-p "$gate_project"')), `${script} runs the gate's compose file outside its own project`)
  }

  // The knowledge gate takes its image from knowledge/lib.sh, named for the checkout, and runs in a project of its own.
  const lib = read('knowledge/lib.sh')
  assert.match(lib, /checkout=\$\(printf '%s' "\$repo_dir" \| cksum \| cut -d ' ' -f 1\)/)
  assert.match(lib, /KNOWLEDGE_IMAGE="knowledge-corpus:checkout-\$checkout"/)
  const knowledgeGate = read('knowledge/gate.sh')
  assert.match(knowledgeGate, /gate_project="ai-on-aws-knowledge-gate-\$checkout"/)
  assert.match(knowledgeGate, /docker compose -p "\$gate_project" -f "\$knowledge_dir\/gate\/compose\.yaml"/)
  assert.match(knowledgeGate, /say "image \$KNOWLEDGE_IMAGE"/)
})

test('I5. the variables used by compose.yaml and the realm file are exactly those in .env.example', () => {
  const used = new Set<string>()
  for (const match of read('platform/identity/compose.yaml').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(match[1] ?? '')
  for (const match of read(REALM).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(match[1] ?? '')

  const documented = new Set<string>()
  for (const match of read('platform/identity/.env.example').matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)) documented.add(match[1] ?? '')

  assert.deepEqual([...used].sort(), [...documented].sort())
})
