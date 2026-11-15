// REST v3 (api.github.com shape) over the shared store. Every reply is JSON
// with a non-empty X-GitHub-Request-Id; errors are {"message": string}.
// Repos under any owner other than the token owner are 404, never 403.

import { isOid, parseCommit } from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const NOT_FOUND: RestResult = { status: 404, body: { message: 'Not Found' } };

function error(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function stripOneTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO };
  const epoch = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(epoch * 1000).toISOString() };
}

function userView(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: `https://example.invalid/avatar/${VIEWER_LOGIN}`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function repoView(repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: repo.id,
    node_id: `R_repo_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(),
    private: repo.private,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
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
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueView(repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userView(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView(label) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function prView(store: Store, repo: Repo, pr: PullRequest, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? null;
  return {
    id: pr.id,
    node_id: `P_${repo.id}_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userView(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pr.state === 'closed' ? FIXED_ISO : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged: pr.merged,
    mergeable: store.prMergeable(repo, pr),
    draft: false,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: headSha,
      user: userView(),
      repo: repoView(repo, host),
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: baseSha,
      user: userView(),
      repo: repoView(repo, host),
    },
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    commits_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits`,
    comments: pr.comments.length,
  };
}

function commentView(repo: Repo, number: number, comment: IssueComment, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userView(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments/${comment.id}`,
  };
}

function commitView(repo: Repo, oid: string, host: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdent(parsed.author);
  const committer = parseIdent(parsed.committer);
  const base = `http://${host}`;
  return {
    sha: oid,
    node_id: `C_commit_${oid}`,
    commit: {
      message: stripOneTrailingNewline(parsed.message),
      author,
      committer,
      tree: { sha: parsed.tree },
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned' },
    },
    author: userView(),
    committer: userView(),
    parents: parsed.parents.map((sha) => ({ sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` })),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
  };
}

function asObject(body: unknown): Record<string, unknown> | null {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; total: number; perPage: number; pageNumber: number } {
  const perPage = Math.min(intParam(query, 'per_page', 30), 100);
  const pageNumber = intParam(query, 'page', 1);
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, perPage, pageNumber };
}

function resolveCommitRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null) return store.branchTip(repo, repo.defaultBranch) ?? null;
  if (ref.startsWith('refs/heads/')) return store.refTip(repo, ref) ?? null;
  const branchTip = store.branchTip(repo, ref);
  if (branchTip) return branchTip;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  bodyInvalid: boolean,
  host: string,
): RestResult {
  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      body: {
        current_user_url: `http://${host}/api/v3/user`,
        user_url: `http://${host}/api/v3/users/{user}`,
        repository_url: `http://${host}/api/v3/repos/{owner}/{repo}`,
      },
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    };
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, body: userView() };
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, total, perPage, pageNumber } = paginate(repos, query);
      const headers: Record<string, string> = {};
      if (pageNumber * perPage < total) {
        headers.Link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${pageNumber + 1}>; rel="next"`;
      }
      return { status: 200, body: page.map((repo) => repoView(repo, host)), headers };
    }
    if (method === 'POST') {
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      const name = input ? asString(input.name) : null;
      if (!name) return error(422, 'name is required');
      const description = input ? asString(input.description) ?? '' : '';
      const isPrivate = input ? asBoolean(input.private) : false;
      const repo = store.createRepo(VIEWER_LOGIN, name, isPrivate, description);
      if (!repo) return error(422, `Repository '${name}' already exists`);
      return { status: 201, body: repoView(repo, host) };
    }
    return NOT_FOUND;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1] as string);
    const repoName = decodeURIComponent(segments[2] as string);
    if (owner !== VIEWER_LOGIN) return NOT_FOUND;
    const repo = store.getRepo(owner, repoName);
    if (!repo) return NOT_FOUND;
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoView(repo, host) };
      if (method === 'PATCH') {
        if (bodyInvalid) return error(400, 'Invalid JSON');
        const input = asObject(body);
        if (input) {
          const description = asString(input.description);
          if (description !== null) repo.description = description;
        }
        return { status: 200, body: repoView(repo, host) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      return NOT_FOUND;
    }

    // POST /api/v3/repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') return NOT_FOUND;
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      const ref = input ? asString(input.ref) : null;
      const sha = input ? asString(input.sha) : null;
      if (!ref || !sha) return error(422, 'ref and sha are required');
      if (!isOid(sha) || !repo.objects.has(sha)) return error(422, 'Invalid SHA');
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha }, url: `http://${host}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` } };
    }

    // GET /api/v3/repos/{o}/{r}/git/refs/{ref...}
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'GET') return NOT_FOUND;
      const ref = rest.slice(2).map((part) => decodeURIComponent(part)).join('/');
      const tip = repo.refs.get(ref);
      if (!tip) return NOT_FOUND;
      return { status: 200, body: { ref, object: { sha: tip } } };
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return NOT_FOUND;
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid } }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { status: 200, body: branches };
    }

    // GET /api/v3/repos/{o}/{r}/branches/{branch}
    if (rest.length >= 2 && rest[0] === 'branches') {
      if (method !== 'GET') return NOT_FOUND;
      const branch = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      const tip = store.branchTip(repo, branch);
      if (!tip) return NOT_FOUND;
      return {
        status: 200,
        body: {
          name: branch,
          commit: { sha: tip, url: `http://${host}/api/v3/repos/${owner}/${repoName}/commits/${tip}` },
          protected: false,
        },
      };
    }

    // GET /api/v3/repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return NOT_FOUND;
      const ref = query.get('sha');
      const tip = resolveCommitRef(store, repo, ref);
      if (ref !== null && tip === null) return NOT_FOUND;
      const out: Array<Record<string, unknown>> = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const view = commitView(repo, oid, host);
          if (!view) continue;
          out.push(view);
          const object = repo.objects.get(oid);
          if (object && object.type === 'commit') {
            for (const parent of parseCommit(object.data).parents) stack.push(parent);
          }
        }
      }
      const { page } = paginate(out, query);
      return { status: 200, body: page };
    }

    // /api/v3/repos/{o}/{r}/contents/{path}
    if (rest.length >= 1 && rest[0] === 'contents') {
      return handleContents(store, repo, owner, repoName, rest.slice(1), method, query, body, bodyInvalid, host);
    }

    // POST /api/v3/repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') return NOT_FOUND;
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      const name = input ? asString(input.name) : null;
      const color = input ? asString(input.color) ?? 'ededed' : 'ededed';
      if (!name) return error(422, 'name is required');
      const label = store.createLabel(repo, name, color);
      return { status: 201, body: labelView(label) };
    }

    // /api/v3/repos/{o}/{r}/issues[...]
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(store, repo, owner, repoName, rest.slice(1), method, query, body, bodyInvalid, host);
    }

    // /api/v3/repos/{o}/{r}/pulls[...]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(store, repo, owner, repoName, rest.slice(1), method, query, body, bodyInvalid, host);
    }
  }

  return NOT_FOUND;
}

function handleContents(
  store: Store,
  repo: Repo,
  owner: string,
  repoName: string,
  pathParts: string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  bodyInvalid: boolean,
  host: string,
): RestResult {
  const path = pathParts.map((part) => decodeURIComponent(part)).join('/');
  const base = `http://${host}`;
  const branch = query.get('branch') ?? (asObject(body)?.branch as string | undefined) ?? repo.defaultBranch;
  const refParam = query.get('ref');

  if (method === 'GET') {
    const tip = resolveCommitRef(store, repo, refParam ?? branch);
    if (!tip) return NOT_FOUND;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return NOT_FOUND;
    const tree = parseCommit(object.data).tree;
    if (path === '') {
      const entries = store.treeEntries(repo, tree);
      return {
        status: 200,
        body: entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          url: `${base}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(entry.name)}`,
        })),
      };
    }
    const found = store.readPath(repo, tree, path);
    if (!found) return NOT_FOUND;
    if (found.mode === '40000') {
      const entries = store.treeEntries(repo, found.oid);
      return {
        status: 200,
        body: entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          url: `${base}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}/${encodeURIComponent(entry.name)}`,
        })),
      };
    }
    const bytes = repo.objects.get(found.oid)?.data ?? Buffer.alloc(0);
    const name = path.split('/').pop() ?? path;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name,
        path,
        content: bytes.toString('base64'),
        sha: found.oid,
        url: `${base}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`,
        html_url: `${base}/${owner}/${repoName}/blob/${encodeURIComponent(branch)}/${encodeURIComponent(path)}`,
        git_url: `${base}/api/v3/repos/${owner}/${repoName}/git/blobs/${found.oid}`,
        download_url: `${base}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}?raw=1`,
      },
    };
  }

  if (method === 'PUT') {
    if (bodyInvalid) return error(400, 'Invalid JSON');
    const input = asObject(body);
    const message = input ? asString(input.message) : null;
    const content = input ? asString(input.content) : null;
    const sha = input ? asString(input.sha) : null;
    if (!message || content === null) return error(422, 'message and content are required');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content, 'base64');
    } catch {
      return error(422, 'content is not valid base64');
    }
    const branchName = typeof branch === 'string' ? branch : repo.defaultBranch;
    const currentTip = store.branchTip(repo, branchName);
    let parentTip: string | null = currentTip ?? null;
    if (!currentTip) {
      // A new branch starts from the default tip (or nothing on an unborn repo).
      parentTip = branchName === repo.defaultBranch ? null : store.branchTip(repo, repo.defaultBranch) ?? null;
    }
    const parentTree = parentTip ? parseCommit(repo.objects.get(parentTip)?.data ?? Buffer.alloc(0)).tree : null;
    const existing = parentTree ? store.readPath(repo, parentTree, path) : null;
    if (sha) {
      if (!existing || existing.oid !== sha) return error(409, 'sha does not match the current file');
    } else if (existing) {
      return error(422, 'sha is required to update an existing file');
    }
    const blobOid = store.putObject(repo, 'blob', bytes);
    const newTree = store.setPath(repo, parentTree, path, blobOid);
    const parents = parentTip ? [parentTip] : [];
    const commitOid = store.newCommit(repo, newTree, parents, message);
    store.setRef(repo, `refs/heads/${branchName}`, commitOid);
    const name = path.split('/').pop() ?? path;
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          name,
          path,
          sha: blobOid,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
          url: `${base}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`,
        },
        commit: { sha: commitOid, message },
      },
    };
  }

  if (method === 'DELETE') {
    if (bodyInvalid) return error(400, 'Invalid JSON');
    const input = asObject(body);
    const message = input ? asString(input.message) : null;
    const sha = input ? asString(input.sha) : null;
    if (!message || !sha) return error(422, 'message and sha are required');
    const branchName = typeof branch === 'string' ? branch : repo.defaultBranch;
    const currentTip = store.branchTip(repo, branchName);
    if (!currentTip) return NOT_FOUND;
    const parentTree = parseCommit(repo.objects.get(currentTip)?.data ?? Buffer.alloc(0)).tree;
    const existing = store.readPath(repo, parentTree, path);
    if (!existing) return NOT_FOUND;
    if (existing.oid !== sha) return error(409, 'sha does not match the current file');
    const newTree = store.deletePath(repo, parentTree, path);
    if (newTree === null) return NOT_FOUND;
    const commitOid = store.newCommit(repo, newTree, [currentTip], message);
    store.setRef(repo, `refs/heads/${branchName}`, commitOid);
    return { status: 200, body: { content: null, commit: { sha: commitOid, message } } };
  }

  return NOT_FOUND;
}

function handleIssues(
  store: Store,
  repo: Repo,
  owner: string,
  repoName: string,
  rest: string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  bodyInvalid: boolean,
  host: string,
): RestResult {
  // GET/POST /api/v3/repos/{o}/{r}/issues
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page } = paginate(issues, query);
      return { status: 200, body: page.map((issue) => issueView(repo, issue, host)) };
    }
    if (method === 'POST') {
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      const title = input ? asString(input.title) : null;
      if (!title) return error(422, 'title is required');
      const bodyText = input ? asString(input.body) ?? '' : '';
      const labels = input && Array.isArray(input.labels) ? (input.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      const created = store.createIssue(repo, title, bodyText, labels);
      if ('error' in created) return error(422, created.error);
      return { status: 201, body: issueView(repo, created, host) };
    }
    return NOT_FOUND;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return NOT_FOUND;

  // /api/v3/repos/{o}/{r}/issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    const issue = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!issue) return NOT_FOUND;
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentView(repo, number, comment, host)) };
    }
    if (method === 'POST') {
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      const bodyText = input ? asString(input.body) : null;
      if (!bodyText) return error(422, 'body is required');
      const comment = store.createComment(issue, bodyText);
      return { status: 201, body: commentView(repo, number, comment, host) };
    }
    return NOT_FOUND;
  }

  // GET/PATCH /api/v3/repos/{o}/{r}/issues/{n}
  if (rest.length === 1) {
    const issue = repo.issues.get(number);
    if (!issue) return NOT_FOUND;
    if (method === 'GET') return { status: 200, body: issueView(repo, issue, host) };
    if (method === 'PATCH') {
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      if (input) {
        const state = asString(input.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(input.title);
        if (title !== null) issue.title = title;
        const bodyText = asString(input.body);
        if (bodyText !== null) issue.body = bodyText;
      }
      return { status: 200, body: issueView(repo, issue, host) };
    }
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

function handlePulls(
  store: Store,
  repo: Repo,
  owner: string,
  repoName: string,
  rest: string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  bodyInvalid: boolean,
  host: string,
): RestResult {
  // GET/POST /api/v3/repos/{o}/{r}/pulls
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      const { page } = paginate(pulls, query);
      return { status: 200, body: page.map((pr) => prView(store, repo, pr, host)) };
    }
    if (method === 'POST') {
      if (bodyInvalid) return error(400, 'Invalid JSON');
      const input = asObject(body);
      const title = input ? asString(input.title) : null;
      const head = input ? asString(input.head) : null;
      const base = input ? asString(input.base) : null;
      if (!title || !head || !base) return error(422, 'title, head and base are required');
      if (!store.branchTip(repo, head)) return error(422, `head branch '${head}' does not exist`);
      if (!store.branchTip(repo, base)) return error(422, `base branch '${base}' does not exist`);
      const bodyText = input ? asString(input.body) ?? '' : '';
      const created = store.createPullRequest(repo, title, bodyText, head, base);
      if ('error' in created) return error(422, created.error);
      return { status: 201, body: prView(store, repo, created, host) };
    }
    return NOT_FOUND;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return NOT_FOUND;
  const pr = repo.pulls.get(number);
  if (!pr) return NOT_FOUND;

  // GET /api/v3/repos/{o}/{r}/pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return NOT_FOUND;
    const files = store.prFiles(repo, pr);
    return {
      status: 200,
      body: files.map((file) => ({
        sha: file.newOid ?? file.oldOid ?? '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    };
  }

  // PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return NOT_FOUND;
    if (pr.merged) return error(405, 'Pull request is already merged');
    if (pr.state !== 'open') return error(405, 'Pull request is closed');
    const mergeOid = store.squashMerge(repo, pr);
    if (!mergeOid) return error(405, 'Merge conflict');
    return { status: 200, body: { sha: mergeOid, merged: true, message: 'Pull request successfully merged' } };
  }

  // GET /api/v3/repos/{o}/{r}/pulls/{n}
  if (rest.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, body: prView(store, repo, pr, host) };
  }

  return NOT_FOUND;
}
