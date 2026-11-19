// The MCP endpoint at /mcp: JSON-RPC 2.0 over plain JSON bodies (Streamable HTTP
// transport, one answer per POST). Both eras the suite accepts: the modern
// 2026-07-28 `server/discover`, and the legacy `initialize` handshake.

import { viewerLogin, type Store } from './store.ts';

export interface McpReply {
  status: number;
  body: unknown;
}

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The repository owner (the authenticated user).' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  };
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, messageText: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message: messageText } } };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError,
  };
}

function toolError(messageText: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: messageText }], isError: true };
}

function repoObject(store: Store, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return toolError(`unknown tool ${name}`);
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  const owner = viewerLogin();
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (repoNameArg === '') return toolError('missing required argument: name');
    if (store.getRepo(owner, repoNameArg)) return toolError(`repository ${owner}/${repoNameArg} already exists`);
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    store.createRepo(owner, repoNameArg, description, isPrivate);
    return toolResult(repoObject(store, owner, repoNameArg));
  }

  const repo = store.getRepo(owner, repoName);
  if (!repo) return toolError(`repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') return toolResult(repoObject(store, owner, repoName));

  if (name === 'create_issue') {
    const title = String(args.title ?? '');
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return toolResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [],
      user: { login: owner },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    });
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => a.number - b.number);
    const list = issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => ({ name: label.name })),
      user: { login: owner },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    }));
    return toolResult(list);
  }

  if (name === 'get_issue') {
    const number = Number(args.issue_number);
    const issue = store.getIssue(repo, number);
    if (!issue) return toolError(`issue #${number} not found`);
    return toolResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => ({ name: label.name })),
      user: { login: owner },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    });
  }

  if (name === 'create_pull_request') {
    const title = String(args.title ?? '');
    const body = typeof args.body === 'string' ? args.body : '';
    const head = String(args.head ?? '');
    const base = String(args.base ?? repo.defaultBranch);
    if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch ${head} does not exist`);
    if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
    let pull = repo.pulls.find((candidate) => candidate.state === 'open' && candidate.headRef === head && candidate.baseRef === base);
    if (!pull) {
      pull = store.createPull(repo, title, body, head, base) ?? undefined;
    }
    if (!pull) return toolError('could not create the pull request');
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      merged: pull.merged,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    });
  }

  if (name === 'list_pull_requests') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let pulls = [...repo.pulls];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => a.number - b.number);
    const list = pulls.map((pull) => ({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      merged: pull.merged,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    }));
    return toolResult(list);
  }

  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = store.getPull(repo, number);
    if (!pull) return toolError(`pull request #${number} not found`);
    if (pull.state !== 'open') return toolError(`pull request #${number} is not open`);
    if (store.mergeConflicts(repo, pull).length > 0) return toolError('merge conflict');
    store.mergePull(repo, pull);
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      merged: pull.merged,
      merge_commit_sha: pull.mergeCommitSha,
      merged_at: pull.mergedAt,
    });
  }

  return toolError(`unknown tool ${name}`);
}

/** Handle one JSON-RPC request object. Returns null for notifications. */
function handleOne(store: Store, request: unknown): McpReply | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const record = request as Record<string, unknown>;
  const id = 'id' in record ? record.id : undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  if (method === '') return rpcError(id, -32600, 'Invalid Request: no method');
  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'server/discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification: no JSON-RPC response, HTTP 202 with an empty body.
    return isNotification ? null : rpcResult(id, {});
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(toolJson) });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') return rpcError(id, -32602, 'Invalid params: tools/call needs a name');
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    return rpcResult(id, callTool(store, toolName, args));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle one POST /mcp body (already read as text). */
export function handleMcp(store: Store, bodyText: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleOne(store, entry);
      if (reply !== null) replies.push(reply.body);
    }
    return { status: 200, body: replies };
  }
  const reply = handleOne(store, parsed);
  if (reply === null) return { status: 202, body: null };
  return reply;
}
