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

// The same guard on Metal, where the servers are processes of the Mac and model/.env may be gone or another's.
// Pure: every process as `ps -A -ww -o pid= -o command=` prints it (its id, then its command line) in; the lab's
// servers among them out: each process whose command runs <dir>/vllm-metal/venv/bin/vllm serve, the environment
// setup makes under any cache directory, one per server.
export type MetalRunningVerdict = { ok: true } | { ok: false; pids: number[]; message: string }

const METAL_SERVER = /\/vllm-metal\/venv\/bin\/vllm serve(\s|$)/

export function metalRunningVerdict(psOutput: string): MetalRunningVerdict {
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*([0-9]+)\s+(.*)$/.exec(line)
    if (match !== null && METAL_SERVER.test(match[2] ?? '')) pids.push(Number(match[1]))
  }
  if (pids.length === 0) return { ok: true }
  return {
    ok: false,
    pids,
    message:
      `${pids.length === 1 ? 'a server' : `${pids.length} servers`} of the lab ${pids.length === 1 ? 'is' : 'are'} already running on this Mac ` +
      `(process ${pids.join(', ')}), holding memory and ports setup would give the servers it starts. Stop them with ` +
      'model/metal/servers.sh stop, or, when model/.env is no longer theirs, by ending those processes (kill <process>).',
  }
}
