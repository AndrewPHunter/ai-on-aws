// Health verdict while waiting for the server to start (contract section 3, step 11). Pure: the container's
// state as `docker inspect -f '{{.State.Status}} {{.State.Health.Status}}'` prints it (null when it could
// not be read) and the seconds waited so far in; wait, ready, or failed and why out.

export const HEALTH_LIMIT_SECONDS = 900

export type HealthVerdict = { verdict: 'wait' } | { verdict: 'ready' } | { verdict: 'failed'; reason: string }

export function healthVerdict(state: string | null, secondsWaited: number): HealthVerdict {
  if (state === null) return { verdict: 'failed', reason: "the server container's state could not be read (docker inspect failed)" }
  const trimmed = state.trim()
  if (trimmed === 'running healthy') return { verdict: 'ready' }
  if (trimmed === 'running unhealthy') return { verdict: 'failed', reason: 'the server container is running but its health check reports unhealthy' }
  if (trimmed.startsWith('exited')) return { verdict: 'failed', reason: `the server container exited (state: ${trimmed})` }
  if (trimmed !== 'running starting') return { verdict: 'failed', reason: `the server container is in an unexpected state: ${trimmed}` }
  if (secondsWaited >= HEALTH_LIMIT_SECONDS) {
    return { verdict: 'failed', reason: `the server did not become healthy within ${HEALTH_LIMIT_SECONDS} seconds (waited ${secondsWaited})` }
  }
  return { verdict: 'wait' }
}

// The same verdict on Metal, where a server is a process of the Mac: whether its process is alive, as
// model/metal/servers.sh status reports it, and whether its /health answered.
export function metalHealthVerdict(alive: boolean, healthy: boolean, secondsWaited: number): HealthVerdict {
  if (!alive) return { verdict: 'failed', reason: 'the server process ended' }
  if (healthy) return { verdict: 'ready' }
  if (secondsWaited >= HEALTH_LIMIT_SECONDS) {
    return { verdict: 'failed', reason: `the server did not answer /health within ${HEALTH_LIMIT_SECONDS} seconds (waited ${secondsWaited})` }
  }
  return { verdict: 'wait' }
}
