// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches,
// commits, contents, labels, issues, comments and pull requests.
import { FIXED_TIME, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { flattenTree, isOid, parseCommit, ZERO_OID } from './gitcore.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, node_id: `user:${VIEWER_ID}`, type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return {
    id: Math.abs([...label.name].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)),
    node_id: label.name,
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.seq * 1000 + issue.number,
    node_id: issue.globalId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.seq * 1000 + pull.number,
    node_id: pull.globalId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    locked: false,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pull.state === 'closed' ? FIXED_TIME : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
  };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (baseUrl === '') return { page: [...slice], link: null };
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(baseUrl);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next"`;
  }
  if (start > 0) {
    const prev = new URL(baseUrl);
    prev.searchParams.set('page', String(page - 1));
    prev.searchParams.set('per_page', String(perPage));
    link = (link ? `${link}, ` : '') + `<${prev.toString()}>; rel="prev"`;
  }
  return { page: [...slice], link };
}

function linkHeader(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

/** Parse a JSON request body: null when empty, throws on malformed JSON. */
export function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Handle one REST request. `segments` are the path parts after /api/v3. */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  rawUrl: string,
  body: unknown,
): RestResult {
  const [first, owner, name, ...rest] = segments;

  // GET /api/v3/ — the API root.
  if ((first === '' || first === undefined) && segments.length <= 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', hook_url: '/api/v3/hooks', git_url: '/api/v3/git' });
  }

  if (first === 'user') {
    if (segments.length === 1 && method === 'GET') {
      return ok(200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: `user:${VIEWER_ID}`, type: 'User', email: VIEWER_EMAIL, name: VIEWER_NAME });
    }
    if (segments.length === 2 && rest.length === 0 && segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, link } = paginate(store.listRepos().map(repoJson), query, rawUrl);
        return ok(200, page, linkHeader(link));
      }
      if (method === 'POST') {
        const input = asRecord(body);
        const repoName = str(input.name).trim();
        if (repoName === '') return err(422, 'Validation Failed: name is required');
        const created = store.createRepo(repoName, input.private === true, str(input.description));
        if (!created) return err(422, 'Repository already exists');
        return ok(201, repoJson(created));
      }
    }
    return err(404, 'Not Found');
  }

  if (first !== 'repos' || !owner || !name) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      const input = asRecord(body);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const [section, ...tail] = rest;

  if (section === 'branches' && tail.length === 0 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false }));
    return ok(200, branches);
  }

  if (section === 'commits' && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const commits = store.listCommits(repo, ref).map((commit) => ({
      sha: commit.sha,
      node_id: commit.sha,
      url: `/api/v3/repos/${owner}/${name}/commits/${commit.sha}`,
      html_url: `/${owner}/${name}/commit/${commit.sha}`,
      commit: { message: commit.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME } },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      parents: [],
    }));
    return ok(200, commits);
  }

  if (section === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const input = asRecord(body);
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok(201, { ref, node_id: ref, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: '' } });
    }
    if (method === 'GET' && tail.length >= 2) {
      const ref = decodeURIComponent(tail.slice(1).join('/'));
      const sha = repo.refs.get(ref);
      if (!sha) return err(404, 'Not Found');
      return ok(200, { ref, node_id: ref, object: { sha, type: 'commit', url: '' } });
    }
    return err(404, 'Not Found');
  }

  if (section === 'contents') {
    return handleContents(store, repo, owner, name, method, tail, query, body);
  }

  if (section === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const input = asRecord(body);
      const labelName = str(input.name).trim();
      if (labelName === '') return err(422, 'Validation Failed: name is required');
      const label = { name: labelName, color: str(input.color, 'ededed').replace(/^#/, ''), description: str(input.description) };
      repo.labels.set(labelName, label);
      return ok(201, labelJson(label));
    }
    if (method === 'GET' && tail.length === 0) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    return err(404, 'Not Found');
  }

  if (section === 'issues') {
    return handleIssues(store, repo, owner, name, method, tail, query, body);
  }

  if (section === 'pulls') {
    return handlePulls(store, repo, owner, name, method, tail, query, body);
  }

  return err(404, 'Not Found');
}

function handleContents(
  store: Store,
  repo: Repo,
  owner: string,
  name: string,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const path = tail.map((segment) => decodeURIComponent(segment)).join('/');
  const branch = query.get('branch') ?? query.get('ref') ?? repo.defaultBranch;
  const input = asRecord(body);

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${ref}`);
    if (!tip) return err(404, 'Not Found');
    const flat = flattenTree(repo.objects, parseCommit(repo.objects.get(tip)!.data).tree);
    if (flat.has(path)) {
      const entry = flat.get(path)!;
      const blob = repo.objects.get(entry.sha);
      if (!blob) return err(404, 'Not Found');
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        content: blob.data.toString('base64'),
        sha: entry.sha,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `/${owner}/${name}/blob/${ref}/${path}`,
      });
    }
    // Directory listing: entries directly under `path`.
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const restPath = filePath.slice(prefix.length);
      const slash = restPath.indexOf('/');
      if (slash === -1) {
        entries.set(restPath, { type: 'file', name: restPath, path: filePath, sha: entry.sha });
      } else {
        const dirName = restPath.slice(0, slash);
        if (!entries.has(dirName)) {
          entries.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '' });
        }
      }
    }
    if (entries.size === 0) return err(404, 'Not Found');
    // Directory shas: resolve the subtree sha when it exists.
    const dirEntries = [...entries.values()].map((entry) => {
      if (entry.type !== 'dir') return entry;
      return { ...entry, sha: subtreeSha(repo, tip, entry.path) ?? entry.sha };
    });
    return ok(200, dirEntries);
  }

  if (method === 'PUT') {
    const contentB64 = str(input.content);
    if (contentB64 === '') return err(422, 'Validation Failed: content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const message = str(input.message, 'Update file');
    const requestedBranch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : branch;
    const ref = `refs/heads/${requestedBranch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const currentFlat = tip ? flattenTree(repo.objects, parseCommit(repo.objects.get(tip)!.data).tree) : new Map();
    const existing = currentFlat.get(path);
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    if (givenSha !== undefined) {
      if (!existing || existing.sha !== givenSha) return err(409, 'Conflict: sha does not match the current file');
    }
    const isUpdate = existing !== undefined;
    const result = store.commitFile(repo, requestedBranch, path, content, message);
    return ok(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, url: '', html_url: '', type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME } },
    });
  }

  if (method === 'DELETE') {
    const message = str(input.message, 'Delete file');
    const requestedBranch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : branch;
    const commitSha = store.deleteFile(repo, requestedBranch, path, message);
    if (commitSha === null) return err(404, 'Not Found');
    return ok(200, { commit: { sha: commitSha, message } });
  }

  return err(404, 'Not Found');
}

function subtreeSha(repo: Repo, commitSha: string, dirPath: string): string | null {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  let treeSha = parseCommit(commit.data).tree;
  const parts = dirPath.split('/').filter(Boolean);
  for (const part of parts) {
    const tree = repo.objects.get(treeSha);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((item) => item.name === part && item.mode === '40000');
    if (!entry) return null;
    treeSha = entry.sha;
  }
  return treeSha;
}

function handleIssues(
  store: Store,
  repo: Repo,
  _owner: string,
  _name: string,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const input = asRecord(body);
  if (tail.length === 0) {
    if (method === 'GET') {
      let list = [...repo.issues];
      const state = query.get('state');
      if (state && state !== 'all') list = list.filter((issue) => issue.state === state);
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), query, '');
      void link;
      return ok(200, page);
    }
    if (method === 'POST') {
      const title = str(input.title).trim();
      if (title === '') return err(422, 'Validation Failed: title is required');
      const labels = Array.isArray(input.labels) ? input.labels.filter((item): item is string => typeof item === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
      }
      const issue = store.createIssue(repo, title, str(input.body), labels);
      return ok(201, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.find((item) => item.number === number);
  if (!issue) return err(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      return ok(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (tail[1] === 'comments') {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => ({ id: comment.id, node_id: comment.globalId, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_TIME, updated_at: FIXED_TIME })));
    }
    if (method === 'POST') {
      const commentBody = str(input.body);
      if (commentBody === '') return err(422, 'Validation Failed: body is required');
      const id = repo.nextCommentId++;
      const comment = { id, globalId: `comment:${repo.id}:${issue.number}:${id}`, body: commentBody };
      issue.comments.push(comment);
      return ok(201, { id, node_id: comment.globalId, body: commentBody, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_TIME, updated_at: FIXED_TIME });
    }
  }
  return err(404, 'Not Found');
}

function handlePulls(
  store: Store,
  repo: Repo,
  _owner: string,
  _name: string,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const input = asRecord(body);
  if (tail.length === 0) {
    if (method === 'GET') {
      let list = [...repo.pulls];
      const state = query.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const { page } = paginate(list.map((pull) => pullJson(repo, pull)), query, '');
      return ok(200, page);
    }
    if (method === 'POST') {
      const head = str(input.head);
      const base = str(input.base);
      const title = str(input.title).trim();
      if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing) return err(422, 'Validation Failed: a pull request already exists for this head and base');
      const pull = store.createPull(repo, title, str(input.body), head, base);
      if (!pull) return err(422, 'Validation Failed: head or base branch does not exist');
      return ok(201, pullJson(repo, pull));
    }
    return err(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pulls.find((item) => item.number === number);
  if (!pull) return err(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(200, pullJson(repo, pull));
    return err(404, 'Not Found');
  }
  if (tail[1] === 'files' && method === 'GET') {
    return ok(200, store.pullFiles(repo, pull));
  }
  if (tail[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') return err(405, 'Pull request is already closed');
    if (store.pullConflict(repo, pull)) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
    const sha = store.mergePull(repo, pull);
    if (sha === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
    return ok(200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
  }
  return err(404, 'Not Found');
}

export { ZERO_OID };
