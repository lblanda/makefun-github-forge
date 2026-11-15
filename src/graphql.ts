// GraphQL v4: a small parser and executor covering the documents the suite
// uses (viewer, repository, issues, pull requests, mutations, node, __type).
// Unknown fields return HTTP 200 with an `errors` array naming the field;
// unknown repositories return data.repository = null with no errors.
// Global ids are opaque (R_repo_<n>, I_<db>_<n>, P_<db>_<n>) and stable.

import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_A-Za-z0-9]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j++;
      while (j < source.length && isDigit(source[j] as string)) j++;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j++;
        while (j < source.length && isDigit(source[j] as string)) j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j++;
        if (source[j] === '+' || source[j] === '-') j++;
        while (j < source.length && isDigit(source[j] as string)) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type Selection =
  | { kind: 'field'; alias?: string; name: string; args: Record<string, ValueNode>; children: Selection[] }
  | { kind: 'inline'; typeCondition?: string; children: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variables: Record<string, ValueNode>;
  fields: Selection[];
}

interface Fragment {
  name: string;
  typeCondition: string;
  fields: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos++;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expect('on');
        const typeCondition = this.expectName();
        const fields = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, fields });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const variables: Record<string, ValueNode> = {};
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = token.value as 'query' | 'mutation';
      this.next();
      if (this.peek().kind === 'name') name = this.next().value;
    }
    if (this.peek().value === '(') this.parseVariableDefinitions(variables);
    const fields = this.parseSelectionSet();
    return { operation, name, variables, fields };
  }

  private parseVariableDefinitions(variables: Record<string, ValueNode>): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      // Skip the type: names, brackets and '!' until ',' ')' or '='.
      let depth = 0;
      while (true) {
        const token = this.peek();
        if (token.value === '[') depth++;
        if (token.value === ']') depth--;
        if (depth === 0 && (token.value === ',' || token.value === ')' || token.value === '=')) break;
        if (token.kind === 'eof') break;
        this.next();
      }
      if (this.peek().value === '=') {
        this.next();
        variables[name] = this.parseValue();
      }
      if (this.peek().value === ',') this.next();
    }
    this.expect(')');
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, children: this.parseSelectionSet() };
      }
      if (this.peek().value === '{') {
        return { kind: 'inline', children: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: this.expectName() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        const argName = this.expectName();
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek().value === ',') this.next();
      }
      this.expect(')');
    }
    // Directives: skip @name[(...)].
    while (this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().value === '(') {
        let depth = 0;
        do {
          const token = this.next();
          if (token.value === '(' || token.value === '[' || token.value === '{') depth++;
          if (token.value === ')' || token.value === ']' || token.value === '}') depth--;
        } while (depth > 0 && this.peek().kind !== 'eof');
      }
    }
    const children = this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, children };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek().value !== ']') {
        values.push(this.parseValue());
        if (this.peek().value === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek().value !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields[name] = this.parseValue();
        if (this.peek().value === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema (for __type introspection)
// ---------------------------------------------------------------------------

const SCHEMA_TYPES: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository', 'mergeCommit'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'description', 'isPrivate'],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'] },
  Viewer: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type Typed =
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'object'; type: string; value: unknown }
  | { kind: 'list'; itemType: string; items: Typed[] };

interface ExecContext {
  store: Store;
  host: string;
  fragments: Map<string, Fragment>;
  errors: Array<{ message: string }>;
}

function scalar(value: string | number | boolean | null): Typed {
  return { kind: 'scalar', value };
}

function obj(type: string, value: unknown): Typed {
  return { kind: 'object', type, value };
}

function list(itemType: string, items: Typed[]): Typed {
  return { kind: 'list', itemType, items };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueTyped(repo: Repo, issue: Issue): Typed {
  return obj('Issue', { repo, issue });
}

function prTyped(repo: Repo, pr: PullRequest): Typed {
  return obj('PullRequest', { repo, pr });
}

function repoTyped(repo: Repo): Typed {
  return obj('Repository', repo);
}

function resolveIssuesConnection(repo: Repo, args: Record<string, unknown>): Typed {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = orderBy.direction ?? 'ASC';
  let issues = [...repo.issues.values()];
  if (states.length > 0) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const after = numberFromCursor(args.after);
  if (after !== null) {
    issues = direction === 'DESC' ? issues.filter((issue) => issue.number < after) : issues.filter((issue) => issue.number > after);
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return obj('IssueConnection', { repo, nodes: page, hasNextPage, endCursor, totalCount: issues.length });
}

function resolvePullRequestsConnection(repo: Repo, args: Record<string, unknown>): Typed {
  const first = typeof args.first === 'number' ? args.first : 100;
  const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const after = numberFromCursor(args.after);
  const filtered = after !== null ? pulls.filter((pr) => pr.number < after) : pulls;
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return obj('PullRequestConnection', { repo, nodes: page, hasNextPage, endCursor, totalCount: filtered.length });
}

function resolveField(parentType: string, parent: unknown, name: string, args: Record<string, unknown>, ctx: ExecContext): Typed | null | 'unknown' {
  const store = ctx.store;
  switch (parentType) {
    case 'Query': {
      if (name === 'viewer') return obj('Viewer', null);
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (!owner || !repoName) return null;
        const repo = store.getRepo(owner, repoName);
        if (!repo || owner !== VIEWER_LOGIN) return null;
        return repoTyped(repo);
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        if (!id) return null;
        const parsed = store.parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.kind === 'repo') {
          const repo = store.repoByDatabaseId(parsed.repoDb);
          return repo ? repoTyped(repo) : null;
        }
        if (parsed.kind === 'issue') {
          const repo = store.repoByDatabaseId(parsed.repoDb);
          const issue = repo?.issues.get(parsed.number);
          return repo && issue ? issueTyped(repo, issue) : null;
        }
        if (parsed.kind === 'pr') {
          const repo = store.repoByDatabaseId(parsed.repoDb);
          const pr = repo?.pulls.get(parsed.number);
          return repo && pr ? prTyped(repo, pr) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = args.name as string | undefined;
        if (!typeName || !SCHEMA_TYPES[typeName]) return null;
        return obj('__Type', { name: typeName });
      }
      if (name === '__schema') return obj('__Schema', {});
      return 'unknown';
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = store.parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.kind === 'repo' ? store.repoByDatabaseId(parsed.repoDb) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return null;
        }
        const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return null;
        }
        return obj('CreateIssuePayload', { repo, issue: created });
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = store.parseGlobalId(String(input.issueId ?? ''));
        const repo = parsed?.kind === 'issue' ? store.repoByDatabaseId(parsed.repoDb) : undefined;
        const issue = repo?.issues.get(parsed?.number ?? 0);
        if (!repo || !issue) {
          ctx.errors.push({ message: 'issue not found' });
          return null;
        }
        issue.state = 'closed';
        return obj('CloseIssuePayload', { repo, issue });
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = store.parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed?.kind === 'repo' ? store.repoByDatabaseId(parsed.repoDb) : undefined;
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          return null;
        }
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (!ctx.store.branchTip(repo, headRef) || !ctx.store.branchTip(repo, baseRef)) {
          ctx.errors.push({ message: 'head or base branch not found' });
          return null;
        }
        const existing = [...repo.pulls.values()].find(
          (pr) => pr.state === 'open' && pr.headRef === headRef && pr.baseRef === baseRef,
        );
        if (existing) return obj('CreatePullRequestPayload', { repo, pr: existing });
        const created = store.createPullRequest(repo, String(input.title ?? ''), '', headRef, baseRef);
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return null;
        }
        return obj('CreatePullRequestPayload', { repo, pr: created });
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = store.parseGlobalId(String(input.pullRequestId ?? ''));
        const repo = parsed?.kind === 'pr' ? store.repoByDatabaseId(parsed.repoDb) : undefined;
        const pr = repo?.pulls.get(parsed?.number ?? 0);
        if (!repo || !pr) {
          ctx.errors.push({ message: 'pull request not found' });
          return null;
        }
        const merged = store.squashMerge(repo, pr);
        if (!merged) {
          ctx.errors.push({ message: 'merge conflict' });
          return obj('MergePullRequestPayload', { repo, pr });
        }
        return obj('MergePullRequestPayload', { repo, pr });
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = store.parseGlobalId(String(input.subjectId ?? ''));
        const repo = parsed && (parsed.kind === 'issue' || parsed.kind === 'pr') ? store.repoByDatabaseId(parsed.repoDb) : undefined;
        const target = repo ? (parsed?.kind === 'issue' ? repo.issues.get(parsed.number) : repo.pulls.get(parsed.number)) : undefined;
        if (!repo || !target) {
          ctx.errors.push({ message: 'subject not found' });
          return null;
        }
        const comment = store.createComment(target, String(input.body ?? ''));
        return obj('AddCommentPayload', { repo, comment });
      }
      return 'unknown';
    }
    case 'Viewer':
    case 'User': {
      if (name === 'login') return scalar(VIEWER_LOGIN);
      if (name === 'id') return scalar(VIEWER_ID);
      if (name === 'name') return scalar(VIEWER_NAME);
      if (name === 'email') return scalar(VIEWER_EMAIL);
      if (name === 'avatarUrl') return scalar(`https://example.invalid/avatar/${VIEWER_LOGIN}`);
      if (name === 'url') return scalar(`https://example.invalid/${VIEWER_LOGIN}`);
      return 'unknown';
    }
    case 'Repository': {
      const repo = parent as Repo;
      if (name === 'id') return scalar(store.repoGlobalId(repo));
      if (name === 'databaseId') return scalar(repo.id);
      if (name === 'name') return scalar(repo.name);
      if (name === 'nameWithOwner') return scalar(`${repo.owner}/${repo.name}`);
      if (name === 'owner') return obj('User', null);
      if (name === 'description') return scalar(repo.description);
      if (name === 'isPrivate') return scalar(repo.private);
      if (name === 'url') return scalar(`http://${ctx.host}/${repo.owner}/${repo.name}`);
      if (name === 'createdAt' || name === 'updatedAt') return scalar(FIXED_ISO);
      if (name === 'defaultBranchRef') {
        const tip = ctx.store.branchTip(repo, repo.defaultBranch);
        return tip ? obj('Ref', { name: repo.defaultBranch }) : null;
      }
      if (name === 'viewerPermission') return scalar('ADMIN');
      if (name === 'hasIssuesEnabled') return scalar(true);
      if (name === 'issue') {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        return issue ? issueTyped(repo, issue) : null;
      }
      if (name === 'issues') return resolveIssuesConnection(repo, args);
      if (name === 'pullRequest') {
        const number = args.number as number | undefined;
        const pr = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        return pr ? prTyped(repo, pr) : null;
      }
      if (name === 'pullRequests') return resolvePullRequestsConnection(repo, args);
      return 'unknown';
    }
    case 'Issue': {
      const { repo, issue } = parent as { repo: Repo; issue: Issue };
      if (name === 'id') return scalar(store.issueGlobalId(repo, issue));
      if (name === 'number') return scalar(issue.number);
      if (name === 'title') return scalar(issue.title);
      if (name === 'state') return scalar(issue.state === 'open' ? 'OPEN' : 'CLOSED');
      if (name === 'body') return scalar(issue.body);
      if (name === 'createdAt' || name === 'updatedAt') return scalar(FIXED_ISO);
      if (name === 'url') return scalar(`http://${ctx.host}/${repo.owner}/${repo.name}/issues/${issue.number}`);
      if (name === 'author') return obj('User', null);
      if (name === 'repository') return repoTyped(repo);
      if (name === 'labels') return list('Label', issue.labels.map((labelName) => obj('Label', { name: labelName })));
      if (name === 'comments') {
        return obj('IssueCommentConnection', {
          nodes: issue.comments.map((comment) => obj('IssueComment', comment)),
        });
      }
      return 'unknown';
    }
    case 'PullRequest': {
      const { repo, pr } = parent as { repo: Repo; pr: PullRequest };
      if (name === 'id') return scalar(store.prGlobalId(repo, pr));
      if (name === 'number') return scalar(pr.number);
      if (name === 'title') return scalar(pr.title);
      if (name === 'state') return scalar(pr.state === 'open' ? 'OPEN' : 'CLOSED');
      if (name === 'body') return scalar(pr.body);
      if (name === 'merged') return scalar(pr.merged);
      if (name === 'mergeable') return scalar(store.prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING');
      if (name === 'headRefName') return scalar(pr.headRef);
      if (name === 'baseRefName') return scalar(pr.baseRef);
      if (name === 'createdAt' || name === 'updatedAt') return scalar(FIXED_ISO);
      if (name === 'url') return scalar(`http://${ctx.host}/${repo.owner}/${repo.name}/pull/${pr.number}`);
      if (name === 'author') return obj('User', null);
      if (name === 'repository') return repoTyped(repo);
      if (name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = store.prFiles(repo, pr).slice(0, first);
        return obj('PullRequestChangedFileConnection', { nodes: files.map((file) => obj('PullRequestChangedFile', file)) });
      }
      if (name === 'mergeCommit') {
        return pr.mergeCommitSha ? obj('Commit', { sha: pr.mergeCommitSha }) : null;
      }
      return 'unknown';
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const value = parent as { repo: Repo; nodes: Array<Issue | PullRequest>; hasNextPage: boolean; endCursor: string | null; totalCount: number };
      if (name === 'nodes') {
        const itemType = parentType === 'IssueConnection' ? 'Issue' : 'PullRequest';
        return list(
          itemType,
          value.nodes.map((item) => (itemType === 'Issue' ? issueTyped(value.repo, item as Issue) : prTyped(value.repo, item as PullRequest))),
        );
      }
      if (name === 'edges') {
        const itemType = parentType === 'IssueConnection' ? 'Issue' : 'PullRequest';
        return list(
          `${itemType}Edge`,
          value.nodes.map((item) =>
            obj(`${itemType}Edge`, {
              node: itemType === 'Issue' ? issueTyped(value.repo, item as Issue) : prTyped(value.repo, item as PullRequest),
              cursor: cursorFor((item as Issue).number),
            }),
          ),
        );
      }
      if (name === 'pageInfo') return obj('PageInfo', { hasNextPage: value.hasNextPage, endCursor: value.endCursor });
      if (name === 'totalCount') return scalar(value.totalCount);
      return 'unknown';
    }
    case 'IssueEdge':
    case 'PullRequestEdge': {
      const value = parent as { node: Typed; cursor: string };
      if (name === 'node') return value.node;
      if (name === 'cursor') return scalar(value.cursor);
      return 'unknown';
    }
    case 'PullRequestChangedFileConnection': {
      const value = parent as { nodes: Typed[] };
      if (name === 'nodes') return list('PullRequestChangedFile', value.nodes);
      if (name === 'totalCount') return scalar(value.nodes.length);
      return 'unknown';
    }
    case 'PullRequestChangedFile': {
      const file = parent as { filename: string };
      if (name === 'path') return scalar(file.filename);
      return 'unknown';
    }
    case 'IssueCommentConnection': {
      const value = parent as { nodes: Typed[] };
      if (name === 'nodes') return list('IssueComment', value.nodes);
      if (name === 'totalCount') return scalar(value.nodes.length);
      return 'unknown';
    }
    case 'PageInfo': {
      const value = parent as { hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return scalar(value.hasNextPage);
      if (name === 'hasPreviousPage') return scalar(false);
      if (name === 'endCursor') return scalar(value.endCursor);
      if (name === 'startCursor') return scalar(null);
      return 'unknown';
    }
    case 'Ref': {
      const value = parent as { name: string };
      if (name === 'name') return scalar(value.name);
      return 'unknown';
    }
    case 'Label': {
      const value = parent as { name: string };
      if (name === 'name') return scalar(value.name);
      return 'unknown';
    }
    case '__Type': {
      const value = parent as { name: string };
      const schema = SCHEMA_TYPES[value.name];
      if (!schema) return 'unknown';
      if (name === 'name') return scalar(value.name);
      if (name === 'kind') return scalar(schema.kind);
      if (name === 'fields') {
        return list('__Field', schema.fields.map((field) => obj('__Field', { name: field })));
      }
      if (name === 'enumValues') {
        return list('__EnumValue', (schema.enumValues ?? []).map((enumValue) => obj('__EnumValue', { name: enumValue })));
      }
      return 'unknown';
    }
    case '__Field': {
      const value = parent as { name: string };
      if (name === 'name') return scalar(value.name);
      return 'unknown';
    }
    case '__EnumValue': {
      const value = parent as { name: string };
      if (name === 'name') return scalar(value.name);
      return 'unknown';
    }
    case '__Schema': {
      if (name === 'queryType') return obj('__Type', { name: 'Query' });
      if (name === 'mutationType') return obj('__Type', { name: 'Mutation' });
      if (name === 'types') return list('__Type', Object.keys(SCHEMA_TYPES).map((typeName) => obj('__Type', { name: typeName })));
      return 'unknown';
    }
    case 'CreateIssuePayload': {
      const value = parent as { repo: Repo; issue: Issue };
      if (name === 'issue') return issueTyped(value.repo, value.issue);
      return 'unknown';
    }
    case 'CloseIssuePayload': {
      const value = parent as { repo: Repo; issue: Issue };
      if (name === 'issue') return issueTyped(value.repo, value.issue);
      return 'unknown';
    }
    case 'CreatePullRequestPayload': {
      const value = parent as { repo: Repo; pr: PullRequest };
      if (name === 'pullRequest') return prTyped(value.repo, value.pr);
      return 'unknown';
    }
    case 'MergePullRequestPayload': {
      const value = parent as { repo: Repo; pr: PullRequest };
      if (name === 'pullRequest') return prTyped(value.repo, value.pr);
      return 'unknown';
    }
    case 'AddCommentPayload': {
      const value = parent as { repo: Repo; comment: { id: number; body: string } };
      if (name === 'commentEdge') return obj('IssueCommentEdge', { node: obj('IssueComment', value.comment) });
      if (name === 'comment') return obj('IssueComment', value.comment);
      return 'unknown';
    }
    case 'IssueCommentEdge': {
      const value = parent as { node: Typed };
      if (name === 'node') return value.node;
      return 'unknown';
    }
    case 'IssueComment': {
      const value = parent as { id: number; body: string };
      if (name === 'id') return scalar(`C_${value.id}`);
      if (name === 'body') return scalar(value.body);
      if (name === 'createdAt' || name === 'updatedAt') return scalar(FIXED_ISO);
      return 'unknown';
    }
    case 'Commit': {
      const value = parent as { sha: string };
      if (name === 'oid') return scalar(value.sha);
      if (name === 'message') return scalar('');
      return 'unknown';
    }
    default:
      return 'unknown';
  }
}

function resolveSelection(typed: Typed, selections: Selection[], variables: Record<string, unknown>, ctx: ExecContext): unknown {
  if (typed.kind === 'scalar') return typed.value;
  if (typed.kind === 'list') {
    return typed.items.map((item) => resolveSelection(item, selections, variables, ctx));
  }
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== typed.type) continue;
      const nested = resolveSelection(typed, selection.children, variables, ctx) as Record<string, unknown>;
      Object.assign(result, nested);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typed.type) continue;
      const nested = resolveSelection(typed, fragment.fields, variables, ctx) as Record<string, unknown>;
      Object.assign(result, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      result[key] = typed.type;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, valueNode] of Object.entries(selection.args)) {
      args[argName] = resolveValue(valueNode, variables);
    }
    const resolved = resolveField(typed.type, typed.value, selection.name, args, ctx);
    if (resolved === 'unknown') {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typed.type}".` });
      result[key] = null;
      continue;
    }
    if (resolved === null) {
      result[key] = null;
      continue;
    }
    if (selection.children.length === 0) {
      result[key] = resolveSelection(resolved, [], variables, ctx);
    } else {
      result[key] = resolveSelection(resolved, selection.children, variables, ctx);
    }
  }
  return result;
}

function executeOperation(
  store: Store,
  operation: Operation,
  variables: Record<string, unknown>,
  host: string,
  fragments: Map<string, Fragment>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { store, host, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const mergedVariables: Record<string, unknown> = { ...operation.variables };
  for (const [key, valueNode] of Object.entries(operation.variables)) {
    mergedVariables[key] = resolveValue(valueNode, variables);
  }
  for (const [key, value] of Object.entries(variables)) {
    if (mergedVariables[key] === undefined) mergedVariables[key] = value;
  }
  const data = resolveSelection(obj(rootType, null), operation.fields, mergedVariables, ctx) as Record<string, unknown>;
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, body: unknown, bodyInvalid: boolean, host: string): GraphQLResult {
  if (bodyInvalid) return { status: 400, body: { errors: [{ message: 'Invalid JSON' }] } };
  const run = (request: unknown): unknown => {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return { errors: [{ message: 'GraphQL request must be an object with a query field' }] };
    }
    const input = request as Record<string, unknown>;
    const query = input.query;
    if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
    const variables = (input.variables ?? {}) as Record<string, unknown>;
    let document: Document;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
    }
    if (document.operations.length === 0) return { errors: [{ message: 'No operation found' }] };
    let operation = document.operations[0] as Operation;
    const operationName = input.operationName as string | undefined;
    if (operationName) {
      const named = document.operations.find((candidate) => candidate.name === operationName);
      if (named) operation = named;
    }
    return executeOperation(store, operation, variables, host, document.fragments);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((request) => run(request)) };
  }
  return { status: 200, body: run(body) };
}
