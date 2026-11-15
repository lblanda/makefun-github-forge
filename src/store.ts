// In-memory store: one process, one owner, deterministic timestamps everywhere.
// A repository is a map of git objects plus refs, labels, issues and pull requests.
// Issues and pull requests share one per-repo number counter, as on GitHub.

import {
  buildCommit,
  buildTree,
  hashObject,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const STRANGER_ID = 1002;
export const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  kind: 'pr';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
  comments: IssueComment[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  seq: number;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

export interface MergeResult {
  treeOid: string;
  conflict: boolean;
}

function authorLine(epoch: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextGlobalId = 1;
  nextCommentId = 1;
  commitSeq = 0;
  requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.repos.size + 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -------------------------------------------------------------------------
  // Opaque (Relay-style) global ids. Deterministic, stable, never the raw number.
  // -------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return `R_repo_${repo.id}`;
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return `I_${repo.id}_${issue.number}`;
  }

  prGlobalId(repo: Repo, pr: PullRequest): string {
    return `P_${repo.id}_${pr.number}`;
  }

  commentGlobalId(comment: IssueComment): string {
    return `C_${comment.id}`;
  }

  parseGlobalId(id: string): { kind: 'repo' | 'issue' | 'pr' | 'comment'; repoDb: number; number: number } | null {
    if (typeof id !== 'string') return null;
    const repoMatch = /^R_repo_(\d+)$/.exec(id);
    if (repoMatch) return { kind: 'repo', repoDb: Number(repoMatch[1]), number: 0 };
    const issueMatch = /^I_(\d+)_(\d+)$/.exec(id);
    if (issueMatch) return { kind: 'issue', repoDb: Number(issueMatch[1]), number: Number(issueMatch[2]) };
    const prMatch = /^P_(\d+)_(\d+)$/.exec(id);
    if (prMatch) return { kind: 'pr', repoDb: Number(prMatch[1]), number: Number(prMatch[2]) };
    const commentMatch = /^C_(\d+)$/.exec(id);
    if (commentMatch) return { kind: 'comment', repoDb: 0, number: Number(commentMatch[1]) };
    return null;
  }

  repoByDatabaseId(databaseId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === databaseId) return repo;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Objects and refs
  // -------------------------------------------------------------------------

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const { oid, object } = makeObject(type, data);
    repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** Create a commit object with deterministic author/committer/timestamps. */
  newCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const epoch = FIXED_EPOCH + this.commitSeq++;
    const line = authorLine(epoch);
    const data = buildCommit(tree, parents, line, line, message);
    return this.putObject(repo, 'commit', data);
  }

  commitMessage(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return '';
    return parseCommit(object.data).message;
  }

  /** All commit oids reachable from `tip` following parents (tip included). */
  ancestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.ancestors(repo, tip).has(ancestor);
  }

  /** First common ancestor by breadth-first search from `a` into `b`'s history. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const bAncestors = this.ancestors(repo, b);
    const queue = [a];
    const seen = new Set<string>([a]);
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++] as string;
      if (bAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Object closure for fetch/clone
  // -------------------------------------------------------------------------

  /** Commits reachable from `tips`, optionally depth-limited (tip counts as depth 1). */
  collectCommits(repo: Repo, tips: readonly string[], depth?: number): { included: string[]; shallow: string[] } {
    // A tag tip is walked from the commit it points at.
    const resolved = tips.map((oid) => {
      let current = oid;
      for (;;) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tag') break;
        current = parseTag(object.data).object;
      }
      return current;
    });
    const included: string[] = [];
    const includedSet = new Set<string>();
    const shallow: string[] = [];
    const queue: Array<{ oid: string; level: number }> = resolved.map((oid) => ({ oid, level: 1 }));
    const seen = new Set<string>();
    let head = 0;
    while (head < queue.length) {
      const { oid, level } = queue[head++] as { oid: string; level: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      included.push(oid);
      includedSet.add(oid);
      const parents = parseCommit(object.data).parents;
      if (depth !== undefined && level >= depth) {
        if (parents.length > 0) shallow.push(oid);
        continue;
      }
      for (const parent of parents) queue.push({ oid: parent, level: level + 1 });
    }
    return { included, shallow };
  }

  private addClosure(repo: Repo, oid: string, into: Map<string, GitObject>): void {
    if (into.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    into.set(oid, object);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      this.addClosure(repo, parsed.tree, into);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) this.addClosure(repo, entry.oid, into);
    } else if (object.type === 'tag') {
      this.addClosure(repo, parseTag(object.data).object, into);
    }
  }

  /**
   * Objects a fetch of `wants` must send, minus objects reachable from `haves`.
   * `depth` limits the commit walk; `shallow` names commits whose parents are
   * withheld, `unshallow` names boundaries that are now fully included.
   */
  fetchObjects(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth?: number,
    boundaries: readonly string[] = [],
  ): { objects: GitObject[]; oids: string[]; shallow: string[]; unshallow: string[] } {
    const { included, shallow } = this.collectCommits(repo, wants, depth);
    // Commits the client already holds: walk ancestors from each have, but do
    // NOT cross a shallow boundary — a shallow clone holds the boundary commit
    // itself, not its parents. (Without this, a deepen fetch would exclude the
    // very parent it is supposed to deliver.)
    const haveCommits = new Set<string>();
    for (const have of haves) {
      const stack = [have];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (haveCommits.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        haveCommits.add(oid);
        if (boundaries.includes(oid)) continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    }
    const sendCommits = included.filter((oid) => !haveCommits.has(oid));
    const send = new Map<string, GitObject>();
    for (const oid of sendCommits) this.addClosure(repo, oid, send);
    // Non-commit wants (annotated tags, trees, blobs) are sent with their closure too.
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object && object.type !== 'commit') this.addClosure(repo, want, send);
    }
    const held = new Map<string, GitObject>();
    for (const oid of haveCommits) this.addClosure(repo, oid, held);
    for (const have of haves) {
      const object = repo.objects.get(have);
      if (object && object.type !== 'commit') this.addClosure(repo, have, held);
    }
    for (const oid of held.keys()) send.delete(oid);
    const unshallow: string[] = [];
    if (depth !== undefined) {
      for (const boundary of boundaries) {
        if (!included.includes(boundary)) continue;
        const object = repo.objects.get(boundary);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.some((parent) => included.includes(parent))) unshallow.push(boundary);
      }
    }
    const oids = [...send.keys()];
    const objects = [...send.values()];
    return { objects, oids, shallow, unshallow };
  }

  // -------------------------------------------------------------------------
  // Trees and paths
  // -------------------------------------------------------------------------

  treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Flatten a tree to path -> {oid, mode} for files only. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, pathPrefix: string): void => {
      for (const entry of this.treeEntries(repo, tree)) {
        const path = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) a tree from a flattened file map. */
  buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    const build = (paths: ReadonlyArray<readonly [string, { oid: string; mode: string }]>): string => {
      const grouped = new Map<string, Array<readonly [string, { oid: string; mode: string }]>>();
      const entries: TreeEntry[] = [];
      for (const [path, value] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: path, oid: value.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = grouped.get(dir) ?? [];
          rest.push([path.slice(slash + 1), value] as const);
          grouped.set(dir, rest);
        }
      }
      for (const [dir, children] of grouped) {
        entries.push({ mode: '40000', name: dir, oid: build(children) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build([...files.entries()]);
  }

  readPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const segments = path.split('/').filter((part) => part.length > 0);
    let current = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const entries = this.treeEntries(repo, current);
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  listDir(repo: Repo, treeOid: string, dirPath: string): TreeEntry[] | null {
    const segments = dirPath.split('/').filter((part) => part.length > 0);
    let current = treeOid;
    for (const segment of segments) {
      const entry = this.treeEntries(repo, current).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return this.treeEntries(repo, current);
  }

  /** Return the new tree oid after setting `path` to `blobOid` (creating dirs). */
  setPath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string): string {
    const segments = path.split('/').filter((part) => part.length > 0);
    const build = (treeOid: string | null, index: number): string => {
      const entries = treeOid ? this.treeEntries(repo, treeOid) : [];
      const name = segments[index] as string;
      if (index === segments.length - 1) {
        const next = entries.filter((entry) => entry.name !== name);
        next.push({ mode: '100644', name, oid: blobOid });
        return this.putObject(repo, 'tree', buildTree(next));
      }
      const existing = entries.find((entry) => entry.name === name);
      const childTree = existing && existing.mode === '40000' ? existing.oid : null;
      const nextChild = build(childTree, index + 1);
      const next = entries.filter((entry) => entry.name !== name);
      next.push({ mode: '40000', name, oid: nextChild });
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(baseTreeOid, 0);
  }

  /** Return the new tree oid after deleting `path`, or null when it is absent. */
  deletePath(repo: Repo, baseTreeOid: string, path: string): string | null {
    const segments = path.split('/').filter((part) => part.length > 0);
    const build = (treeOid: string, index: number): string | null => {
      const entries = this.treeEntries(repo, treeOid);
      const name = segments[index] as string;
      const existing = entries.find((entry) => entry.name === name);
      if (!existing) return null;
      if (index === segments.length - 1) {
        const next = entries.filter((entry) => entry.name !== name);
        return this.putObject(repo, 'tree', buildTree(next));
      }
      if (existing.mode !== '40000') return null;
      const nextChild = build(existing.oid, index + 1);
      if (nextChild === null) return null;
      const next = entries.filter((entry) => entry.name !== name);
      if (this.treeEntries(repo, nextChild).length > 0) next.push({ mode: '40000', name, oid: nextChild });
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(baseTreeOid, 0);
  }

  emptyTreeOid(repo: Repo): string {
    return this.putObject(repo, 'tree', Buffer.alloc(0));
  }

  // -------------------------------------------------------------------------
  // Merge and diff
  // -------------------------------------------------------------------------

  threeWayMerge(repo: Repo, baseTree: string, oursTree: string, theirsTree: string): MergeResult {
    const base = this.flattenTree(repo, baseTree);
    const ours = this.flattenTree(repo, oursTree);
    const theirs = this.flattenTree(repo, theirsTree);
    const merged = new Map<string, { oid: string; mode: string }>();
    let conflict = false;
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
      if (same(o, t)) {
        if (o) merged.set(path, o);
      } else if (same(o, b)) {
        if (t) merged.set(path, t);
      } else if (same(t, b)) {
        if (o) merged.set(path, o);
      } else {
        conflict = true;
        // Keep our side in the tree; the merge is refused anyway.
        if (o) merged.set(path, o);
      }
    }
    return { treeOid: this.buildTreeFromMap(repo, merged), conflict };
  }

  diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): DiffFile[] {
    const oldFiles = oldTree ? this.flattenTree(repo, oldTree) : new Map<string, { oid: string; mode: string }>();
    const newFiles = newTree ? this.flattenTree(repo, newTree) : new Map<string, { oid: string; mode: string }>();
    const out: DiffFile[] = [];
    const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    for (const path of paths) {
      const oldEntry = oldFiles.get(path);
      const newEntry = newFiles.get(path);
      if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
      const oldText = oldEntry ? this.blobText(repo, oldEntry.oid) : '';
      const newText = newEntry ? this.blobText(repo, newEntry.oid) : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({
        filename: path,
        status: !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        oldOid: oldEntry?.oid ?? null,
        newOid: newEntry?.oid ?? null,
      });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  blobBytes(repo: Repo, oid: string): Buffer | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return null;
    return object.data;
  }

  // -------------------------------------------------------------------------
  // Labels, issues, pull requests
  // -------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) {
      existing.color = color;
      return existing;
    }
    const label: Label = { id: this.nextGlobalId++, name, color, description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
    }
    const number = repo.nextNumber++;
    const issue: Issue = {
      kind: 'issue',
      id: this.nextGlobalId++,
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPullRequest(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest | { error: string } {
    for (const pr of repo.pulls.values()) {
      if (pr.state === 'open' && pr.headRef === headRef && pr.baseRef === baseRef) {
        return { error: 'A pull request already exists for this head and base' };
      }
    }
    const number = repo.nextNumber++;
    const pr: PullRequest = {
      kind: 'pr',
      id: this.nextGlobalId++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      seq: number,
      comments: [],
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  createComment(target: Issue | PullRequest, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId++, body };
    target.comments.push(comment);
    return comment;
  }

  /** Merge-base tree vs head tip: the files a pull request changes. */
  prFiles(repo: Repo, pr: PullRequest): DiffFile[] {
    const headTip = this.branchTip(repo, pr.headRef);
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (!headTip || !baseTip) return [];
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base ? parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    return this.diffTrees(repo, baseTree, headTree);
  }

  /** MERGEABLE when the three-way merge is conflict-free and both tips exist. */
  prMergeable(repo: Repo, pr: PullRequest): boolean {
    const headTip = this.branchTip(repo, pr.headRef);
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (!headTip || !baseTip) return false;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (!base) return false;
    const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const oursTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const theirsTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    return !this.threeWayMerge(repo, baseTree, oursTree, theirsTree).conflict;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * oid, or null when the PR is conflicted or a tip is missing.
   */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    const headTip = this.branchTip(repo, pr.headRef);
    const baseTip = this.branchTip(repo, pr.baseRef);
    if (!headTip || !baseTip) return null;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (!base) return null;
    const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const oursTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const theirsTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const { treeOid, conflict } = this.threeWayMerge(repo, baseTree, oursTree, theirsTree);
    if (conflict) return null;
    const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
    const mergeOid = this.newCommit(repo, treeOid, [baseTip], message);
    this.setRef(repo, `refs/heads/${pr.baseRef}`, mergeOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = mergeOid;
    return mergeOid;
  }
}

/** Line multiset diff: additions = lines in `after` not matched in `before`, and vice versa. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const split = (text: string): string[] => (text.length === 0 ? [] : text.split('\n'));
  const beforeLines = split(before);
  const afterLines = split(after);
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of afterLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of counts.values()) deletions += remaining;
  return { additions, deletions };
}

export { ZERO_OID };
export type { GitObject };
