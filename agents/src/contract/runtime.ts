// Starts an agent on AWS's SDK server (./sdk-app.ts), with or without the local stand-in for AgentCore Runtime's
// front door (./edge.ts) in front of it, in the same process, as the layout read from LOCAL_RUNTIME_EDGE by
// ./runtime-contract.ts says. ../run/serve.ts loads this file only for an agent on the SDK server.

import { randomUUID } from 'node:crypto';

import type { AccessTokenCheck } from '../../../shared/access-token.ts';
import { createLocalEdge } from './edge.ts';
import type { Address, RuntimeLayout } from './runtime-contract.ts';
import { createSdkApp } from './sdk-app.ts';
import type { AgentIdentity, Handler } from './server.ts';

export type SdkStart = {
  // The agent's name as its start-up line gives it, such as "Label expert (Strands)".
  title: string;
  identity: AgentIdentity;
  handler: Handler;
  checkToken: AccessTokenCheck;
  layout: RuntimeLayout;
};

function at(address: Address): string {
  return `${address.host}:${address.port}`;
}

// Starts the SDK app, and the edge when the layout has one. SIGTERM and SIGINT end the process with exit 0: the
// SDK app has no way to be closed, and registers no handler of its own.
export function startOnAgentCoreSdk(start: SdkStart): void {
  const { title, layout } = start;
  const log = (line: string): void => {
    console.error(line);
  };

  const app = createSdkApp(start.identity, start.handler, start.checkToken, log);
  app.run({ host: layout.appAt.host, port: layout.appAt.port });

  if (layout.edge === 'on') {
    const edge = createLocalEdge({ upstream: layout.appAt, checkToken: start.checkToken, newId: randomUUID, log });
    edge.listen(layout.edgeAt.port, layout.edgeAt.host, () => {
      console.log(
        `${title} on the AgentCore SDK server at ${at(layout.appAt)}, behind the local stand-in for AgentCore Runtime's front door on ${at(layout.edgeAt)} (LOCAL_RUNTIME_EDGE=on)`,
      );
    });
  } else {
    console.log(`${title} on the AgentCore SDK server at ${at(layout.appAt)}, with nothing in front of it, as on AgentCore Runtime (LOCAL_RUNTIME_EDGE=off)`);
  }

  const end = (): void => {
    process.exit(0);
  };
  process.on('SIGTERM', end);
  process.on('SIGINT', end);
}
