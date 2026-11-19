// The forge's store: every repository, ref, object, issue and pull request lives here,
// in memory, in one process. No filesystem, no outside service.

import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTreeFromPaths,
  flattenTree,
  hashObject,
  identity,
  isAncestor as gitIsAncestor,
  parseCommit,
  parseTree,
  peelToCommit as gitPeelToCommit,
  storeObject,
  type GitObject,
  type GitObjectType,
} from './git.ts';
import { buildScenario, DEFAULT_BRANCH, type Scenario, type ScenarioUser } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  /** Monotonic creation order (ties to number within a repo, but global for sorting). */
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
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
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserView {
  login: string;
  id: number;
  name: string;
  email: string;
  type: string;
}

/** A global id for GraphQL `node()`: base64url of `Kind:key`, opaque and stable. */
export function globalId(kind: string, key: string): string {
  return `${kind}_${Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url')}`;
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  const underscore = id.indexOf('_');
  if (underscore < 0) return null;
  const kind = id.slice(0, underscore);
  try {
    const decoded = Buffer.from(id.slice(underscore + 1), 'base64url').toString('utf8');
    if (!decoded.startsWith(`${kind}:`)) return null;
    return { kind, key: decoded.slice(kind.length + 1) };
  } catch {
    return null;
  }
}

/** The login the token names: the scenario's viewer. */
export function viewerLogin(): string {
  return buildScenario().viewer.login;
}

export function viewerUser(): ScenarioUser {
  return buildScenario().viewer;
}

export function userView(user: ScenarioUser): UserView {
  return { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User' };
}

let requestCounter = 0;
/** A fresh X-GitHub-Request-Id value (non-empty, unique per reply). */
export function newRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

export class Store {
  readonly scenario: Scenario = buildScenario();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private seq = 0;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All refs sorted: HEAD first (as a symref), then refs/heads/*, then refs/tags/*. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
    const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
    const others = [...repo.refs.keys()]
      .filter((name) => !name.startsWith('refs/heads/') && !name.startsWith('refs/tags/'))
      .sort();
    for (const name of [...heads, ...tags, ...others]) {
      out.push({ name, oid: repo.refs.get(name) as string });
    }
    return out;
  }

  /** The commit a ref resolves to (peeling an annotated tag to its commit). */
  peelToCommit(repo: Repo, oid: string): string | null {
    return gitPeelToCommit(repo.objects, oid);
  }

  /** Walk a commit's ancestry (newest first), following parents. */
  walkCommits(repo: Repo, start: string, limit = 10_000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const parsed = parseCommit(obj.data);
      for (const parent of parsed.parents) if (!seen.has(parent)) queue.push(parent);
    }
    return out;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    return gitIsAncestor(repo.objects, ancestor, descendant);
  }

  /** The merge base of two commits: the newest commit reachable from both. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aSet = new Set(this.walkCommits(repo, a));
    const bWalk = this.walkCommits(repo, b);
    for (const oid of bWalk) if (aSet.has(oid)) return oid;
    return null;
  }

  /** The flat file map at a commit (path -> blob oid + mode). */
  filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(obj.data).tree);
  }

  /** Create a commit on a branch with a new file map; updates the ref. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: Map<string, { oid: string; mode: string }>,
    message: string,
    author: { name: string; email: string; epochSec: number },
  ): string {
    const treeOid = buildTreeFromPaths(repo.objects, files);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const parents = tip ? [tip] : [];
    const commit = buildCommit({
      tree: treeOid,
      parents,
      author: identity(author.name, author.email, author.epochSec),
      committer: identity(author.name, author.email, author.epochSec),
      message,
    });
    const oid = storeObject(repo.objects, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The viewer identity, for commits the server makes. */
  serverAuthor(): { name: string; email: string; epochSec: number } {
    const viewer = viewerUser();
    return { name: viewer.name, email: viewer.email, epochSec: Math.floor(Date.now() / 1000) };
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    repo.issueSeq += 1;
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: viewerLogin(),
      comments: [],
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq(),
    };
    this.nextIssueId += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const now = this.nowIso();
    const comment: IssueComment = {
      id: this.nextCommentId,
      body,
      userLogin: viewerLogin(),
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    repo.commentSeq += 1;
    issue.comments.push(comment);
    issue.updatedAt = now;
    return comment;
  }

  // ------------------------------------------------------------- pulls

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return null;
    repo.pullSeq += 1;
    const now = this.nowIso();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      userLogin: viewerLogin(),
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq(),
    };
    this.nextPullId += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The per-path diff between two commits' trees. */
  diffCommits(
    repo: Repo,
    baseOid: string,
    headOid: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> {
    const baseFiles = this.filesAt(repo, baseOid);
    const headFiles = this.filesAt(repo, headOid);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; baseOid: string | null; headOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base && !head) out.push({ path, status: 'removed', baseOid: base.oid, headOid: null });
      else if (!base && head) out.push({ path, status: 'added', baseOid: null, headOid: head.oid });
      else if (base && head && base.oid !== head.oid) out.push({ path, status: 'modified', baseOid: base.oid, headOid: head.oid });
    }
    return out;
  }

  /** Would merging `pull` conflict? A path changed on both sides with different results. */
  mergeConflicts(repo: Repo, pull: Pull): string[] {
    // The base tip is the LIVE base branch tip, not the sha recorded when the pull
    // was opened: another pull may have merged onto it since.
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return ['no base branch'];
    const base = this.mergeBase(repo, pull.headSha, baseTip);
    if (base === null) return ['no merge base'];
    const headDiff = this.diffCommits(repo, base, pull.headSha);
    const baseDiff = this.diffCommits(repo, base, baseTip);
    const baseChanged = new Map(baseDiff.map((entry) => [entry.path, entry.headOid]));
    const conflicts: string[] = [];
    for (const entry of headDiff) {
      if (baseChanged.has(entry.path) && baseChanged.get(entry.path) !== entry.headOid) conflicts.push(entry.path);
    }
    return conflicts;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha,
   * or null when the pull cannot merge (conflict).
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return null;
    const base = this.mergeBase(repo, pull.headSha, baseTip);
    if (base === null) return null;
    if (this.mergeConflicts(repo, pull).length > 0) return null;
    // The merged tree: the base tip's files with the head's changes over the merge base.
    const baseFiles = this.filesAt(repo, baseTip);
    const headDiff = this.diffCommits(repo, base, pull.headSha);
    for (const entry of headDiff) {
      if (entry.status === 'removed') baseFiles.delete(entry.path);
      else if (entry.headOid) baseFiles.set(entry.path, { oid: entry.headOid, mode: '100644' });
    }
    const treeOid = buildTreeFromPaths(repo.objects, baseFiles);
    const author = this.serverAuthor();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: identity(author.name, author.email, author.epochSec),
      committer: identity(author.name, author.email, author.epochSec),
      message,
    });
    const mergeSha = storeObject(repo.objects, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = pull.mergedAt;
    pull.baseSha = mergeSha;
    return mergeSha;
  }

  /** Is a pull request mergeable right now (no conflicts)? */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return 'UNKNOWN';
    if (this.mergeBase(repo, pull.headSha, baseTip) === null) return 'UNKNOWN';
    return this.mergeConflicts(repo, pull).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }
}

/** Line counts for a pull-request file entry: additions/deletions by LCS on lines. */
export function lineDiff(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  // Drop the trailing empty line a trailing newline leaves (git counts lines, not splits).
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS length by DP (files here are small).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      (dp[i] as number[])[j] =
        oldLines[i] === newLines[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
    }
  }
  const lcs = (dp[0] as number[])[0] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

export { buildTag, hashObject, parseCommit, parseTree, storeObject, ZERO_OID };
export type { GitObject, GitObjectType };
