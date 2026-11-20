import assert from 'node:assert/strict'
import { test } from 'node:test'

import { exitCodeFor, OUTCOME_EXIT_CODES, type Outcome } from '../lib/outcome.ts'

test('18. each outcome maps to its exit code as in contract section 4, including the tool failing', () => {
  const expected: Record<Outcome, number> = {
    ok: 0,
    download_failed: 1,
    not_healthy: 1,
    capacity_short: 1,
    log_unreadable: 1,
    gate_failed: 1,
    usage: 2,
    docker_unreachable: 2,
    env_present: 2,
    env_missing: 2,
    server_running: 2,
    cache_dir_missing: 2,
    tiers_invalid: 2,
    image_unavailable: 2,
    probe_unreadable: 2,
    disk_probe_failed: 2,
    repository_invalid: 2,
    env_write_failed: 2,
    report_remove_failed: 2,
    tool_failed: 2,
    no_gpu: 3,
    multiple_gpus: 3,
    driver_too_old: 3,
    gpu_too_old: 3,
    insufficient_memory: 3,
    insufficient_disk: 3,
  }
  // No outcome exists without a decided code, and every decided code holds.
  assert.deepEqual(Object.keys(OUTCOME_EXIT_CODES).sort(), Object.keys(expected).sort())
  for (const [outcome, code] of Object.entries(expected)) assert.equal(exitCodeFor(outcome as Outcome), code, outcome)
})
