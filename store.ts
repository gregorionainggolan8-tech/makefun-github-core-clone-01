// store.ts — the forge's in-memory store: repositories, issues, pull requests and
// their git objects. One store backs REST, GraphQL, MCP and smart HTTP alike, so an
// object created on one surface reads back identically on the others.
import {
  ObjectStore,
  buildTreeFromFlat,
  flattenTree,
  isAncestor,
  mergeBase,
  objectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Fixed timestamps: the forge never reads the wall clock, so two runs agree byte for byte. */
export const FIXED_TIME = '2026-11-14T06:30:00Z';
export const FIXED_EPOCH = 1731556200;

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
}

export interface Issue {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  globalId: string;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: ObjectStore;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return null;
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      globalId: globalId('repo', id),
      name,
      owner: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new ObjectStore(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq++,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Create a commit on `branch` that sets one file; creates the branch if missing. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref) ?? this.defaultTip(repo);
    const blobSha = repo.objects.put('blob', content);
    let flat = new Map<string, { mode: string; sha: string }>();
    if (parent) {
      const parentCommit = repo.objects.get(parent);
      if (parentCommit && parentCommit.type === 'commit') {
        flat = flattenTree(repo.objects, parseCommit(parentCommit.data).tree);
      }
    }
    flat.set(path, { mode: '100644', sha: blobSha });
    const treeSha = buildTreeFromFlat(repo.objects, flat);
    const lines = [`tree ${treeSha}`];
    if (parent) lines.push(`parent ${parent}`);
    lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
    lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
    const commitSha = repo.objects.put('commit', Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8'));
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete one file on `branch`; returns the new commit sha, or null when the file is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    if (!parent) return null;
    const parentCommit = repo.objects.get(parent);
    if (!parentCommit || parentCommit.type !== 'commit') return null;
    const flat = flattenTree(repo.objects, parseCommit(parentCommit.data).tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeSha = buildTreeFromFlat(repo.objects, flat);
    const lines = [`tree ${treeSha}`, `parent ${parent}`];
    lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
    lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
    const commitSha = repo.objects.put('commit', Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8'));
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  /** Commits reachable from `ref`, newest first. */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    if (!tip) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      const info = parseCommit(object.data);
      out.push({ sha, message: info.message });
      queue.push(...info.parents);
    }
    return out;
  }

  /** Flat file map of a commit's tree (or null when the commit is unknown). */
  treeFlat(repo: Repo, commitSha: string): Map<string, { mode: string; sha: string }> | null {
    const object = repo.objects.get(commitSha);
    if (!object || object.type !== 'commit') return null;
    return flattenTree(repo.objects, parseCommit(object.data).tree);
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      number,
      globalId: globalId('issue', repo.id, number),
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq++,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return null;
    const number = repo.nextNumber++;
    const pull: Pull = {
      number,
      globalId: globalId('pull', repo.id, number),
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq++,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Files changed between the base tip and the head tip of a pull request. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFlat = this.treeFlat(repo, pull.baseSha) ?? new Map();
    const headFlat = this.treeFlat(repo, pull.headSha) ?? new Map();
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      if (base && head && base.sha === head.sha) continue;
      const status = !base ? 'added' : !head ? 'removed' : 'modified';
      const { additions, deletions } = lineDiff(repo, base?.sha, head?.sha);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Is this pull request mergeable (no file changed on both sides with different results)? */
  pullConflict(repo: Repo, pull: Pull): boolean {
    // The base is the branch's live tip, not the tip recorded when the pull opened:
    // a merge that landed after the pull opened can conflict with it.
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(repo.objects, pull.headSha, baseTip);
    if (base === null) return false;
    const baseFlat = this.treeFlat(repo, base) ?? new Map();
    const headFlat = this.treeFlat(repo, pull.headSha) ?? new Map();
    const targetFlat = this.treeFlat(repo, baseTip) ?? new Map();
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.sha;
      const h = headFlat.get(path)?.sha;
      const t = targetFlat.get(path)?.sha;
      const headChanged = h !== b;
      const targetChanged = t !== b;
      if (headChanged && targetChanged && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflict(repo, pull)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(repo.objects, pull.headSha, baseTip);
    const baseFlat = base ? this.treeFlat(repo, base) ?? new Map() : new Map();
    const headFlat = this.treeFlat(repo, pull.headSha) ?? new Map();
    const targetFlat = this.treeFlat(repo, baseTip) ?? new Map();
    const merged = new Map(targetFlat);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.sha;
      const h = headFlat.get(path);
      if (h?.sha !== b) {
        if (h) merged.set(path, { mode: h.mode, sha: h.sha });
        else merged.delete(path);
      }
    }
    const treeSha = buildTreeFromFlat(repo.objects, merged);
    const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}:${pull.headRef}`;
    const lines = [`tree ${treeSha}`, `parent ${baseTip}`];
    lines.push(`author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
    lines.push(`committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`);
    const commitSha = repo.objects.put('commit', Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8'));
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeCommitSha = commitSha;
    return commitSha;
  }
}

function lineDiff(repo: Repo, baseSha: string | undefined, headSha: string | undefined): { additions: number; deletions: number } {
  const read = (sha: string | undefined): string[] => {
    if (!sha) return [];
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'blob') return [];
    return object.data.toString('utf8').split('\n');
  };
  const baseLines = read(baseSha);
  const headLines = read(headSha);
  const baseCounts = new Map<string, number>();
  for (const line of baseLines) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of headLines) {
    const left = baseCounts.get(line) ?? 0;
    if (left > 0) baseCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of baseCounts.values()) deletions += left;
  return { additions, deletions };
}

export { ZERO_OID };
export type { GitObject };
export { isAncestor, objectId, parseTree };
