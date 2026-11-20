import { failureText, useStatus } from '../api.ts';
import { Loading, PieceBadge, Problem } from '../components.tsx';
import { formatTime } from '../format.ts';

export function SystemPage() {
  const status = useStatus();

  return (
    <div className="column">
      <header className="pagehead">
        <h1>System</h1>
        <p className="pagehead__lead">
          Each part the desk depends on, and whether it answers right now. Everything runs on this machine.
        </p>
      </header>

      {status.isPending ? <Loading what="the system’s state" /> : null}
      {status.isError ? <Problem>{failureText(status.error)}</Problem> : null}

      {status.data === undefined ? null : (
        <>
          <ul className="pieces">
            {status.data.pieces.map((piece) => (
              <li key={piece.id} className={`piece piece--${piece.state}`}>
                <div className="piece__head">
                  <h2>{piece.name}</h2>
                  <PieceBadge state={piece.state} />
                </div>
                <p className="piece__role">{piece.role}</p>
                {piece.detail === '' ? null : <p className="piece__detail">{piece.detail}</p>}
              </li>
            ))}
          </ul>
          <p className="footnote">Checked at {formatTime(status.data.checked_at)}. Checked again every ten seconds.</p>
        </>
      )}
    </div>
  );
}
