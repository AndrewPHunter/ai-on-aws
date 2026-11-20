// The client's server. Under /api it receives inquiries, sends them to agents, keeps every inquiry
// and run, forwards case review to the case system and reports the state of each piece. Everything
// else is the built web app.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import type { InvocationRequest } from '../../shared/agent-contract.ts';
import type {
  AgentList,
  ApiError,
  InquiryResponse,
  PieceStatus,
  Run,
  RunResponse,
  SampleList,
  SystemStatus,
} from '../shared/api.ts';
import { invokeAgent, ping, pingAgent } from './agents.ts';
import type { PingResult } from './agents.ts';
import { getCase, listCases, postReview } from './cases.ts';
import type { Forwarded } from './cases.ts';
import type { AgentConfig, Config } from './config.ts';
import { SAMPLES } from './samples.ts';
import type { InquiryStore } from './store.ts';

export type ClientDeps = {
  config: Config;
  store: InquiryStore;
  now: () => Date;
  newId: () => string;
  agentTimeoutMs: number;
};

export const MAX_TEXT_LENGTH = 10_000;
export const PING_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// Pieces of the system that are designed but do not exist yet. Reported so the status page says so.
const NOT_BUILT: readonly PieceStatus[] = [
  {
    id: 'knowledge',
    name: 'Label search',
    role: 'Finds the passages of the approved label that answer a question.',
    state: 'not_built',
    detail: 'Not built yet.',
  },
  {
    id: 'evaluation',
    name: 'Evaluation',
    role: 'Scores the agents against a set of prepared inquiries.',
    state: 'not_built',
    detail: 'Not built yet.',
  },
];

const NO_AGENT: PieceStatus = {
  id: 'agents',
  name: 'Agents',
  role: 'Handle inquiries: answer from the label and open adverse event cases.',
  state: 'not_built',
  detail: 'No agent is configured.',
};

// A failure the caller caused or can act on, answered with its status and an ApiError body.
class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function badRequest(detail: string): ApiFailure {
  return new ApiFailure(400, 'bad_request', detail);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, status: number, error: string, detail: string): void {
  const payload: ApiError = { error, detail };
  sendJson(response, status, payload);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function listener(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ApiFailure) {
        sendError(response, error.status, error.code, error.message);
        return;
      }
      console.error('Request failed:', error);
      sendError(response, 500, 'internal_error', 'The client failed while handling the request. The cause is in its log.');
    });
  };
}

// Reads the whole body even past the limit, so the caller is still sent the 400. Stopping early
// would destroy the socket and the caller would see a reset connection instead of the reason.
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('The request body is larger than 1 MB.'));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed);
      } catch {
        reject(badRequest('The request body is not JSON.'));
      }
    });
  });
}

function field(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('The request body is not a JSON object.');
  }
  const entries: Record<string, unknown> = { ...body };
  return entries[name];
}

function requiredString(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${name}" is required and must be text.`);
  }
  return value.trim();
}

function pieceFrom(id: string, name: string, role: string, result: PingResult): PieceStatus {
  return result.outcome === 'up'
    ? { id, name, role, state: 'up', detail: 'Answered the health check.' }
    : { id, name, role, state: 'down', detail: result.reason };
}

function sendForwarded(response: ServerResponse, forwarded: Forwarded): void {
  if (forwarded.outcome === 'unreachable') {
    sendError(response, 502, 'case_system_unreachable', forwarded.reason);
    return;
  }
  sendJson(response, forwarded.status, forwarded.body);
}

// A path segment as the caller meant it. One that cannot be decoded names nothing that exists.
function segment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>;
type Route = Partial<Record<'GET' | 'POST', Handler>>;

export function createClientServer(deps: ClientDeps): Server {
  const { config, store, now, newId, agentTimeoutMs } = deps;

  function agentNamed(id: string): AgentConfig {
    const agent = config.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
      throw new ApiFailure(400, 'unknown_agent', `No agent with the id "${id}" is configured.`);
    }
    return agent;
  }

  // Runs in the background after the 202 has been sent. Everything that can throw is inside the try,
  // so a failure here is logged and never becomes an unhandled rejection.
  async function settleRun(runId: string, agent: AgentConfig, request: InvocationRequest): Promise<void> {
    try {
      const result = await invokeAgent(agent.url, request, agentTimeoutMs);
      if (result.outcome === 'ok') {
        store.completeRun(runId, result.response);
      } else {
        store.failRun(runId, result.reason);
      }
    } catch (error) {
      console.error(`Could not record the result of run ${runId}:`, error);
    }
  }

  // Sends the stored message, with the id and receipt time it was given when it was received.
  function startRun(inquiryId: string, agent: AgentConfig): Run {
    const inquiry = store.getInquiry(inquiryId);
    if (inquiry === undefined) {
      throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
    }
    const run = store.startRun(newId(), inquiry.id, agent.id);
    if (run === undefined) {
      throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
    }
    const request: InvocationRequest = {
      message: { id: inquiry.id, received_at: inquiry.received_at, sender: inquiry.sender, text: inquiry.text },
    };
    void settleRun(run.id, agent, request);
    return run;
  }

  function inquiryResponse(inquiryId: string): InquiryResponse {
    const inquiry = store.getInquiry(inquiryId);
    if (inquiry === undefined) {
      throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
    }
    return { inquiry };
  }

  async function status(): Promise<SystemStatus> {
    const checkedAt = now().toISOString();
    const caseSystem = ping(`${config.caseReviewUrl}/ping`, PING_TIMEOUT_MS).then((result) =>
      pieceFrom('case-system', 'Case system', "Holds adverse event cases and records reviewers' decisions.", result),
    );
    const agents = config.agents.map((agent) =>
      pingAgent(agent.url, PING_TIMEOUT_MS).then((result) => pieceFrom(agent.id, agent.name, agent.description, result)),
    );
    const pinged = await Promise.all([caseSystem, ...agents]);
    const noAgent = config.agents.length === 0 ? [NO_AGENT] : [];
    return { checked_at: checkedAt, pieces: [...pinged, ...noAgent, ...NOT_BUILT] };
  }

  const routes = {
    status: {
      GET: async (_request, response) => {
        sendJson(response, 200, await status());
      },
    },
    agents: {
      GET: async (_request, response) => {
        const payload: AgentList = {
          agents: config.agents.map((agent) => ({ id: agent.id, name: agent.name, description: agent.description })),
        };
        sendJson(response, 200, payload);
      },
    },
    samples: {
      GET: async (_request, response) => {
        const payload: SampleList = { samples: [...SAMPLES] };
        sendJson(response, 200, payload);
      },
    },
    inquiries: {
      GET: async (_request, response) => {
        sendJson(response, 200, store.listInquiries());
      },
      POST: async (request, response) => {
        const body = await readJson(request);
        const sender = requiredString(body, 'sender');
        const text = requiredString(body, 'text');
        if (text.length > MAX_TEXT_LENGTH) {
          throw badRequest(`"text" is longer than ${MAX_TEXT_LENGTH} characters.`);
        }
        const agent = agentNamed(requiredString(body, 'agent_id'));
        const id = newId();
        store.createInquiry({ id, receivedAt: now().toISOString(), sender, text });
        startRun(id, agent);
        sendJson(response, 202, inquiryResponse(id));
      },
    },
  } satisfies Record<string, Route>;

  function inquiryRoute(inquiryId: string): Route {
    return {
      GET: async (_request, response) => {
        sendJson(response, 200, inquiryResponse(inquiryId));
      },
    };
  }

  function runsRoute(inquiryId: string): Route {
    return {
      POST: async (request, response) => {
        const body = await readJson(request);
        const agentId = requiredString(body, 'agent_id');
        if (store.getInquiry(inquiryId) === undefined) {
          throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
        }
        const payload: RunResponse = { run: startRun(inquiryId, agentNamed(agentId)) };
        sendJson(response, 202, payload);
      },
    };
  }

  const casesRoute: Route = {
    GET: async (_request, response, url) => {
      sendForwarded(response, await listCases(config.caseReviewUrl, url.searchParams.get('status')));
    },
  };

  function caseRoute(caseId: string): Route {
    return {
      GET: async (_request, response) => {
        sendForwarded(response, await getCase(config.caseReviewUrl, caseId));
      },
    };
  }

  function reviewRoute(caseId: string): Route {
    return {
      POST: async (request, response) => {
        const body = await readJson(request);
        sendForwarded(response, await postReview(config.caseReviewUrl, caseId, body));
      },
    };
  }

  function apiRoute(pathname: string): Route | undefined {
    switch (pathname) {
      case '/api/status':
        return routes.status;
      case '/api/agents':
        return routes.agents;
      case '/api/samples':
        return routes.samples;
      case '/api/inquiries':
        return routes.inquiries;
      case '/api/cases':
        return casesRoute;
    }
    const inquiry = /^\/api\/inquiries\/([^/]+)(\/runs)?$/.exec(pathname);
    const inquiryId = inquiry?.[1] === undefined ? undefined : segment(inquiry[1]);
    if (inquiry !== null && inquiryId !== undefined) {
      return inquiry[2] === undefined ? inquiryRoute(inquiryId) : runsRoute(inquiryId);
    }
    const found = /^\/api\/cases\/([^/]+)(\/review)?$/.exec(pathname);
    const caseId = found?.[1] === undefined ? undefined : segment(found[1]);
    if (found !== null && caseId !== undefined) {
      return found[2] === undefined ? caseRoute(caseId) : reviewRoute(caseId);
    }
    return undefined;
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const route = apiRoute(url.pathname);
    if (route === undefined) {
      sendError(response, 404, 'not_found', `There is no API route ${url.pathname}.`);
      return;
    }
    const handler = request.method === 'GET' ? route.GET : request.method === 'POST' ? route.POST : undefined;
    if (handler === undefined) {
      const allowed = Object.keys(route).join(', ');
      response.setHeader('allow', allowed);
      sendError(response, 405, 'method_not_allowed', `${url.pathname} accepts ${allowed}.`);
      return;
    }
    await handler(request, response, url);
  }

  const webRoot = resolve(config.webRoot);

  async function isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  // Where under the web root a URL path points.
  // A path that resolves outside the root names nothing, and does not fall back to the app.
  function fileFor(pathname: string): { inside: true; path: string } | { inside: false } {
    const decoded = segment(pathname);
    if (decoded === undefined || decoded.includes('\0')) {
      return { inside: false };
    }
    const path = resolve(webRoot, `.${decoded}`);
    if (path !== webRoot && !path.startsWith(webRoot + sep)) {
      return { inside: false };
    }
    return { inside: true, path };
  }

  async function sendFile(response: ServerResponse, path: string, headOnly: boolean, cacheControl: string | undefined): Promise<void> {
    const content = await readFile(path);
    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(content.length),
    };
    if (cacheControl !== undefined) {
      headers['cache-control'] = cacheControl;
    }
    response.writeHead(200, headers);
    response.end(headOnly ? undefined : content);
  }

  async function handleWeb(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendText(response, 405, 'Method not allowed.');
      return;
    }
    const headOnly = request.method === 'HEAD';
    const target = fileFor(url.pathname);
    if (!target.inside) {
      sendText(response, 404, 'Not found.');
      return;
    }
    const index = resolve(webRoot, 'index.html');
    if (target.path !== index && (await isFile(target.path))) {
      const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : undefined;
      await sendFile(response, target.path, headOnly, cache);
      return;
    }
    // The app does its own routing, so any other path is the app's page.
    if (!(await isFile(index))) {
      sendText(response, 503, 'The web app has not been built.');
      return;
    }
    await sendFile(response, index, headOnly, 'no-cache');
  }

  return createServer(
    listener(async (request, response) => {
      // URL parsing collapses literal ".." segments but leaves encoded ones; fileFor decodes the path
      // and checks the result against the web root, so neither form can leave it.
      const url = new URL(request.url ?? '/', 'http://client');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      await handleWeb(request, response, url);
    }),
  );
}
