// Outcomes of setup and the exit code each one maps to (contract section 4).
//   0  server running and shown fit (with --check: the machine would get the printed tier)
//   1  download failed, or the server started but was not shown fit
//   2  could not run
//   3  this machine is not supported or is too small

export const OUTCOME_EXIT_CODES = {
  ok: 0,

  download_failed: 1,
  not_healthy: 1,
  capacity_short: 1,
  // The server's log could not be read with docker logs, so its capacity could not be shown.
  log_unreadable: 1,
  gate_failed: 1,

  usage: 2,
  docker_unreachable: 2,
  env_present: 2,
  env_missing: 2,
  server_running: 2,
  cache_dir_missing: 2,
  tiers_invalid: 2,
  // The pinned Node image could not be run on the GPU daemon (for example, it could not be pulled).
  image_unavailable: 2,
  // nvidia-smi ran but printed something that is not the agreed format.
  probe_unreadable: 2,
  // The disk probe failed for a reason other than a missing cache directory, or printed an unexpected format.
  disk_probe_failed: 2,
  // A repository file the tool reads (a profile, .env.example, compose output) is not as expected.
  repository_invalid: 2,
  // model/.env could not be created or moved into place (nothing is left behind).
  env_write_failed: 2,
  // An earlier run's model/gate-report.json could not be removed before the download.
  report_remove_failed: 2,
  // The setup tool crashed. (A tool that cannot be started or loaded at all is also exit 2; the wrapper
  // decides that one, because the tool is not there to ask.)
  tool_failed: 2,

  no_gpu: 3,
  multiple_gpus: 3,
  driver_too_old: 3,
  gpu_too_old: 3,
  insufficient_memory: 3,
  insufficient_disk: 3,
} as const

export type Outcome = keyof typeof OUTCOME_EXIT_CODES

export function isOutcome(name: string): name is Outcome {
  return Object.prototype.hasOwnProperty.call(OUTCOME_EXIT_CODES, name)
}

export function exitCodeFor(outcome: Outcome): number {
  return OUTCOME_EXIT_CODES[outcome]
}
