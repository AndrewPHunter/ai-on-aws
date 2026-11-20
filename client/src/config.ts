// The client's settings, read from the environment by name. Every one is required: nothing falls back
// to a default of the machine. Pure, so it is tested with plain objects.

import { z } from 'zod';

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// Identifiers the status report uses for the parts that are not agents.
const RESERVED_IDS: readonly string[] = ['case-system', 'agents', 'knowledge', 'evaluation'];

const agentSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string(),
  // Stored without a trailing slash, so paths are appended the same way whatever was configured.
  url: z.url({ protocol: /^https?$/ }).transform(withoutTrailingSlash),
});

const agentsSchema = z.array(agentSchema).superRefine((agents, context) => {
  const seen = new Set<string>();
  for (const agent of agents) {
    if (RESERVED_IDS.includes(agent.id)) {
      context.addIssue({ code: 'custom', message: `the agent id "${agent.id}" is reserved for another part of the system` });
    }
    if (seen.has(agent.id)) {
      context.addIssue({ code: 'custom', message: `the agent id "${agent.id}" is used more than once` });
    }
    seen.add(agent.id);
  }
});

export type AgentConfig = z.infer<typeof agentSchema>;

export type Config = {
  dbPath: string;
  caseReviewUrl: string;
  agents: AgentConfig[];
  webRoot: string;
};

function required(env: NodeJS.ProcessEnv, name: string, meaning: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. It is ${meaning}.`);
  }
  return value;
}

function httpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https URL: ${value}`);
  }
  return withoutTrailingSlash(value);
}

function agentsFrom(value: string): AgentConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AGENTS is not JSON. It must be a JSON array of { id, name, description, url }.');
  }
  const result = agentsSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? '' : ` at ${first.path.join('.')}`;
    throw new Error(`AGENTS is not valid${where}: ${first?.message ?? 'unknown problem'}`);
  }
  return result.data;
}

export function configFrom(env: NodeJS.ProcessEnv): Config {
  return {
    dbPath: required(env, 'CLIENT_DB_PATH', 'the path of the SQLite file that holds inquiries and runs'),
    caseReviewUrl: httpUrl(
      'CASE_REVIEW_URL',
      required(env, 'CASE_REVIEW_URL', "the base URL of the case system's review server"),
    ),
    agents: agentsFrom(required(env, 'AGENTS', 'a JSON array of { id, name, description, url }, possibly empty')),
    webRoot: required(env, 'WEB_ROOT', 'the directory holding the built web app'),
  };
}
