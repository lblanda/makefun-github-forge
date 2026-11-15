# makefun-github-forge

A GitHub-compatible git forge in a single Node process, built for the make.fun
bounty **github-core-clone-01**. One process, its own in-memory store, no UI,
no outside service, no proxy. Node 22+, standard library only — no install step.

## Run

```sh
node main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done`
until the trial ends and exits 0. The forge itself is `src/app.ts`.

For local development without the harness:

```sh
MAKEFUN_SHOP_TOKEN=makefun-local-token-2026 node -e "
  import('./src/app.ts').then(({ createApp }) => {
    createApp().listen(18080, () => console.log('listening on 18080'));
  });
"
```

## Surfaces

| Surface | Route | Notes |
| --- | --- | --- |
| Health | `GET /healthz` | No auth, `{"ok": true}` |
| Git smart HTTP | `/{owner}/{repo}.git` | `info/refs` (v0 + protocol v2), `git-upload-pack` (ls-refs, fetch, shallow/deepen, incremental), `git-receive-pack` (fast-forward checks, mixed ok/ng) |
| REST v3 | `/api/v3` | Repos, refs, branches, commits, contents, labels, issues, comments, pull requests, squash merge |
| GraphQL v4 | `POST /api/graphql` | viewer, repository, issues, pull requests, mutations, node, `__type`; batching supported |
| MCP | `POST /mcp` | Streamable HTTP, `server/discover` (2026-07-28) + legacy `initialize`, six tools |

Authentication is a Bearer token from `MAKEFUN_SHOP_TOKEN`. The token owner is
`adaiversen` (id 1000); repositories under any other owner are 404, never 403.
`/healthz` takes no auth.

## Layout

- `main.ts` — harness lifecycle (bind, register, wait for done, exit).
- `src/app.ts` — HTTP router, auth, body handling.
- `src/store.ts` — in-memory data model: repos, refs, objects, issues, PRs, labels, three-way merge, squash merge.
- `src/gitobj.ts` — git objects (SHA-1), trees, commits, tags, packfiles (plain objects out, deltas read).
- `src/pktline.ts` — pkt-line framing.
- `src/githttp.ts` — git smart HTTP.
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL parser + executor.
- `src/mcp.ts` — MCP server.

## Determinism

Fixed timestamps everywhere (`2025-01-01T00:00:00Z`, commit epochs from
1735689600), no `Date.now()`, no `Math.random()`. Object ids are content hashes,
so a clone round-trips byte-exactly.

## License

MIT — see [LICENSE](LICENSE).
