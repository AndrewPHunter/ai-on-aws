import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SETUP = fileURLToPath(new URL('../../setup.sh', import.meta.url))

// Runs setup.sh with exactly the given environment, plus PATH. The guard runs before setup needs Docker.
function runSetup(extra: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync('sh', [SETUP], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...extra }, encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

test('M9. a shell variable starting EMBED_ or RERANK_ is refused before anything else runs', () => {
  for (const name of ['EMBED_MODEL_REPO', 'RERANK_MAX_MODEL_LEN', 'EMBED_ANYTHING']) {
    const { status, stderr } = runSetup({ [name]: 'x' })
    assert.equal(status, 2, `${name}: exit ${String(status)}; ${stderr}`)
    assert.ok(stderr.includes(name), `${name} not named: ${stderr}`)
  }
  // Without such a variable the guard lets setup go on to its next check (here, Docker), so the refusal
  // above is the guard's and not something that refuses every run.
  const { stderr } = runSetup({ EMBEDDED: 'x', MY_RERANK_X: 'x' })
  assert.ok(!stderr.includes('these environment variables'), stderr)
})
