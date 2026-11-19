// The REST v3 surface: repositories, branches, commits, git refs, contents, labels,
// issues, comments and pull requests. Every reply is JSON with an X-GitHub-Request-Id.

import { hashObject, parseCommit, parseTree, storeObject } from './git.ts';
import {
  lineDiff,
  newRequestId,
  userView,
  viewerLogin,
  viewerUser,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  baseUrl: string;
  body: unknown;
  bodyMalformed: boolean;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const message = (status: number, text: string): RestReply => json(status, { message: text });
const notFound = (what = 'Not Found'): RestReply => message(404, what);
const badRequest = (text: string): RestReply => message(400, text);
const unprocessable = (text: string): RestReply => message(422, text);
const conflict = (text: string): RestReply => message(409, text);

/** Paginate a list; returns the page and the Link header value (or ''). */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${baseUrl}${path}?${q.toString()}`;
  };
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(pages)}>; rel="last"`);
  return { page: slice, link: links.join(', ') };
}

function linkHeader(reply: RestReply, link: string): RestReply {
  if (link === '') return reply;
  return { ...reply, headers: { ...(reply.headers ?? {}), link } };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = viewerUser();
  return {
    id: repo.id,
    node_id: `R_${Buffer.from(`repo:${repo.owner}/${repo.name}`).toString('base64url')}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    fork: false,
    archived: false,
    disabled: false,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    size: 0,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${Buffer.from(`issue:${repo.owner}/${repo.name}:${issue.number}`).toString('base64url')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: null, default: false })),
    user: userView(viewerUser()),
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    locked: false,
    draft: false,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeable = pull.state === 'open' ? true : false;
  return {
    id: pull.id,
    node_id: `P_${Buffer.from(`pull:${repo.owner}/${repo.name}:${pull.number}`).toString('base64url')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: userView(viewerUser()),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    locked: false,
  };
}

function requireRepo(store: Store, owner: string, name: string): Repo | RestReply {
  if (owner !== viewerLogin()) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  return repo;
}

function isReply(value: Repo | RestReply): value is RestReply {
  return typeof (value as RestReply).status === 'number';
}

function refObjectType(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  return obj ? obj.type : 'commit';
}

function decodePathSegments(segments: readonly string[]): string {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

/** Resolve a ref name (branch, tag, or sha) to a commit oid, or null. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const peeled = store.peelToCommit(repo, ref.toLowerCase());
    return peeled;
  }
  const direct = repo.refs.get(ref);
  if (direct) return store.peelToCommit(repo, direct);
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return store.peelToCommit(repo, branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag) return store.peelToCommit(repo, tag);
  return null;
}

/** The entrypoint: route one REST request. */
export function handleRest(store: Store, req: RestRequest): RestReply {
  const { method, segments } = req;
  if (req.bodyMalformed) return badRequest('Invalid JSON body');

  // GET /api/v3 and /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: `${req.baseUrl}/api/v3/user`,
      repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_url: `${req.baseUrl}/api/v3/users/{username}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0' });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, userView(viewerUser()));
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length !== 2) return notFound();
    if (method === 'GET') {
      const repos = store.listRepos(viewerLogin());
      const { page, link } = paginate(repos, req.query, req.baseUrl, '/api/v3/user/repos');
      return linkHeader(json(200, page.map((repo) => repoJson(store, repo))), link);
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return unprocessable('name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return unprocessable('invalid repository name');
      if (store.getRepo(viewerLogin(), name)) return unprocessable('name already exists on this account');
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(viewerLogin(), name, description, isPrivate);
      return json(201, repoJson(store, repo));
    }
    return notFound();
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1] as string);
    const name = decodeURIComponent(segments[2] as string);
    const repoOrReply = requireRepo(store, owner, name);
    if (isReply(repoOrReply)) return repoOrReply;
    const repo = repoOrReply;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
          repo.defaultBranch = body.default_branch;
        }
        repo.updatedAt = store.nowIso();
        return json(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return notFound();
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) as string },
            protected: false,
          }));
        return json(200, branches);
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = decodePathSegments(rest.slice(1));
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return notFound('Branch not found');
        return json(200, { name: branch, commit: { sha: tip }, protected: false });
      }
      return notFound();
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const tip = resolveRef(store, repo, req.query.get('sha'));
        if (!tip) return notFound('No commits');
        const walked = store.walkCommits(repo, tip);
        const { page, link } = paginate(walked, req.query, req.baseUrl, `/api/v3/repos/${owner}/${name}/commits`);
        const entries = page.map((sha) => {
          const obj = repo.objects.get(sha);
          const commit = obj ? parseCommit(obj.data) : null;
          const authorLine = commit?.author ?? '';
          const committerLine = commit?.committer ?? '';
          const authorParts = authorLine.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/) ?? null;
          const committerParts = committerLine.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/) ?? null;
          const authorDate = authorParts ? new Date(Number(authorParts[3]) * 1000).toISOString() : repo.createdAt;
          const committerDate = committerParts ? new Date(Number(committerParts[3]) * 1000).toISOString() : repo.createdAt;
          return {
            sha,
            commit: {
              message: commit?.message ?? '',
              author: { name: authorParts?.[1] ?? viewerUser().name, email: authorParts?.[2] ?? viewerUser().email, date: authorDate },
              committer: { name: committerParts?.[1] ?? viewerUser().name, email: committerParts?.[2] ?? viewerUser().email, date: committerDate },
              tree: { sha: commit?.tree ?? '' },
            },
            author: { login: viewerLogin() },
            committer: { login: viewerLogin() },
            parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
          };
        });
        return linkHeader(json(200, entries), link);
      }
      return notFound();
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'GET') {
        const refs = [...repo.refs.keys()].sort().map((ref) => ({
          ref,
          object: { sha: repo.refs.get(ref) as string, type: refObjectType(repo, repo.refs.get(ref) as string) },
        }));
        return json(200, refs);
      }
      if (rest.length === 2 && method === 'POST') {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
        if (!ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
        if (!/^[0-9a-f]{40}$/.test(sha)) return unprocessable('sha is not a valid object id');
        if (!repo.objects.has(sha)) return unprocessable('object does not exist');
        if (repo.refs.has(ref)) return unprocessable('ref already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: refObjectType(repo, sha) } });
      }
      if (rest.length >= 3) {
        const ref = `refs/${decodePathSegments(rest.slice(2))}`;
        if (method === 'GET') {
          const tip = repo.refs.get(ref);
          if (!tip) return notFound('Reference does not exist');
          return json(200, { ref, object: { sha: tip, type: refObjectType(repo, tip) } });
        }
        if (method === 'DELETE') {
          if (!repo.refs.has(ref)) return notFound('Reference does not exist');
          repo.refs.delete(ref);
          return { status: 204, body: null };
        }
        if (method === 'PATCH') {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
          if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) return unprocessable('sha is not a valid object id');
          if (!repo.refs.has(ref)) return notFound('Reference does not exist');
          repo.refs.set(ref, sha);
          return json(200, { ref, object: { sha, type: refObjectType(repo, sha) } });
        }
        return notFound();
      }
      return notFound();
    }

    if (rest[0] === 'contents') {
      return handleContents(store, repo, req, rest.slice(1));
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        return json(200, [...repo.labels.values()]);
      }
      if (rest.length === 1 && method === 'POST') {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const labelName = typeof body.name === 'string' ? body.name.trim() : '';
        if (labelName === '') return unprocessable('name is required');
        if (repo.labels.has(labelName)) return unprocessable('label already exists');
        const color = typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed';
        const label: Label = { name: labelName, color };
        repo.labels.set(labelName, label);
        return json(201, { name: label.name, color: label.color, description: null, default: false });
      }
      return notFound();
    }

    if (rest[0] === 'issues') {
      return handleIssues(store, repo, req, rest.slice(1));
    }

    if (rest[0] === 'pulls') {
      return handlePulls(store, repo, req, rest.slice(1));
    }

    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- contents

function handleContents(store: Store, repo: Repo, req: RestRequest, pathSegments: readonly string[]): RestReply {
  const { method } = req;
  const path = decodePathSegments(pathSegments);
  if (path === '') return notFound('Not Found');
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (method === 'GET') {
    const tip = resolveRef(store, repo, req.query.get('ref'));
    if (!tip) return notFound('Not Found');
    const files = store.filesAt(repo, tip);
    const direct = files.get(path);
    if (direct) {
      const obj = repo.objects.get(direct.oid);
      const bytes = obj ? obj.data : Buffer.alloc(0);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: path.split('/').pop() ?? path,
        path,
        content: bytes.toString('base64'),
        sha: direct.oid,
      });
    }
    // A directory: entries directly below it.
    const prefix = `${path}/`;
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [filePath, file] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ type: 'file', name: rest, path: filePath, sha: file.oid, size: (repo.objects.get(file.oid)?.data.length ?? 0) });
      } else {
        const dirName = rest.slice(0, slash);
        if (seenDirs.has(dirName)) continue;
        seenDirs.add(dirName);
        // The tree oid of the subdirectory: walk the tree to find it.
        const dirTree = findTreeOid(store, repo, tip, path);
        entries.push({ type: 'dir', name: dirName, path: `${path}/${dirName}`, sha: dirTree ?? '' });
      }
    }
    if (entries.length === 0) return notFound('Not Found');
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, entries);
  }

  if (method === 'PUT') {
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const messageText = typeof body.message === 'string' ? body.message : 'Update file';
    if (contentB64 === '') return unprocessable('content is required');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      // A new branch starts from the default branch tip (or unborn when empty).
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = repo.refs.get(`refs/heads/${branch}`);
    }
    const files = tip ? store.filesAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
    const blobOid = hashObject('blob', bytes);
    storeObject(repo.objects, 'blob', bytes);
    if (existing) {
      if (givenSha === '') return conflict('sha is required to update a file');
      if (givenSha !== existing.oid) return conflict('sha does not match the current file');
      files.set(path, { oid: blobOid, mode: existing.mode });
      const commitSha = store.commitFiles(repo, branch, files, messageText, store.serverAuthor());
      return json(200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', content: bytes.toString('base64') },
        commit: { sha: commitSha },
      });
    }
    files.set(path, { oid: blobOid, mode: '100644' });
    const commitSha = store.commitFiles(repo, branch, files, messageText, store.serverAuthor());
    return json(201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', content: bytes.toString('base64') },
      commit: { sha: commitSha },
    });
  }

  if (method === 'DELETE') {
    const messageText = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound('Not Found');
    const files = store.filesAt(repo, tip);
    const existing = files.get(path);
    if (!existing) return notFound('Not Found');
    const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
    if (givenSha !== '' && givenSha !== existing.oid) return conflict('sha does not match the current file');
    files.delete(path);
    const commitSha = store.commitFiles(repo, branch, files, messageText, store.serverAuthor());
    return json(200, { commit: { sha: commitSha } });
  }

  return notFound();
}

/** The tree oid of a directory path at a commit (for directory listings). */
function findTreeOid(store: Store, repo: Repo, commitOid: string, dirPath: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  for (const segment of dirPath.split('/')) {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, repo: Repo, req: RestRequest, rest: readonly string[]): RestReply {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(issues, req.query, req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return linkHeader(json(200, page.map((issue) => issueJson(repo, issue))), link);
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('title is required');
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const requested = Array.isArray(body.labels) ? body.labels : [];
      const labels: Label[] = [];
      for (const entry of requested) {
        const labelName = typeof entry === 'string' ? entry : typeof (entry as Record<string, unknown>).name === 'string' ? String((entry as Record<string, unknown>).name) : '';
        const label = repo.labels.get(labelName);
        if (!label) return unprocessable(`label ${labelName} does not exist`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, bodyText, labels);
      return json(201, issueJson(repo, issue));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const issue = store.getIssue(repo, number);
  if (!issue) return notFound('Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels: Label[] = [];
        for (const entry of body.labels) {
          const labelName = typeof entry === 'string' ? entry : typeof (entry as Record<string, unknown>).name === 'string' ? String((entry as Record<string, unknown>).name) : '';
          const label = repo.labels.get(labelName);
          if (!label) return unprocessable(`label ${labelName} does not exist`);
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = store.nowIso();
      return json(200, issueJson(repo, issue));
    }
    return notFound();
  }

  if (rest[0] !== undefined && rest[1] === 'comments') {
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: userView(viewerUser()),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })));
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return unprocessable('body is required');
      const comment = store.addComment(repo, issue, text);
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: userView(viewerUser()),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      });
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- pulls

function handlePulls(store: Store, repo: Repo, req: RestRequest, rest: readonly string[]): RestReply {
  const { method } = req;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(pulls, req.query, req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return linkHeader(json(200, page.map((pull) => pullJson(repo, pull))), link);
    }
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return unprocessable('title and head are required');
      if (!repo.refs.has(`refs/heads/${head}`)) return unprocessable(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return unprocessable(`base branch ${base} does not exist`);
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return unprocessable('a pull request for this head branch already exists');
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const pull = store.createPull(repo, title, bodyText, head, base);
      if (!pull) return unprocessable('could not create the pull request');
      return json(201, pullJson(repo, pull));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const pull = store.getPull(repo, number);
  if (!pull) return notFound('Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return json(200, pullJson(repo, pull));
    return notFound();
  }

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const base = store.mergeBase(repo, pull.headSha, pull.baseSha);
    if (base === null) return json(200, []);
    const diff = store.diffCommits(repo, base, pull.headSha);
    const files = diff.map((entry) => {
      const oldText = entry.baseOid ? (repo.objects.get(entry.baseOid)?.data.toString('utf8') ?? null) : null;
      const newText = entry.headOid ? (repo.objects.get(entry.headOid)?.data.toString('utf8') ?? null) : null;
      const counts = lineDiff(oldText, newText);
      const status = entry.status === 'added' ? 'added' : entry.status === 'modified' ? 'modified' : 'removed';
      return {
        filename: entry.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${entry.path}`,
        raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${entry.path}`,
        contents_url: `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}?ref=${pull.headSha}`,
        patch: '',
      };
    });
    return json(200, files);
  }

  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    if (pull.merged) return conflict('the pull request is already merged');
    if (pull.state !== 'open') return conflict('the pull request is closed');
    const conflicts = store.mergeConflicts(repo, pull);
    if (conflicts.length > 0) return message(405, `merge conflict in ${conflicts.join(', ')}`);
    const mergeSha = store.mergePull(repo, pull);
    if (!mergeSha) return message(405, 'merge conflict');
    return json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
  }

  return notFound();
}

export { newRequestId };
