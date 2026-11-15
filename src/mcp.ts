// MCP (Model Context Protocol, Streamable HTTP) over the shared store.
// Implements the modern era (2026-07-28) `server/discover` plus the legacy
// `initialize` fallback, `tools/list` and `tools/call` for the six tools the
// suite requires. Plain application/json answers; every request answers fast.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Repo,
  type Store,
} from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

const SERVER_INFO = { name: 'makefun-github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_repo_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function textResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof payload === 'object' && payload !== null ? payload : { value: payload },
    ...(isError ? { isError: true } : {}),
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return textResult({ error: `Missing required argument: ${required}` }, true);
    }
  }
  const asString = (value: unknown): string => String(value);
  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(VIEWER_LOGIN, asString(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      if (!repo) return textResult({ error: `Repository '${String(args.name)}' already exists` }, true);
      return textResult(repoObject(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return textResult({ error: 'Not Found' }, true);
      return textResult(repoObject(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return textResult({ error: 'Not Found' }, true);
      const created = store.createIssue(repo, asString(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return textResult({ error: created.error }, true);
      return textResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: [],
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return textResult({ error: 'Not Found' }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return textResult({
        issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return textResult({ error: 'Not Found' }, true);
      const head = asString(args.head);
      const base = asString(args.base);
      if (!store.branchTip(repo, head)) return textResult({ error: `head branch '${head}' does not exist` }, true);
      if (!store.branchTip(repo, base)) return textResult({ error: `base branch '${base}' does not exist` }, true);
      const created = store.createPullRequest(repo, asString(args.title), '', head, base);
      if ('error' in created) return textResult({ error: created.error }, true);
      return textResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: store.branchTip(repo, created.headRef) },
        base: { ref: created.baseRef, sha: store.branchTip(repo, created.baseRef) },
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(asString(args.owner), asString(args.repo));
      if (!repo) return textResult({ error: 'Not Found' }, true);
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pr = repo.pulls.get(pullNumber);
      if (!pr) return textResult({ error: 'Not Found' }, true);
      if (pr.merged) return textResult({ error: 'Pull request is already merged' }, true);
      const merged = store.squashMerge(repo, pr);
      if (!merged) return textResult({ error: 'Merge conflict' }, true);
      return textResult({ number: pr.number, merged: true, state: pr.state, merge_commit_sha: merged, sha: merged });
    }
    default:
      return textResult({ error: `Unknown tool: ${name}` }, true);
  }
}

export function handleMcp(store: Store, method: string, body: unknown, bodyInvalid: boolean): McpResult {
  // Session close: any 2xx.
  if (method === 'DELETE') return { status: 200, body: {} };
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  if (bodyInvalid) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const methodName = request.method as string | undefined;
  const params = (request.params ?? {}) as Record<string, unknown>;

  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcError = (code: number, message: string): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  switch (methodName) {
    case 'server/discover':
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
      return ok({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'notifications/initialized':
      return ok({});
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const toolName = params.name as string | undefined;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      if (!toolName) return rpcError(-32602, 'Missing tool name');
      const result = callTool(store, toolName, toolArgs);
      if (result.__rpcError) {
        const rpcErr = result.__rpcError as { code: number; message: string };
        return rpcError(rpcErr.code, rpcErr.message);
      }
      return ok(result);
    }
    default:
      return rpcError(-32601, `Method not found: ${methodName ?? ''}`);
  }
}

export { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME };
