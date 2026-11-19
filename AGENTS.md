# Working in this lab

## Purpose

A local, reproducible lab for exploring Amazon Bedrock AgentCore and a
stand-in for Bedrock Knowledge Bases, backed by a self-hosted model served
with vLLM. The repository is public, and people are pointed at it: what it
says works must work, from a clean machine, by the steps it gives.

Depth over breadth. The areas the lab goes deep on are agents on AgentCore,
tool calling and its reliability, retrieval, evaluation and security.

## Rules

- **Nothing private in a tracked file.** No secret, key, network address,
  home path or host name. Machine-specific values live in ignored `.env`
  files, with an `.env.example` beside each that names every variable.
- **Everything runs in containers.** No language toolchain is assumed on
  the host: only a shell and Docker. Images are pinned by digest, and
  dependencies by a committed lockfile generated in a container.
- **Every setting is explicit.** Configuration is passed in by name. Nothing
  depends on a default of the machine, the shell or the user.
- **Keep designed, implemented and measured apart** in what you write.
  Measured means: by the gate or a test, through the repository's own files,
  on hardware that is named. A figure worked out from another figure is
  derived, and is labelled so.
- **No facades.** No stub, placeholder or simulated step on a real path, and
  no fallback that hides a failure. What cannot be done fails, and says why.
- **One intent per change.** A change of format, a new capability and a
  clean-up are separate changes.
- **Do not commit or push without the user's word.**

## Roles

The lab is worked by a planner and three kinds of agent. The agents are
defined under `.claude/agents/`.

| Role | Who | Owns |
|---|---|---|
| Planner | the user and the main session, together | what is built and in what order; the contract and the test list for each piece of work; anything run on the model host; commits |
| Researcher | a subagent, read-only | evidence from primary sources, each fact cited |
| Implementer | a subagent | the code for one approved piece of work, inside the files it is given |
| Reviewer | a subagent, read-only, started new for every review | one pass over a change; a list of findings |

How a piece of work moves:

1. The planner agrees the contract with the user: what the piece promises to
   its callers, how it fails, and the closed list of tests. Where a decision
   rests on how something outside the repository behaves, a researcher reads
   the source first.
2. The implementer gets a brief carrying that contract and test list in
   full, and the list of files it may create or edit. An agent sees only its
   brief and the repository, never the planning conversation.
3. The planner reads the implementer's report. A check that was not run, or
   that failed, is a stop.
4. A reviewer, started new, gets the changed files and the contract, and no
   account of what the planner or the implementer concluded. It reviews once.
5. Findings go back to the implementer as one correction pass. A finding
   that would change the contract or add a test goes to the user.
6. The planner reports to the user what is implemented, what is measured and
   by which command, and what is open, and waits for the word to commit.

Only the planner runs anything on the model host: starting or stopping a
server, downloading weights, measuring. No agent opens a `.env` file or
anything under a `secrets/` directory.

## Documents

- `docs/architecture/` describes the system as it is: what is always true,
  what moves where, who owns what. Diagrams and tables over prose. No plans,
  no status words, no alternatives considered, no sources. Git history is the
  record of how it got here.
- `docs/write-ups/` holds what was learned by building and measuring: the
  question, what was run, the result, and the sources. A write-up names the
  hardware and the revision it was measured on.

## Testing

- A test asserts a contract: something a caller can rely on, stated where
  the caller would read it. If the implementation changes and no contract
  does, no test should need to change.
- Tests are deterministic. They need no network, no GPU and no model server,
  and they pass in any order. Time, randomness and input/output are passed
  in, not reached for.
- Logic that sits behind a container, a device or a server is a pure
  function with a unit test. The path itself is then checked for real, on
  hardware, by the gate.
- A pass against a mock that cannot fail is not a pass. Do not mock away the
  failure a test exists to catch.
- The test list for a piece of work is agreed before the code is written.
  Each test names the change it alone would catch.

## Recurring mistakes

Entries here are errors caught more than once. Read them as rules. Add an
entry when the same mistake comes back.

None yet.
