// F10. The scripts and any compose file reference Node only by the same digest as toolchain/Dockerfile; and the
// tracked manifest and benchmark pin, once they exist, pass the schema.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

import { validateBenchmarkPin, validateManifest } from '../src/schema.ts'

const knowledge = new URL('../', import.meta.url)
const read = (url: URL): string => readFileSync(url, 'utf8')
const digests = (text: string): string[] => [...text.matchAll(/node@sha256:[0-9a-f]{64}/g)].map((match) => match[0])

const toolchainDigest = (): string => {
  const found = [...new Set(digests(read(new URL('../toolchain/Dockerfile', knowledge))))]
  assert.equal(found.length, 1, `toolchain/Dockerfile must name exactly one Node digest: ${found.join(', ')}`)
  return found[0] ?? ''
}

test('F10. every script and compose file of knowledge/ gets Node only from the toolchain digest', () => {
  const pinned = toolchainDigest()
  const files = readdirSync(knowledge).filter((name) => name.endsWith('.sh') || /^compose.*\.ya?ml$/.test(name))
  assert.ok(files.includes('pin.sh') && files.includes('fetch.sh') && files.includes('census.sh') && files.includes('lib.sh'))

  for (const name of files) {
    const text = read(new URL(name, knowledge))
    for (const digest of digests(text)) assert.equal(digest, pinned, `${name} names another Node digest`)
    // Any other way of naming a Node image: a tag, or no tag at all.
    const loose = [...text.matchAll(/\bnode(?::[\w.-]+|@(?!sha256:[0-9a-f]{64})\S+)/g)].map((match) => match[0])
    assert.deepEqual(loose, [], `${name} names Node by something other than the pinned digest`)
    assert.doesNotMatch(text, /\bimage:\s*node\s*$/m, `${name} names the Node image without a digest`)
  }

  // The three commands run in the image built from toolchain/Dockerfile, whose base is that digest.
  const lib = read(new URL('lib.sh', knowledge))
  assert.match(lib, /docker build [^\n]*--file "\$repo_dir\/toolchain\/Dockerfile" --target run --build-arg PIECE=knowledge/)
  assert.match(lib, /-w \/repo "\$KNOWLEDGE_IMAGE" node knowledge\/src\/main\.ts "\$@"/)
  assert.equal([...lib.matchAll(/docker run /g)].length, 1, 'lib.sh must run exactly one kind of container')
  for (const name of ['pin.sh', 'fetch.sh', 'census.sh']) {
    const script = read(new URL(name, knowledge))
    assert.match(script, /^\. ".*\/lib\.sh"$/m, `${name} must use lib.sh`)
    assert.match(script, /^build_image$/m, `${name} must build the image`)
    assert.doesNotMatch(script, /docker run/, `${name} must run the tool only through lib.sh`)
  }
})

test('F10. the tracked manifest and benchmark pin, where they exist, pass the schema', (t) => {
  const manifestUrl = new URL('corpus/manifest.json', knowledge)
  const pinUrl = new URL('corpus/benchmark.json', knowledge)
  if (!existsSync(manifestUrl) && !existsSync(pinUrl)) {
    t.skip('knowledge/corpus/ has not been pinned yet')
    return
  }
  const manifest = validateManifest(JSON.parse(read(manifestUrl)))
  assert.ok(manifest.ok, manifest.ok ? '' : manifest.problems.join('\n'))
  const pin = validateBenchmarkPin(JSON.parse(read(pinUrl)))
  assert.ok(pin.ok, pin.ok ? '' : pin.problems.join('\n'))
})
