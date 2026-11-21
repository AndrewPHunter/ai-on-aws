import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')

// The stages whose files end up in a piece's image when it runs, or are built into it.
const RUN_TIME_STAGES = ['run-deps', 'run', 'web-build', 'run-web']

// Each COPY line, with the stage it is in.
function copies(): { stage: string; sources: string[] }[] {
  const found: { stage: string; sources: string[] }[] = []
  let stage = ''
  for (const line of dockerfile.split('\n')) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line)
    if (from !== null) {
      stage = from[1] ?? ''
      continue
    }
    if (!/^COPY\s/i.test(line)) continue
    const words = line.trim().split(/\s+/).slice(1).filter((word) => !word.startsWith('--'))
    found.push({ stage, sources: words.slice(0, -1) })
  }
  return found
}

test('T4. every COPY of shared in a run-time stage of toolchain/Dockerfile names shared/*.ts, not the folder', () => {
  const ofShared = copies().filter(({ stage, sources }) => RUN_TIME_STAGES.includes(stage) && sources.some((source) => source.split('/')[0] === 'shared'))
  assert.ok(ofShared.some(({ stage }) => stage === 'run'), 'the run stage copies nothing from shared/')
  for (const { stage, sources } of ofShared) {
    for (const source of sources.filter((each) => each.split('/')[0] === 'shared')) {
      assert.equal(source, 'shared/*.ts', `stage ${stage} copies ${source}`)
    }
  }
})
