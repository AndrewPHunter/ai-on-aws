// The client's settings, read from the environment by name. Every one is required except the five the status
// checks by health and EVALUATION_DATA_DIR, which are optional; nothing falls back to a default of the machine. Pure, so it is
// tested with plain objects.

import { z } from 'zod';

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// Identifiers the status report uses for the parts that are not agents.
const RESERVED_IDS: readonly string[] = [
  'case-system',
  'identity',
  'agents',
  'retrieval',
  'search',
  'model-chat',
  'model-embedding',
  'model-reranker',
];

// The scopes an agent can require of the token it is sent.
export const AGENT_SCOPES = ['agents:intake', 'agents:expert', 'agents:orchestrator'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

const agentSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string(),
  // The scope a token sent to this agent must hold, and a session must have been granted to run it.
  scope: z.enum(AGENT_SCOPES),
  // Stored without a trailing slash, so paths are appended the same way whatever was configured.
  url: z.url({ protocol: /^https?$/ }).transform(withoutTrailingSlash),
  // How long the client waits for this agent's answer, and so how long the token sent to it must still live.
  // At most 295 because Node's fetch stops waiting for an answer at 300 s, whatever time limit is set.
  wait_seconds: z.number().int().min(30).max(295).default(180),
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

// How desk staff sign in: the OpenID Connect provider and the desk's client at it.
export type OidcConfig = {
  discoveryUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  // Where a refresh token is revoked at sign-out, or null for a provider without that endpoint. A setting,
  // not read from discovery: Keycloak names this one endpoint at the browser's address even when its
  // document is fetched from inside the network.
  revocationEndpoint: string | null;
};

// The two clients that call agents as themselves, nobody being signed in: the contact form and the lab explorer.
// Their ids at the identity provider are fixed here; their secrets are settings.
export const MACHINE_CLIENTS = ['contact-form', 'lab-explorer'] as const;
export type MachineClient = (typeof MACHINE_CLIENTS)[number];

// The pieces the status checks by their health route, with no key or token, and the setting each is read from. Each
// setting is optional. The lab explorer also reads the label index from the search engine and searches through the
// retrieval service at the same addresses (knowledge.ts).
export const HEALTH_SETTINGS = {
  retrieval: 'RETRIEVAL_URL',
  search: 'SEARCH_URL',
  'model-chat': 'MODEL_BASE_URL',
  'model-embedding': 'MODEL_EMBED_BASE_URL',
  'model-reranker': 'MODEL_RERANK_BASE_URL',
} as const;
export type HealthChecked = keyof typeof HEALTH_SETTINGS;
// The three model servers are given by their base URL, which ends in /v1; their health route is at the root.
const MODEL_SERVERS: readonly HealthChecked[] = ['model-chat', 'model-embedding', 'model-reranker'];

export type Config = {
  dbPath: string;
  caseReviewUrl: string;
  agents: AgentConfig[];
  webRoot: string;
  oidc: OidcConfig;
  // Each machine client's secret at the identity provider, by client id.
  machineSecrets: Record<MachineClient, string>;
  // The origin the web app is served from. A POST from any other origin is refused.
  appOrigin: string;
  // The ID-token claim holding a flat list of role names.
  rolesClaim: string;
  // Where the status checks each piece in HEALTH_SETTINGS, without a trailing slash, and for a model server
  // without its /v1. A piece left out, or the whole field, is not configured.
  healthUrls?: Partial<Record<HealthChecked, string>>;
  // The folder the evaluation harness writes its runs to, mounted read-only, which the lab explorer reads; null
  // when EVALUATION_DATA_DIR is not set.
  evaluationDataDir: string | null;
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

// An http(s) URL kept exactly as given: the provider compares redirect URIs byte for byte, and the
// issuer is compared as a string.
function exactHttpUrl(name: string, value: string): string {
  httpUrl(name, value);
  return value;
}

// An http(s) URL, or the word none.
function urlOrNone(name: string, value: string): string | null {
  if (value === 'none') {
    return null;
  }
  try {
    return exactHttpUrl(name, value);
  } catch {
    throw new Error(`${name} must be an http or https URL, or the word none: ${value}`);
  }
}

// Scheme, host and port only, as a browser sends it in the Origin header.
function origin(name: string, value: string): string {
  exactHttpUrl(name, value);
  if (new URL(value).origin !== value) {
    throw new Error(`${name} must be an origin (scheme, host and port, no path or trailing slash): ${value}`);
  }
  return value;
}

// The settings in HEALTH_SETTINGS that are set. One absent or empty is left out; one that is not an http(s) URL
// stops the server, naming the setting but not its value: these are addresses on the local network, and the
// message is printed to the log.
function healthUrlsFrom(env: NodeJS.ProcessEnv): Partial<Record<HealthChecked, string>> {
  const urls: Partial<Record<HealthChecked, string>> = {};
  for (const [piece, name] of Object.entries(HEALTH_SETTINGS) as [HealthChecked, string][]) {
    const value = env[name]?.trim();
    if (value === undefined || value === '') {
      continue;
    }
    let url: string;
    try {
      url = httpUrl(name, value);
    } catch {
      throw new Error(`${name} is not an http or https URL.`);
    }
    urls[piece] = MODEL_SERVERS.includes(piece) ? url.replace(/\/v1$/, '') : url;
  }
  return urls;
}

function agentsFrom(value: string): AgentConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AGENTS is not JSON. It must be a JSON array of { id, name, description, scope, url, wait_seconds? }.');
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
    agents: agentsFrom(required(env, 'AGENTS', 'a JSON array of { id, name, description, scope, url, wait_seconds? }, possibly empty')),
    webRoot: required(env, 'WEB_ROOT', 'the directory holding the built web app'),
    oidc: {
      discoveryUrl: exactHttpUrl(
        'OIDC_DISCOVERY_URL',
        required(env, 'OIDC_DISCOVERY_URL', "where the server fetches the identity provider's discovery document"),
      ),
      issuer: exactHttpUrl(
        'OIDC_ISSUER',
        required(env, 'OIDC_ISSUER', 'the issuer the discovery document and every ID token must name'),
      ),
      clientId: required(env, 'OIDC_CLIENT_ID', "the desk's client id at the identity provider"),
      clientSecret: required(env, 'OIDC_CLIENT_SECRET', "the desk's client secret at the identity provider"),
      redirectUri: exactHttpUrl(
        'OIDC_REDIRECT_URI',
        required(env, 'OIDC_REDIRECT_URI', 'where the identity provider sends the browser back after sign-in'),
      ),
      postLogoutRedirectUri: exactHttpUrl(
        'OIDC_POST_LOGOUT_REDIRECT_URI',
        required(env, 'OIDC_POST_LOGOUT_REDIRECT_URI', 'where the identity provider sends the browser after sign-out'),
      ),
      revocationEndpoint: urlOrNone(
        'OIDC_REVOCATION_ENDPOINT',
        required(
          env,
          'OIDC_REVOCATION_ENDPOINT',
          'where the server revokes a refresh token at sign-out: a URL, or none when the provider has no such endpoint',
        ),
      ),
    },
    machineSecrets: {
      'contact-form': required(env, 'CONTACT_FORM_CLIENT_SECRET', "the secret of the client contact-form at the identity provider, which the contact form's runs are sent as"),
      'lab-explorer': required(env, 'LAB_EXPLORER_CLIENT_SECRET', "the secret of the client lab-explorer at the identity provider, which the lab explorer's runs are sent as"),
    },
    appOrigin: origin('APP_ORIGIN', required(env, 'APP_ORIGIN', 'the origin the web app is served from')),
    rolesClaim: required(env, 'ROLES_CLAIM', 'the ID-token claim holding a flat list of role names'),
    healthUrls: healthUrlsFrom(env),
    evaluationDataDir: env.EVALUATION_DATA_DIR?.trim() || null,
  };
}
