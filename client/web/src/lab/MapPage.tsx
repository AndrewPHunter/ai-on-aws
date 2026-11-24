// The map: every piece the status route reports, in the order a message passes through them, each with
// whether it answers right now.

import { Link } from 'react-router';

import type { PieceStatus, TraceSummary } from '../../../shared/api.ts';
import { formatTime } from '../format.ts';
import { useLabAgents, useLabRuns, useLabStatus } from './api.ts';
import { Empty, Failed, Loading, StateMark } from './parts.tsx';

type Group = 'front' | 'agents' | 'tools' | 'stores' | 'other';

const GROUPS: readonly { group: Group; title: string }[] = [
  { group: 'front', title: 'Front door' },
  { group: 'agents', title: 'Agents' },
  { group: 'tools', title: 'Tools' },
  { group: 'stores', title: 'Stores and models' },
];

// The ids the status route gives that are not an agent's (client/src/server.ts). An agent's piece has its
// configured id, read from the agent list; 'agents' is the piece given when no agent is configured. Any other id
// goes under Other.
const FIXED_GROUP: Readonly<Record<string, Group>> = {
  identity: 'front',
  agents: 'agents',
  'case-system': 'tools',
  retrieval: 'tools',
  search: 'stores',
  'model-chat': 'stores',
  'model-embedding': 'stores',
  'model-reranker': 'stores',
};

function groupOf(piece: PieceStatus, agentIds: ReadonlySet<string>): Group {
  if (agentIds.has(piece.id)) {
    return 'agents';
  }
  return FIXED_GROUP[piece.id] ?? 'other';
}

function PieceCard({ piece, latestRun }: { piece: PieceStatus; latestRun: TraceSummary | undefined }) {
  return (
    <article className={`lab-piece lab-piece--${piece.state}`}>
      <div className="lab-piece__head">
        <h3>{piece.name}</h3>
        <span className="lab-mono lab-piece__id">{piece.id}</span>
      </div>
      <p className="lab-piece__role">{piece.role}</p>
      <StateMark state={piece.state} />
      {piece.state === 'up' ? null : <p className="lab-piece__detail lab-mono">{piece.detail}</p>}
      {latestRun === undefined ? null : (
        <p className="lab-piece__links">
          <Link to={`/lab/runs/${encodeURIComponent(latestRun.run_id)}`}>latest run</Link>
        </p>
      )}
    </article>
  );
}

export function MapPage() {
  const status = useLabStatus();
  const agents = useLabAgents();
  const runs = useLabRuns();

  const agentIds = new Set((agents.data?.agents ?? []).map((agent) => agent.id));

  // The runs list is newest first, so the first run of an agent is its latest.
  const latestRun = new Map<string, TraceSummary>();
  for (const trace of runs.data?.traces ?? []) {
    if (!latestRun.has(trace.agent_id)) {
      latestRun.set(trace.agent_id, trace);
    }
  }

  const pieces = status.data?.pieces ?? [];
  const answering = pieces.filter((piece) => piece.state === 'up').length;
  const grouped = new Map<Group, PieceStatus[]>();
  for (const piece of pieces) {
    const group = groupOf(piece, agentIds);
    grouped.set(group, [...(grouped.get(group) ?? []), piece]);
  }
  const others = grouped.get('other') ?? [];
  const columns = others.length === 0 ? GROUPS : [...GROUPS, { group: 'other' as const, title: 'Other' }];

  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>Everything the desk runs on</h1>
          <p className="lab-lede">
            A message moves left to right: in at the front door, to an agent, to a tool, to a store or a model. Each
            piece shows whether it answers right now. This page checks again every ten seconds.
          </p>
        </div>
        {status.data === undefined || status.isError ? null : (
          <p className="lab-mono lab-checked">
            {answering} of {pieces.length} answering, checked {formatTime(status.data.checked_at)}
          </p>
        )}
      </div>

      {status.isPending || agents.isPending ? <Loading what="the state of each piece" /> : null}
      {/* A failed check shows no pieces at all, so an earlier answer is never read as the state right now. */}
      {status.isError ? (
        <Failed what="the state of each piece. The page tries again in ten seconds" error={status.error} />
      ) : null}
      {agents.isError ? (
        <Failed what="the list of agents, so agents are shown under Other" error={agents.error} />
      ) : null}
      {runs.isError ? <Failed what="the runs, so no agent links to its latest run" error={runs.error} /> : null}

      {/* The columns wait for the agent list, so an agent is never drawn under Other and then moved. */}
      {status.data === undefined || status.isError || agents.isPending ? null : (
        <div className="lab-columns">
          {columns.map(({ group, title }) => {
            const inGroup = grouped.get(group) ?? [];
            return (
              <section key={group} className="lab-column" aria-labelledby={`lab-group-${group}`}>
                <h2 id={`lab-group-${group}`}>{title}</h2>
                {inGroup.length === 0 ? (
                  <Empty>The status reports no piece here.</Empty>
                ) : (
                  inGroup.map((piece) => (
                    <PieceCard
                      key={piece.id}
                      piece={piece}
                      latestRun={group === 'agents' ? latestRun.get(piece.id) : undefined}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
