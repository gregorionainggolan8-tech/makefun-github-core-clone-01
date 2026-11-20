// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send: viewer/repository/node reads, issue and pull-request
// connections, the three mutations, and __type introspection.
import { FIXED_TIME, VIEWER_LOGIN, decodeGlobalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias?: string;
  name: string;
  args?: Array<{ name: string; value: Value }>;
  selection?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] };

interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; value: Value }>;
  selection: SelectionNode[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    tokens.push(ch);
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    return this.tokens[this.pos++];
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      operation = this.next() as 'query' | 'mutation';
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    }
    const variables: Array<{ name: string; value: Value }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const varToken = this.next();
        const varName = varToken.startsWith('$') ? varToken.slice(1) : varToken;
        this.expect(':');
        // Skip the type (a name, possibly wrapped in [ ] and !).
        while (this.peek() !== undefined && this.peek() !== ',' && this.peek() !== ')' && this.peek() !== '=') this.next();
        if (this.peek() === '=') {
          this.next();
          variables.push({ name: varName, value: this.parseValue() });
        } else {
          variables.push({ name: varName, value: { kind: 'null' } });
        }
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const nodes: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          nodes.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          // Named fragment spread: skip its name; its fields are inlined (unused by the suite).
          this.next();
        }
      } else {
        nodes.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return nodes;
  }

  parseField(): FieldNode {
    const first = this.next();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    let args: Array<{ name: string; value: Value }> | undefined;
    if (this.peek() === '(') {
      this.next();
      args = [];
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  parseValue(): Value {
    const token = this.next();
    if (token.startsWith('$')) return { kind: 'variable', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ execution

type Variables = Record<string, unknown>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): unknown {
  const arg = field.args?.find((item) => item.name === name);
  return arg ? resolveValue(arg.value, variables) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closed', 'closedAt'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PR', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

interface Ctx {
  store: Store;
  variables: Variables;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function issueGql(issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function pullGql(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: store.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function repoGql(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function selectFields(source: Record<string, unknown>, selection: SelectionNode[] | undefined, ctx: Ctx, typeName: string): Record<string, unknown> {
  if (!selection) return source;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition === typeName || node.typeCondition === '') {
        Object.assign(out, selectFields(source, node.selection, ctx, typeName));
      }
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    const value = resolveField(source, field, ctx, typeName);
    out[key] = value;
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(source: Record<string, unknown>, field: FieldNode, ctx: Ctx, typeName: string): unknown {
  const name = field.name;
  if (typeName === 'Query') return resolveQueryField(source, field, ctx);
  if (typeName === 'Repository') return resolveRepoField(source, field, ctx);
  if (typeName === 'Issue') return resolveIssueField(source, field, ctx);
  if (typeName === 'PullRequest') return resolvePullField(source, field, ctx);
  if (typeName === '__Type') return resolveTypeField(source, field, ctx);
  if (typeName === 'User' || typeName === 'Actor') {
    if (name === 'login') return source.login ?? VIEWER_LOGIN;
    return unknownField(ctx, typeName, name);
  }
  if (typeName === 'Ref') {
    if (name === 'name') return source.name;
    return unknownField(ctx, typeName, name);
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (name === 'nodes') {
      const nodes = (source.nodes as Array<Record<string, unknown>>) ?? [];
      return nodes.map((node) => selectFields(node, field.selection, ctx, node.__typename as string));
    }
    if (name === 'pageInfo') {
      const pageInfo = (source.pageInfo as Record<string, unknown>) ?? { hasNextPage: false, endCursor: null };
      return selectFields(pageInfo, field.selection, ctx, 'PageInfo');
    }
    if (name === 'totalCount') return (source.nodes as unknown[])?.length ?? 0;
    return unknownField(ctx, typeName, name);
  }
  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return source.hasNextPage ?? false;
    if (name === 'endCursor') return source.endCursor ?? null;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return source.startCursor ?? null;
    return unknownField(ctx, typeName, name);
  }
  if (typeName === 'Comment') {
    if (name === 'id') return source.id;
    if (name === 'body') return source.body;
    return unknownField(ctx, typeName, name);
  }
  if (typeName === 'PullRequestFile') {
    if (name === 'path') return source.path;
    if (name === 'filename') return source.path;
    return unknownField(ctx, typeName, name);
  }
  if (typeName === 'CommentEdge') {
    if (name === 'node') {
      const node = source.node as Record<string, unknown>;
      return node ? selectFields(node, field.selection, ctx, 'Comment') : null;
    }
    return unknownField(ctx, typeName, name);
  }
  if (name === '__typename') return typeName;
  // Plain scalar fields held on the source object.
  if (name in source) {
    const value = source[name];
    if (field.selection && isRecord(value)) return selectFields(value, field.selection, ctx, name === 'owner' ? 'User' : typeName);
    return value;
  }
  return unknownField(ctx, typeName, name);
}

function resolveQueryField(_source: Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return 'Query';
  if (name === 'viewer') {
    const viewer = { __typename: 'User', login: VIEWER_LOGIN, id: 1000 };
    return selectFields(viewer, field.selection, ctx, 'User');
  }
  if (name === 'repository') {
    const owner = String(argValue(field, 'owner', ctx.variables) ?? '');
    const repoName = String(argValue(field, 'name', ctx.variables) ?? '');
    const repo = ctx.store.getRepo(owner, repoName);
    if (!repo || owner !== VIEWER_LOGIN) return null;
    return selectFields(repoGql(repo), field.selection, ctx, 'Repository');
  }
  if (name === 'node') {
    const id = String(argValue(field, 'id', ctx.variables) ?? '');
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    if (decoded.kind === 'repo') {
      const repo = ctx.store.getRepoById(Number(decoded.parts[0]));
      if (!repo) return null;
      return selectFields(repoGql(repo), field.selection, ctx, 'Repository');
    }
    if (decoded.kind === 'issue') {
      const repo = ctx.store.getRepoById(Number(decoded.parts[0]));
      const issue = repo?.issues.find((item) => item.number === Number(decoded.parts[1]));
      if (!issue) return null;
      return selectFields(issueGql(issue), field.selection, ctx, 'Issue');
    }
    if (decoded.kind === 'pull') {
      const repo = ctx.store.getRepoById(Number(decoded.parts[0]));
      const pull = repo?.pulls.find((item) => item.number === Number(decoded.parts[1]));
      if (!pull || !repo) return null;
      return selectFields(pullGql(ctx.store, repo, pull), field.selection, ctx, 'PullRequest');
    }
    return null;
  }
  if (name === '__type') {
    const typeName = String(argValue(field, 'name', ctx.variables) ?? '');
    const typeObject = typeInfo(typeName);
    if (!typeObject) return null;
    return selectFields(typeObject, field.selection, ctx, '__Type');
  }
  if (name === '__schema') {
    return selectFields({ __typename: '__Schema', queryType: { name: 'Query' } }, field.selection, ctx, '__Schema');
  }
  return unknownField(ctx, 'Query', name);
}

function typeInfo(name: string): Record<string, unknown> | null {
  switch (name) {
    case 'Issue':
      return { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: ISSUE_TYPE_FIELDS.map((item) => ({ name: item })), enumValues: null };
    case 'PullRequest':
      return { __typename: '__Type', name: 'PullRequest', kind: 'OBJECT', fields: PULL_TYPE_FIELDS.map((item) => ({ name: item })), enumValues: null };
    case 'Repository':
      return { __typename: '__Type', name: 'Repository', kind: 'OBJECT', fields: REPO_TYPE_FIELDS.map((item) => ({ name: item })), enumValues: null };
    case 'SearchType':
      return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((item) => ({ name: item })) };
    default:
      return null;
  }
}

function resolveTypeField(source: Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === 'name') return source.name;
  if (name === 'kind') return source.kind;
  if (name === 'fields') {
    const fields = source.fields as Array<Record<string, unknown>> | null;
    if (!fields) return null;
    return fields.map((item) => selectFields(item, field.selection, ctx, '__Field'));
  }
  if (name === 'enumValues') {
    const values = source.enumValues as Array<Record<string, unknown>> | null;
    if (!values) return null;
    return values.map((item) => selectFields(item, field.selection, ctx, '__EnumValue'));
  }
  if (name === '__typename') return '__Type';
  return unknownField(ctx, '__Type', name);
}

function repoOf(source: Record<string, unknown>, ctx: Ctx): Repo | undefined {
  const id = Number(source.databaseId);
  return ctx.store.getRepoById(id);
}

function resolveRepoField(source: Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return 'Repository';
  if (name === 'owner') {
    const owner = { __typename: 'User', login: VIEWER_LOGIN, id: 1000 };
    return selectFields(owner, field.selection, ctx, 'User');
  }
  if (name === 'defaultBranchRef') {
    const repo = repoOf(source, ctx);
    if (!repo) return null;
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip) return null;
    return selectFields({ __typename: 'Ref', name: repo.defaultBranch }, field.selection, ctx, 'Ref');
  }
  if (name === 'issue') {
    const repo = repoOf(source, ctx);
    if (!repo) return null;
    const number = Number(argValue(field, 'number', ctx.variables));
    const issue = repo.issues.find((item) => item.number === number);
    return issue ? selectFields(issueGql(issue), field.selection, ctx, 'Issue') : null;
  }
  if (name === 'issues') {
    const repo = repoOf(source, ctx);
    if (!repo) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    return issueConnection(ctx, repo, field);
  }
  if (name === 'pullRequests') {
    const repo = repoOf(source, ctx);
    if (!repo) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const first = Number(argValue(field, 'first', ctx.variables) ?? 100);
    const pulls = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
    const nodes = pulls.slice(0, first).map((pull) => pullGql(ctx.store, repo, pull));
    const connection = { __typename: 'PullRequestConnection', nodes, pageInfo: { hasNextPage: pulls.length > first, endCursor: null } };
    return selectFields(connection, field.selection, ctx, 'PullRequestConnection');
  }
  if (name === 'pullRequest') {
    const repo = repoOf(source, ctx);
    if (!repo) return null;
    const number = Number(argValue(field, 'number', ctx.variables));
    const pull = repo.pulls.find((item) => item.number === number);
    return pull ? selectFields(pullGql(ctx.store, repo, pull), field.selection, ctx, 'PullRequest') : null;
  }
  if (name in source) return source[name];
  return unknownField(ctx, 'Repository', name);
}

function issueConnection(ctx: Ctx, repo: Repo, field: FieldNode): Record<string, unknown> {
  const first = Number(argValue(field, 'first', ctx.variables) ?? 100);
  const after = argValue(field, 'after', ctx.variables);
  const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx.variables) as Record<string, unknown> | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = String(orderBy?.direction ?? 'ASC').toUpperCase();
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (typeof after === 'string' && after !== '') {
    const afterNumber = cursorNumber(after);
    if (afterNumber !== null) {
      const index = list.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) list = list.slice(index + 1);
    }
  }
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number) : null;
  const connection = {
    __typename: 'IssueConnection',
    nodes: nodes.map(issueGql),
    pageInfo: { hasNextPage, endCursor, startCursor: nodes.length > 0 ? cursorFor(nodes[0].number) : null },
  };
  return selectFields(connection, field.selection, ctx, 'IssueConnection');
}

function resolveIssueField(source: Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return 'Issue';
  if (name in source) return source[name];
  return unknownField(ctx, 'Issue', name);
}

function resolvePullField(source: Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__typename') return 'PullRequest';
  if (name === 'files') {
    const repo = ctx.store.getRepoById(Number(String(source.id ? decodeGlobalId(String(source.id))?.parts[0] : '')));
    const files = repo
      ? ctx.store.pullFiles(repo, repo.pulls.find((pull) => pull.globalId === source.id)!)
      : [];
    const nodes = files.map((file) => ({ __typename: 'PullRequestFile', path: file.filename }));
    const connection = { __typename: 'PullRequestFileConnection', nodes, pageInfo: { hasNextPage: false, endCursor: null } };
    return selectFields(connection, field.selection, ctx, 'PullRequestFileConnection');
  }
  if (name in source) return source[name];
  return unknownField(ctx, 'PullRequest', name);
}

// ------------------------------------------------------------------ mutations

function executeMutation(operation: Operation, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of operation.selection) {
    if (node.kind !== 'field') continue;
    const field = node.field;
    const key = field.alias ?? field.name;
    out[key] = executeMutationField(field, ctx);
  }
  return out;
}

function mutationInput(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const raw = argValue(field, 'input', ctx.variables);
  return isRecord(raw) ? raw : {};
}

function executeMutationField(field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === 'createIssue') {
    const input = mutationInput(field, ctx);
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'repo' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve repository id.' });
      return null;
    }
    const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    const issueObject = selectFields(issueGql(issue), field.selection?.[0]?.kind === 'field' ? field.selection[0].field.selection : undefined, ctx, 'Issue');
    void issueObject;
    const inner = field.selection?.find((item) => item.kind === 'field' && item.field.name === 'issue');
    const issueSelection = inner && inner.kind === 'field' ? inner.field.selection : undefined;
    return { issue: selectFields(issueGql(issue), issueSelection, ctx, 'Issue') };
  }
  if (name === 'closeIssue') {
    const input = mutationInput(field, ctx);
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const repo = decoded?.kind === 'issue' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((item) => item.number === Number(decoded?.parts[1]));
    if (!issue) {
      ctx.errors.push({ message: 'Could not resolve issue id.' });
      return null;
    }
    issue.state = 'closed';
    const inner = field.selection?.find((item) => item.kind === 'field' && item.field.name === 'issue');
    const issueSelection = inner && inner.kind === 'field' ? inner.field.selection : undefined;
    return { issue: selectFields(issueGql(issue), issueSelection, ctx, 'Issue') };
  }
  if (name === 'createPullRequest') {
    const input = mutationInput(field, ctx);
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded?.kind === 'repo' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve repository id.' });
      return null;
    }
    const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if (!pull) {
      ctx.errors.push({ message: 'Could not create pull request: head or base branch does not exist.' });
      return null;
    }
    const inner = field.selection?.find((item) => item.kind === 'field' && item.field.name === 'pullRequest');
    const pullSelection = inner && inner.kind === 'field' ? inner.field.selection : undefined;
    return { pullRequest: selectFields(pullGql(ctx.store, repo, pull), pullSelection, ctx, 'PullRequest') };
  }
  if (name === 'mergePullRequest') {
    const input = mutationInput(field, ctx);
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const repo = decoded?.kind === 'pull' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.find((item) => item.number === Number(decoded?.parts[1]));
    if (!pull || !repo) {
      ctx.errors.push({ message: 'Could not resolve pull request id.' });
      return null;
    }
    if (ctx.store.pullConflict(repo, pull)) {
      const inner = field.selection?.find((item) => item.kind === 'field' && item.field.name === 'pullRequest');
      const pullSelection = inner && inner.kind === 'field' ? inner.field.selection : undefined;
      return { pullRequest: selectFields(pullGql(ctx.store, repo, pull), pullSelection, ctx, 'PullRequest') };
    }
    ctx.store.mergePull(repo, pull);
    const inner = field.selection?.find((item) => item.kind === 'field' && item.field.name === 'pullRequest');
    const pullSelection = inner && inner.kind === 'field' ? inner.field.selection : undefined;
    return { pullRequest: selectFields(pullGql(ctx.store, repo, pull), pullSelection, ctx, 'PullRequest') };
  }
  if (name === 'addComment') {
    const input = mutationInput(field, ctx);
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const repo = decoded?.kind === 'issue' ? ctx.store.getRepoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((item) => item.number === Number(decoded?.parts[1]));
    if (!issue || !repo) {
      ctx.errors.push({ message: 'Could not resolve issue id.' });
      return null;
    }
    const id = repo.nextCommentId++;
    const comment = { id, globalId: `comment:${repo.id}:${issue.number}:${id}`, body: String(input.body ?? '') };
    issue.comments.push(comment);
    const edge = field.selection?.find((item) => item.kind === 'field' && item.field.name === 'commentEdge');
    const nodeSelection = edge && edge.kind === 'field'
      ? edge.field.selection?.find((item) => item.kind === 'field' && item.field.name === 'node')
      : undefined;
    const nodeFields = nodeSelection && nodeSelection.kind === 'field' ? nodeSelection.field.selection : undefined;
    return { commentEdge: { node: selectFields({ __typename: 'Comment', id: comment.globalId, body: comment.body }, nodeFields, ctx, 'Comment') } };
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}

// ------------------------------------------------------------------ entry point

export interface GraphqlResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (a single operation object, or an array for batching). */
export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((item) => executeOne(store, item)) };
  }
  return { status: 200, body: executeOne(store, body) };
}

function executeOne(store: Store, body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {};
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = isRecord(record.variables) ? (record.variables as Variables) : {};
  const ctx: Ctx = { store, variables, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL syntax error' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operation provided.' }] };
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation provided.' }] };
  let data: Record<string, unknown>;
  if (operation.operation === 'mutation') {
    data = executeMutation(operation, ctx);
  } else {
    data = {};
    for (const node of operation.selection) {
      if (node.kind === 'fragment') continue;
      const field = node.field;
      const key = field.alias ?? field.name;
      data[key] = resolveQueryField({}, field, ctx);
    }
  }
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}
