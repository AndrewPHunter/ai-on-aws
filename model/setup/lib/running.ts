// The running-server guard (setup step 4). Pure: the compose service of each running container of the lab's
// project, one per line, as
//   docker ps --filter label=com.docker.compose.project=<project> --filter status=running \
//     --format '{{.Label "com.docker.compose.service"}}'
// prints it, in; the lab's servers among them out. Any of the three makes the card look smaller than it is.

export const SERVER_SERVICES = ['chat', 'embed', 'rerank'] as const

export type RunningVerdict = { ok: true } | { ok: false; running: string[]; message: string }

export function runningVerdict(psOutput: string): RunningVerdict {
  const listed = new Set(psOutput.split('\n').map((line) => line.trim()))
  const running = SERVER_SERVICES.filter((service) => listed.has(service))
  if (running.length === 0) return { ok: true }
  const which = running.length === 1 ? `the lab's ${running.join('')} server is` : `the lab's ${running.join(', ')} servers are`
  return {
    ok: false,
    running,
    message: `${which} already running on the GPU machine. ${running.length === 1 ? 'Its' : 'Their'} memory would make the card look smaller than it is.`,
  }
}
