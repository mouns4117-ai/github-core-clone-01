// GraphQL v4: a small parser and executor for exactly the surface gh and
// github-mcp-server send — viewer, repository, node, issues, pull requests,
// the five mutations, and __type introspection. No library, no schema file.

import {
  globalId,
  parseGlobalId,
  viewerLogin,
  viewerUser,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():=[]!$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += input[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: GqlSelection[] | null;
}

export interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export interface GqlSpread {
  kind: 'spread';
  name: string;
}

export type GqlSelection = GqlField | GqlInlineFragment | GqlSpread;

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelections() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        // Variable definitions: ($x: Type = default, ...) — skipped, values come from `variables`.
        if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') this.skipParens();
        operations.push({ kind, name, selections: this.parseSelections() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeName = this.expectName();
        void typeName;
        fragments.set(name, this.parseSelections());
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelections(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): GqlSelection {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelections() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value as string };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelections() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
      args = this.parseArguments();
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    for (;;) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      for (;;) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return items;
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      for (;;) {
        const next = this.peek() as Token;
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return obj;
        }
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number(token.value);
    if (token.kind === 'float') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

/** Resolve $variables and enum wrappers in a parsed value. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
    const record = value as Record<string, unknown>;
    if (typeof record.__var === 'string') return variables[record.__var] ?? null;
    if (typeof record.__enum === 'string') return record.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveValue(entry, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- schema (for validation + introspection)

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name', 'email'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  BranchRef: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Label: ['name', 'color'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const FIELD_KIND: Record<string, 'OBJECT' | 'ENUM' | 'SCALAR'> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

// ---------------------------------------------------------------- values

type GqlValue =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'BranchRef'; name: string }
  | { __type: 'IssueConnection'; nodes: GqlValue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; nodes: GqlValue[] }
  | { __type: 'PullRequestChangedFileConnection'; nodes: GqlValue[] }
  | { __type: 'PullRequestChangedFile'; path: string }
  | { __type: 'IssueComment'; id: string; body: string }
  | { __type: 'IssueCommentEdge'; node: GqlValue }
  | { __type: 'Label'; name: string; color: string }
  | { __type: 'CreateIssuePayload'; issue: GqlValue | null }
  | { __type: 'CloseIssuePayload'; issue: GqlValue | null }
  | { __type: 'CreatePullRequestPayload'; pull: GqlValue | null }
  | { __type: 'MergePullRequestPayload'; pull: GqlValue | null }
  | { __type: 'AddCommentPayload'; edge: GqlValue | null }
  | { __type: 'Type'; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, GqlSelection[]>;
  errors: Array<{ message: string }>;
}

function issueCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('issue:')) return null;
    const n = Number(text.slice('issue:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
}

function resolveRepoById(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/', 2);
  if (!owner || !name) return null;
  return store.getRepo(owner, name) ?? null;
}

function resolveIssueById(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [ownerRepo, numberText] = parsed.key.split(':', 2);
  const [owner, name] = (ownerRepo ?? '').split('/', 2);
  const number = Number(numberText);
  if (!owner || !name || !Number.isInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  const issue = store.getIssue(repo, number);
  return issue ? { repo, issue } : null;
}

function resolvePullById(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [ownerRepo, numberText] = parsed.key.split(':', 2);
  const [owner, name] = (ownerRepo ?? '').split('/', 2);
  const number = Number(numberText);
  if (!owner || !name || !Number.isInteger(number)) return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  const pull = store.getPull(repo, number);
  return pull ? { repo, pull } : null;
}

// ---------------------------------------------------------------- execution

function typeNameOf(value: GqlValue | null): string | null {
  if (value === null) return null;
  return value.__type;
}

function validateSelections(
  exec: Executor,
  selections: GqlSelection[],
  typeName: string,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const fields = FIELDS[typeName];
      if (!fields || !fields.includes(selection.name)) {
        exec.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        continue;
      }
      // Recurse into sub-selections with the field's result type.
      const childType = fieldResultType(typeName, selection.name);
      if (childType && selection.selections) validateSelections(exec, selection.selections, childType);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        validateSelections(exec, selection.selections, typeName);
      } else {
        validateSelections(exec, selection.selections, selection.typeCondition);
      }
    } else if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment) validateSelections(exec, fragment, typeName);
    }
  }
}

/** The object type a field's sub-selections are validated against ('' = scalar). */
function fieldResultType(parent: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository' },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'BranchRef',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
    },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    PullRequest: { files: 'PullRequestChangedFileConnection' },
    Issue: { labels: 'Label', comments: 'IssueComment' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
  };
  return map[parent]?.[field] ?? null;
}

function executeSelections(
  exec: Executor,
  value: GqlValue | null,
  selections: GqlSelection[],
  out: Record<string, unknown>,
): void {
  const typeName = typeNameOf(value);
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment) executeSelections(exec, value, fragment, out);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        executeSelections(exec, value, selection.selections, out);
      }
      continue;
    }
    const field = selection as GqlField;
    const key = field.alias ?? field.name;
    out[key] = executeField(exec, value, field);
  }
}

function executeField(exec: Executor, value: GqlValue | null, field: GqlField): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(field.args)) args[key] = resolveValue(entry, exec.variables);
  if (field.name === '__typename') return typeNameOf(value);
  if (value === null) return null;

  switch (value.__type) {
    case 'User': {
      if (field.name === 'login') return value.login;
      if (field.name === 'id') return globalId('User', value.login);
      if (field.name === 'name') return viewerUser().name;
      if (field.name === 'email') return viewerUser().email;
      return null;
    }
    case 'Repository': {
      return executeRepositoryField(exec, value.repo, field, args);
    }
    case 'Issue': {
      const issue = value.issue;
      if (field.name === 'id') return issueGlobalId(value.repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'labels' && field.selections) {
        return issue.labels.map((label) => {
          const out: Record<string, unknown> = {};
          executeSelections(exec, { __type: 'Label', name: label.name, color: label.color }, field.selections as GqlSelection[], out);
          return out;
        });
      }
      return null;
    }
    case 'Label': {
      if (field.name === 'name') return value.name;
      if (field.name === 'color') return value.color;
      return null;
    }
    case 'PullRequest': {
      return executePullField(exec, value.repo, value.pull, field, args);
    }
    case 'BranchRef': {
      if (field.name === 'name') return value.name;
      return null;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return value.nodes.map((node) => {
          const out: Record<string, unknown> = {};
          if (field.selections) executeSelections(exec, node, field.selections, out);
          return out;
        });
      }
      if (field.name === 'pageInfo' && field.selections) {
        const out: Record<string, unknown> = {};
        executeSelections(exec, { __type: 'PageInfo', hasNextPage: value.pageInfo.hasNextPage, endCursor: value.pageInfo.endCursor }, field.selections, out);
        return out;
      }
      if (field.name === 'totalCount') return value.nodes.length;
      return null;
    }
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') {
        return value.nodes.map((node) => {
          const out: Record<string, unknown> = {};
          if (field.selections) executeSelections(exec, node, field.selections, out);
          return out;
        });
      }
      if (field.name === 'pageInfo' && field.selections) {
        const out: Record<string, unknown> = {};
        executeSelections(exec, { __type: 'PageInfo', hasNextPage: false, endCursor: null }, field.selections, out);
        return out;
      }
      if (field.name === 'totalCount') return value.nodes.length;
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return value.path;
      if (field.name === 'filename') return value.path;
      if (field.name === 'additions') return 1;
      if (field.name === 'deletions') return 0;
      if (field.name === 'changes') return 1;
      if (field.name === 'status') return 'modified';
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return value.id;
      if (field.name === 'body') return value.body;
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node' && field.selections) {
        const out: Record<string, unknown> = {};
        executeSelections(exec, value.node, field.selections, out);
        return out;
      }
      if (field.name === 'cursor') return issueCursor(0);
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue' && field.selections) {
        if (!value.issue) return null;
        const out: Record<string, unknown> = {};
        executeSelections(exec, value.issue, field.selections, out);
        return out;
      }
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest' && field.selections) {
        if (!value.pull) return null;
        const out: Record<string, unknown> = {};
        executeSelections(exec, value.pull, field.selections, out);
        return out;
      }
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge' && field.selections) {
        if (!value.edge) return null;
        const out: Record<string, unknown> = {};
        executeSelections(exec, value.edge, field.selections, out);
        return out;
      }
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return value.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      if (field.name === 'endCursor') return value.endCursor;
      return null;
    }
    case 'Type': {
      return executeTypeField(exec, value.name, field);
    }
    default:
      return null;
  }
}

function executeRepositoryField(exec: Executor, repo: Repo, field: GqlField, args: Record<string, unknown>): unknown {
  if (field.name === 'id') return repoGlobalId(repo);
  if (field.name === 'databaseId') return repo.id;
  if (field.name === 'name') return repo.name;
  if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
  if (field.name === 'owner') {
    const out: Record<string, unknown> = {};
    if (field.selections) executeSelections(exec, { __type: 'User', login: repo.owner }, field.selections, out);
    return out;
  }
  if (field.name === 'defaultBranchRef') {
    const out: Record<string, unknown> = {};
    if (field.selections) executeSelections(exec, { __type: 'BranchRef', name: repo.defaultBranch }, field.selections, out);
    return out;
  }
  if (field.name === 'viewerPermission') return 'ADMIN';
  if (field.name === 'hasIssuesEnabled') return true;
  if (field.name === 'issue') {
    const number = Number(args.number);
    const issue = Number.isInteger(number) ? exec.store.getIssue(repo, number) : undefined;
    if (!issue) return null;
    const value: GqlValue = { __type: 'Issue', repo, issue };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'issues') {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const orderField = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
    const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
    const after = typeof args.after === 'string' ? args.after : null;
    let issues = [...repo.issues];
    if (states) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    issues.sort((a, b) => {
      const cmp = orderField === 'CREATED_AT' ? a.seq - b.seq : a.seq - b.seq;
      return direction === 'ASC' ? cmp : -cmp;
    });
    const afterNumber = cursorNumber(after);
    if (afterNumber !== null) {
      issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > afterNumber : issue.number < afterNumber));
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]?.number ?? 0) : null;
    const value: GqlValue = {
      __type: 'IssueConnection',
      nodes: page.map((issue) => ({ __type: 'Issue', repo, issue }) as GqlValue),
      pageInfo: { hasNextPage, endCursor },
    };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'pullRequests') {
    const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
    const nodes = repo.pulls.slice(0, first).map((pull) => ({ __type: 'PullRequest', repo, pull }) as GqlValue);
    const value: GqlValue = { __type: 'PullRequestConnection', nodes };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'pullRequest') {
    const number = Number(args.number);
    const pull = Number.isInteger(number) ? exec.store.getPull(repo, number) : undefined;
    if (!pull) return null;
    const value: GqlValue = { __type: 'PullRequest', repo, pull };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  return null;
}

function executePullField(exec: Executor, repo: Repo, pull: Pull, field: GqlField, args: Record<string, unknown>): unknown {
  if (field.name === 'id') return pullGlobalId(repo, pull);
  if (field.name === 'number') return pull.number;
  if (field.name === 'title') return pull.title;
  if (field.name === 'body') return pull.body;
  if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  if (field.name === 'merged') return pull.merged;
  if (field.name === 'headRefName') return pull.headRef;
  if (field.name === 'baseRefName') return pull.baseRef;
  if (field.name === 'mergeable') return exec.store.pullMergeable(repo, pull);
  if (field.name === 'createdAt') return pull.createdAt;
  if (field.name === 'updatedAt') return pull.updatedAt;
  if (field.name === 'files') {
    const base = exec.store.mergeBase(repo, pull.headSha, pull.baseSha);
    const diff = base === null ? [] : exec.store.diffCommits(repo, base, pull.headSha);
    const first = typeof args.first === 'number' ? args.first : diff.length;
    const nodes = diff.slice(0, first).map((entry) => ({ __type: 'PullRequestChangedFile', path: entry.path }) as GqlValue);
    const value: GqlValue = { __type: 'PullRequestChangedFileConnection', nodes };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  return null;
}

function executeTypeField(exec: Executor, typeName: string, field: GqlField): unknown {
  if (field.name === 'name') return typeName;
  if (field.name === 'kind') return FIELD_KIND[typeName] ?? 'OBJECT';
  if (field.name === 'description') return null;
  if (field.name === 'fields') {
    const names = FIELDS[typeName] ?? [];
    const includeDeprecated = field.args.includeDeprecated === true;
    void includeDeprecated;
    return names.map((name) => ({ name }));
  }
  if (field.name === 'enumValues') {
    const values = ENUM_VALUES[typeName] ?? [];
    return values.map((name) => ({ name }));
  }
  return null;
}

// ---------------------------------------------------------------- root fields

function executeQueryRoot(exec: Executor, field: GqlField): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(field.args)) args[key] = resolveValue(entry, exec.variables);
  if (field.name === 'viewer') {
    const value: GqlValue = { __type: 'User', login: viewerLogin() };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'repository') {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.name === 'string' ? args.name : '';
    if (owner !== viewerLogin()) return null;
    const repo = exec.store.getRepo(owner, name);
    if (!repo) return null;
    const value: GqlValue = { __type: 'Repository', repo };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    if (parsed.kind === 'Repository') {
      const repo = resolveRepoById(exec.store, id);
      if (!repo) return null;
      const value: GqlValue = { __type: 'Repository', repo };
      if (!field.selections) return {};
      const out: Record<string, unknown> = {};
      executeSelections(exec, value, field.selections, out);
      return out;
    }
    if (parsed.kind === 'Issue') {
      const found = resolveIssueById(exec.store, id);
      if (!found) return null;
      const value: GqlValue = { __type: 'Issue', repo: found.repo, issue: found.issue };
      if (!field.selections) return {};
      const out: Record<string, unknown> = {};
      executeSelections(exec, value, field.selections, out);
      return out;
    }
    if (parsed.kind === 'PullRequest') {
      const found = resolvePullById(exec.store, id);
      if (!found) return null;
      const value: GqlValue = { __type: 'PullRequest', repo: found.repo, pull: found.pull };
      if (!field.selections) return {};
      const out: Record<string, unknown> = {};
      executeSelections(exec, value, field.selections, out);
      return out;
    }
    return null;
  }
  if (field.name === '__type') {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!FIELDS[name] && !ENUM_VALUES[name]) return null;
    const value: GqlValue = { __type: 'Type', name };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    // __type fields carry their own sub-selections (fields { name }, enumValues { name }).
    for (const selection of field.selections) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'fields') {
        const names = FIELDS[name] ?? [];
        out[key] = names.map((fieldName) => {
          const entry: Record<string, unknown> = {};
          if (selection.selections) {
            for (const sub of selection.selections) {
              if (sub.kind === 'field') entry[sub.alias ?? sub.name] = sub.name === 'name' ? fieldName : null;
            }
          }
          return entry;
        });
      } else if (selection.name === 'enumValues') {
        const values = ENUM_VALUES[name] ?? [];
        out[key] = values.map((valueName) => {
          const entry: Record<string, unknown> = {};
          if (selection.selections) {
            for (const sub of selection.selections) {
              if (sub.kind === 'field') entry[sub.alias ?? sub.name] = sub.name === 'name' ? valueName : null;
            }
          }
          return entry;
        });
      } else {
        out[key] = executeTypeField(exec, name, selection);
      }
    }
    return out;
  }
  return null;
}

function executeMutationRoot(exec: Executor, field: GqlField): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(field.args)) args[key] = resolveValue(entry, exec.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (field.name === 'createIssue') {
    const repo = resolveRepoById(exec.store, input.repositoryId);
    if (!repo) {
      exec.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = exec.store.createIssue(repo, title, body, []);
    const value: GqlValue = { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue } };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'closeIssue') {
    const found = resolveIssueById(exec.store, input.issueId);
    if (!found) {
      exec.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = exec.store.nowIso();
    const value: GqlValue = { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo: found.repo, issue: found.issue } };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'createPullRequest') {
    const repo = resolveRepoById(exec.store, input.repositoryId);
    if (!repo) {
      exec.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const title = typeof input.title === 'string' ? input.title : '';
    if (!repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) {
      exec.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    let pull = repo.pulls.find((candidate) => candidate.state === 'open' && candidate.headRef === headRef && candidate.baseRef === baseRef);
    if (!pull) {
      pull = exec.store.createPull(repo, title, '', headRef, baseRef) ?? undefined;
    }
    if (!pull) {
      exec.errors.push({ message: 'Could not create the pull request.' });
      return null;
    }
    const value: GqlValue = { __type: 'CreatePullRequestPayload', pull: { __type: 'PullRequest', repo, pull } };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'mergePullRequest') {
    const found = resolvePullById(exec.store, input.pullRequestId);
    if (!found) {
      exec.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return null;
    }
    const { repo, pull } = found;
    if (pull.state !== 'open') {
      exec.errors.push({ message: 'The pull request is already closed.' });
      return null;
    }
    if (exec.store.mergeConflicts(repo, pull).length > 0) {
      exec.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    exec.store.mergePull(repo, pull);
    const value: GqlValue = { __type: 'MergePullRequestPayload', pull: { __type: 'PullRequest', repo, pull } };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  if (field.name === 'addComment') {
    const found = resolveIssueById(exec.store, input.subjectId);
    if (!found) {
      exec.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = exec.store.addComment(found.repo, found.issue, body);
    const node: GqlValue = {
      __type: 'IssueComment',
      id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}:${found.issue.number}:${comment.id}`),
      body: comment.body,
    };
    const value: GqlValue = { __type: 'AddCommentPayload', edge: { __type: 'IssueCommentEdge', node } };
    if (!field.selections) return {};
    const out: Record<string, unknown> = {};
    executeSelections(exec, value, field.selections, out);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------- entrypoint

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Run one operation document. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors: Array<{ message: string }> } {
  let document: GqlDocument;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  let operation = document.operations[0] ?? null;
  if (operationName) {
    operation = document.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  if (!operation) return { data: null, errors: [{ message: 'No operation in the GraphQL document.' }] };
  const exec: Executor = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(exec, operation.selections, rootType);
  if (exec.errors.length > 0) return { data: null, errors: exec.errors };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    data[key] = operation.kind === 'mutation' ? executeMutationRoot(exec, selection) : executeQueryRoot(exec, selection);
  }
  return { data, errors: exec.errors };
}

/** Handle one POST /api/graphql body (one operation or a JSON array batch). */
export function handleGraphQL(store: Store, body: unknown): GraphQLReply {
  const runOne = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'The GraphQL body must be an object with query and variables.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    if (query === '') return { data: null, errors: [{ message: 'No query in the GraphQL body.' }] };
    return executeGraphQL(store, query, variables, operationName);
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(runOne) };
  return { status: 200, body: runOne(body) };
}
