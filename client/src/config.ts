// The client's settings, read from the environment by name. Every one is required: nothing falls back
// to a default of the machine. Pure, so it is tested with plain objects.

import { z } from 'zod';

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// Identifiers the status report uses for the parts that are not agents.
const RESERVED_IDS: readonly string[] = ['case-system', 'identity', 'agents', 'knowledge', 'evaluation'];

// The scopes an agent can require of the token it is sent.
export const AGENT_SCOPES = ['agents:intake', 'agents:expert'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

const agentSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string(),
  // The scope a token sent to this agent must hold, and a session must have been granted to run it.
  scope: z.enum(AGENT_SCOPES),
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

export type Config = {
  dbPath: string;
  caseReviewUrl: string;
  agents: AgentConfig[];
  webRoot: string;
  oidc: OidcConfig;
  // The origin the web app is served from. A POST from any other origin is refused.
  appOrigin: string;
  // The ID-token claim holding a flat list of role names.
  rolesClaim: string;
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

function agentsFrom(value: string): AgentConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AGENTS is not JSON. It must be a JSON array of { id, name, description, scope, url }.');
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
    agents: agentsFrom(required(env, 'AGENTS', 'a JSON array of { id, name, description, scope, url }, possibly empty')),
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
    appOrigin: origin('APP_ORIGIN', required(env, 'APP_ORIGIN', 'the origin the web app is served from')),
    rolesClaim: required(env, 'ROLES_CLAIM', 'the ID-token claim holding a flat list of role names'),
  };
}
