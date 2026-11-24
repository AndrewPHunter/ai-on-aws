// The four synthetic people who sign in at the desk, and what each may do there. Static: the facts are the
// identity provider's realm (platform/identity/README.md) and the client's "What each person sees".

type Person = {
  username: string;
  name: string;
  role: string;
  may: string;
  scopes: readonly string[];
};

const PEOPLE: readonly Person[] = [
  {
    username: 'dana.desk',
    name: 'Dana Desk',
    role: 'desk',
    may: 'Enter inquiries and send them to the two intake agents and the orchestrator. Sees only the inquiries this account entered.',
    scopes: ['agents:intake', 'agents:orchestrator'],
  },
  {
    username: 'morgan.medinfo',
    name: 'Morgan Medinfo',
    role: 'medical-information',
    may: 'Everything Dana may do, and send inquiries to the label expert too.',
    scopes: ['agents:intake', 'agents:expert', 'agents:orchestrator'],
  },
  {
    username: 'riley.reviewer',
    name: 'Riley Reviewer',
    role: 'safety-reviewer',
    may: 'Read adverse event cases and decide them: approve, reject or ask for information. Runs no agent.',
    scopes: ['cases:read', 'cases:review'],
  },
  {
    username: 'avery.auditor',
    name: 'Avery Auditor',
    role: 'auditor',
    may: 'Read cases and every person’s runs with their steps. Decides nothing and runs no agent.',
    scopes: ['cases:read', 'traces:read'],
  },
];

export function PeoplePage() {
  return (
    <>
      <div className="lab-intro">
        <div>
          <h1>People</h1>
          <p className="lab-lede">
            The four people who sign in at the desk. All of them are synthetic. Each signs in with their username as
            the password. What each may do comes from the scopes their role is granted at sign-in.
          </p>
        </div>
      </div>

      <div className="lab-panel">
        <div className="lab-scroll">
          <table className="lab-table">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">What they may do at the desk</th>
                <th scope="col">Scopes</th>
              </tr>
            </thead>
            <tbody>
              {PEOPLE.map((person) => (
                <tr key={person.username}>
                  <th scope="row" className="lab-mono">
                    {person.username}
                  </th>
                  <td>{person.name}</td>
                  <td className="lab-mono">{person.role}</td>
                  <td>{person.may}</td>
                  <td className="lab-mono">
                    {person.scopes.map((scope) => (
                      <span key={scope} className="lab-scope">
                        {scope}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
