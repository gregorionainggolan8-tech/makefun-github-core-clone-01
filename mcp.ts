// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over
// Streamable HTTP, modern server/discover (revision 2026-07-28) plus the legacy
// initialize handshake, and tools that act on the same store as REST.
import { VIEWER_LOGIN, type Store } from './store.ts';

export const MCP_VERSION = '1.0.0';
export const MCP_NAME = 'github-core-forge';
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        number: { type: 'number', description: 'Alias of pull_number.' },
      },
      required: ['pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
        number: { type: 'number', description: 'Alias of issue_number.' },
      },
      required: [],
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user repositories.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Resolve owner/repo from arguments, accepting full_name as well. */
function resolveRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = str(args.full_name);
  if (fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (owner && repo) return { owner, repo };
  }
  const owner = str(args.owner) || VIEWER_LOGIN;
  const repo = str(args.repo) || str(args.repository) || str(args.name);
  if (!repo) return null;
  return { owner, repo };
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function executeTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  switch (normalized) {
    case 'createrepo':
    case 'createrepository': {
      const repoName = str(args.name) || str(args.repo) || str(args.repository);
      if (!repoName) return toolError('create_repo: missing required argument "name".');
      const created = store.createRepo(repoName, args.private === true, str(args.description));
      if (!created) return toolError(`create_repo: repository "${repoName}" already exists.`);
      return toolResult({ id: created.id, name: created.name, full_name: `${created.owner}/${created.name}`, private: created.private, description: created.description, default_branch: created.defaultBranch, owner: { login: created.owner } });
    }
    case 'getrepo':
    case 'getrepository': {
      const target = resolveRepo(args);
      if (!target) return toolError('get_repo: missing required argument "repo".');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return toolError(`get_repo: repository "${target.owner}/${target.repo}" not found.`);
      return toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch, owner: { login: repo.owner } });
    }
    case 'createissue': {
      const target = resolveRepo(args);
      const title = str(args.title);
      if (!target) return toolError('create_issue: missing required argument "repo".');
      if (!title) return toolError('create_issue: missing required argument "title".');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return toolError(`create_issue: repository "${target.owner}/${target.repo}" not found.`);
      const issue = store.createIssue(repo, title, str(args.body), []);
      return toolResult({ id: issue.globalId, number: issue.number, title: issue.title, body: issue.body, state: issue.state, url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}` });
    }
    case 'listissues': {
      const target = resolveRepo(args);
      if (!target) return toolError('list_issues: missing required argument "repo".');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return toolError(`list_issues: repository "${target.owner}/${target.repo}" not found.`);
      const state = str(args.state) || 'open';
      const list = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({ id: issue.globalId, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return toolResult(list);
    }
    case 'createpullrequest':
    case 'createpr': {
      const target = resolveRepo(args);
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      if (!target) return toolError('create_pull_request: missing required argument "repo".');
      if (!title) return toolError('create_pull_request: missing required argument "title".');
      if (!head) return toolError('create_pull_request: missing required argument "head".');
      if (!base) return toolError('create_pull_request: missing required argument "base".');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return toolError(`create_pull_request: repository "${target.owner}/${target.repo}" not found.`);
      const pull = store.createPull(repo, title, str(args.body), head, base);
      if (!pull) return toolError('create_pull_request: head or base branch does not exist.');
      return toolResult({ id: pull.globalId, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha }, headRefName: pull.headRef, baseRefName: pull.baseRef });
    }
    case 'mergepullrequest':
    case 'mergepr': {
      const target = resolveRepo(args);
      const number = num(args.pull_number) ?? num(args.number) ?? num(args.pull_request_number);
      if (!target) return toolError('merge_pull_request: missing required argument "repo".');
      if (number === null) return toolError('merge_pull_request: missing required argument "pull_number".');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return toolError(`merge_pull_request: repository "${target.owner}/${target.repo}" not found.`);
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return toolError(`merge_pull_request: pull request #${number} not found.`);
      if (pull.state !== 'open') return toolError(`merge_pull_request: pull request #${number} is already ${pull.state}.`);
      if (store.pullConflict(repo, pull)) return toolError(`merge_pull_request: pull request #${number} has a merge conflict.`);
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolError(`merge_pull_request: pull request #${number} could not be merged.`);
      return toolResult({ id: pull.globalId, number: pull.number, merged: true, state: 'closed', sha, merge_commit_sha: sha, message: `Pull request #${pull.number} merged` });
    }
    case 'getissue': {
      const target = resolveRepo(args);
      const number = num(args.issue_number) ?? num(args.number);
      if (!target) return toolError('get_issue: missing required argument "repo".');
      if (number === null) return toolError('get_issue: missing required argument "issue_number".');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return toolError(`get_issue: repository "${target.owner}/${target.repo}" not found.`);
      const issue = repo.issues.find((item) => item.number === number);
      if (!issue) return toolError(`get_issue: issue #${number} not found.`);
      return toolResult({ id: issue.globalId, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'listrepos': {
      return toolResult(store.listRepos().map((repo) => ({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch })));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export interface McpResult {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp body. `rawText` is the raw request body (a non-JSON body
 * answers HTTP 400 with JSON-RPC -32700).
 */
export function handleMcp(store: Store, rawText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } } };
  }
  const id = parsed.id ?? null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Notifications (no id) are acknowledged with HTTP 202 and no body.
  if (parsed.id === undefined) {
    return { status: 202, body: null };
  }

  const result = (value: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string, data?: unknown) => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } },
  });

  if (method === 'server/discover') {
    const serverInfo = { name: MCP_NAME, version: MCP_VERSION };
    return result({
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_NAME, version: MCP_VERSION },
    });
  }

  if (method === 'ping') {
    return result({});
  }

  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const def = TOOLS.find((tool) => tool.name.toLowerCase() === toolName.toLowerCase());
    if (!def) {
      return error(-32601, `Method not found: no tool named "${toolName}"`);
    }
    const missing = def.inputSchema.required.filter((prop) => !(prop in args) || args[prop] === undefined || args[prop] === null || args[prop] === '');
    if (missing.length > 0) {
      return result({ content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true });
    }
    try {
      return result(executeTool(store, toolName, args));
    } catch (err) {
      return result({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
    }
  }

  return error(-32601, `Method not found: ${method}`);
}
