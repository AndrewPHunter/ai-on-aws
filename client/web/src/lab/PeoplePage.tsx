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
    may: 'Log inquiries, which the orchestrator handles. Sees the desk’s inbox: every inquiry logged at the desk, and the messages that arrive through the contact form.',
    scopes: ['agents:intake', 'agents:orchestrator'],
  },
  {
    username: 'morgan.medinfo',
    name: 'Morgan Medinfo',
    role: 'medical-information',
    may: 'Everything Dana may do, with the same view of the desk’s inbox, including the messages from the contact form; and ask the label expert directly.',
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
    may: 'Read cases and their history. Decides nothing and runs no agent. The scope traces:read lets this account read every run on the desk’s trace routes; no desk screen uses them.',
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
