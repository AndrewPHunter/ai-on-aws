# Tools

What the agents call: MCP servers and APIs, each run as its own container. This folder is for the agents' tools. The tooling that checks and packages the repository's code is in [`toolchain/`](../toolchain/README.md).

| Tool | What it is |
|---|---|
| [`case-system/`](case-system/README.md) | A system of record for adverse event cases: both intake agents open and add to cases over MCP, people review them. Every request but `GET /ping` needs an access token; deciding a case needs the scope `cases:review` |
