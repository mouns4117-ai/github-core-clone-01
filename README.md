[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mouns4117-ai/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mouns4117-ai/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a standalone Git-compatible forge

One process, no dependencies, no database, no outside service: a GitHub-compatible
forge that speaks the same protocols real GitHub clients speak. It serves, from a
single in-memory store:

- **Git over smart HTTP** — clone, fetch and push with protocol v0 and v2
  (advertise, ls-refs, shallow fetch and deepen, annotated tags, fast-forward
  enforcement, mixed push reports, sideband framing, pack v2 with delta support).
- **REST v3 API** (`/api/v3`) — repositories, branches, commits, contents, labels,
  issues, comments and pull requests, including squash merge with conflict
  detection.
- **GraphQL** (`/api/graphql`) — viewer, repository, issues, pull requests,
  `node` global ids, introspection, the five core mutations, and batched queries.
- **MCP** (`/mcp`) — JSON-RPC 2.0 tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `get_issue`, `create_pull_request`, `list_pull_requests`,
  `merge_pull_request`) with `server/discover` and legacy `initialize` support.

Everything is plain TypeScript on the Node standard library only. There is no
install step and no `node_modules`: the trial harness runs `node
--experimental-strip-types main.ts` and the entry registers itself with the
environment.

## How to run it

```sh
# Node 22+ is required (developed and graded on Node v24.22.1).
# The trial harness sets MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN for you.
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

For local development there is a `dev.ts` runner that binds a fixed port:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types dev.ts 8123
# health check
curl http://127.0.0.1:8123/healthz
# {"ok":true}
```

Every request except `GET /healthz` needs `Authorization: Bearer <token>`. When
`MAKEFUN_SHOP_TOKEN` is set, the token must match it exactly; when it is unset,
any non-empty Bearer token is accepted.

## Trying it out

```sh
export TOKEN=test-token-123
export BASE=http://127.0.0.1:8123

# create a repo
curl -s -X POST $BASE/api/v3/user/repos -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello","description":"my first repo","private":false}'

# clone it (empty at first), add a file, push it back
git clone $BASE/adaiversen/hello.git
cd hello
echo "hello, forge" > README.md
git add README.md && git commit -m "first commit"
git push origin main
git clone $BASE/adaiversen/hello.git hello-again   # the file is there

# issues over REST
curl -s -X POST $BASE/api/v3/repos/adaiversen/hello/issues \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"first issue","body":"it works"}'

# the same repo over GraphQL
curl -s -X POST $BASE/api/graphql -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ viewer { login } repository(owner: \"adaiversen\", name: \"hello\") { nameWithOwner defaultBranchRef { name } } }"}'

# the same repo over MCP
curl -s -X POST $BASE/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_repo","arguments":{"owner":"adaiversen","repo":"hello"}}}'
```

The viewer identity is deterministic: the token names a scenario user
(`adaiversen` by default) and repos created through `POST /user/repos` belong
to that login.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Trial entrypoint: binds an ephemeral port, registers with the env, exits when done. |
| `app.ts` | HTTP server, routing, auth, request-id and error handling. |
| `dev.ts` | Local runner on a fixed port (development only). |
| `scenario.ts` | Deterministic seeded scenario (users, repos, files, commits, issues, pulls). |
| `git.ts` | Git object model: SHA-1, commit/tree/tag codecs, pkt-lines, pack read/write. |
| `git-http.ts` | Smart HTTP: v0/v2 advertisement, ls-refs, fetch planning, receive-pack. |
| `store.ts` | In-memory store: repos, refs, objects, issues, pulls, merges, diffs. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser, schema validation, resolvers and mutations. |
| `mcp.ts` | MCP JSON-RPC server and tool implementations. |

## Grading (local)

Against a fresh server, the kit's local grader reports:

- **120/120 conformance checks** (git 30, repos 15, issues 15, pulls 20,
  GraphQL 20, MCP 15, protocol 5) — feature 600, agent 200.
- **Perf 189/200** — push p50 538 ms, clone p50 68 ms, read p50 668 ms,
  write p50 121 ms.
- **Total: 989/1000.**

## License

MIT — see [LICENSE](LICENSE).
